/**
 * SessionService: records TabStripModel mutations as a command log and reads
 * the previous session back. Ported from
 * chromium-reference/chrome/browser/sessions/session_service_base.cc and
 * session_service.cc.
 *
 * In Chrome the service learns about tab changes through Browser /
 * SessionTabHelper plumbing; here it is a TabStripModelObserver. Navigation
 * events have no model-level source (tabs carry opaque `data`), so — exactly
 * like SessionTabHelper driving SessionService — the embedding app reports
 * them through navigateTab / updateTabNavigation / setSelectedNavigationIndex.
 *
 * Tab `data` is persisted automatically (kCommandSetTabData analog) on
 * insert and on every data change, so apps that keep their url in `data`
 * restore correctly with zero extra wiring.
 *
 * Deviation from Chrome: on inserts, moves, and removals we re-emit
 * SetTabIndexInWindow for every tab whose index shifted, so the persisted
 * visual order is always exact. Chrome tolerates stale indices and relies on
 * periodic full rewrites; the in-buffer command swaps below keep our
 * approach cheap.
 */

import type { TabStripModelObserver, TabStripModelChange, TabStripSelectionChange } from '../core/observer'
import type { TabStripModel } from '../core/tab-strip-model'
import { NO_TAB, type Tab, type TabId } from '../core/types'
import type { CommandStorageBackend } from './command-storage-backend'
import { CommandStorageManager } from './command-storage-manager'
import {
  createDefaultProcessSingleton,
  type ProcessSingleton,
  type ProcessSingletonResult,
} from './process-singleton'
import { restoreSessionWindow, type RestoreOptions, type RestoreResult } from './session-restore'
import {
  SessionCommandId,
  createAddTabExtraDataCommand,
  createAddWindowExtraDataCommand,
  createLastActiveTimeCommand,
  createPinnedStateCommand,
  createSetActiveWindowCommand,
  createSetSelectedNavigationIndexCommand,
  createSetSelectedTabInWindowCommand,
  createSetTabDataCommand,
  createSetTabIndexInWindowCommand,
  createSetTabWindowCommand,
  createTabClosedCommand,
  createTabGroupCommand,
  createTabGroupMetadataUpdateCommand,
  createTabNavigationPathPrunedCommand,
  createUpdateTabNavigationCommand,
  createWindowClosedCommand,
  findClosestNavigationWithIndex,
  isClosingCommand,
  processTabNavigationPathPruned,
  restoreSessionFromCommands,
  type SessionCommand,
} from './session-service-commands'
import {
  DEFAULT_WINDOW_ID,
  type SerializedNavigationEntry,
  type SessionSnapshot,
  type SessionWindowId,
} from './session-types'

/** Commands between full log rewrites. Mirrors kWritesPerReset (session_service_base.cc:78). */
export const WRITES_PER_RESET = 250

/** Navigation entries persisted either side of the current one. Mirrors gMaxPersistNavigationCount. */
export const MAX_PERSISTED_NAVIGATIONS = 6

export interface SessionServiceOptions<T> {
  storage: CommandStorageBackend
  /**
   * Converts tab data to a JSON-serializable value. Defaults to identity —
   * fine when T is already plain JSON (e.g. `{ url: string }`).
   */
  serializeTabData?: (data: T, tab: Tab<T>) => unknown
  /** Inverse of serializeTabData, used by restoreInto. Defaults to identity. */
  deserializeTabData?: (raw: unknown) => T
  /** Delay before buffered commands hit storage. Default SAVE_DELAY_MS (2500). */
  saveDelayMs?: number
  /** Commands between full rewrites. Default WRITES_PER_RESET (250). */
  writesPerReset?: number
  /** Navigation entries kept either side of current. Default 6. */
  maxPersistedNavigations?: number
  /**
   * Flush synchronously on window `pagehide` (web teardown gives timers no
   * chance to fire). Default true when a window exists. Only effective with
   * a synchronous backend such as WebStorageBackend.
   */
  flushOnPageHide?: boolean
  /** Observer-side failures are reported here instead of thrown. */
  onError?: (error: unknown) => void
  /**
   * Cross-realm coordination for the storage area — the ProcessSingleton
   * port (process_singleton.h). Exactly one realm (browser tab) owns a
   * profile; the rest become secondaries that neither rotate, write, nor
   * restore it. Omit for the default: Web Locks keyed by
   * storage.profileLockName when the platform has them, else sole ownership.
   * Pass null to force sole ownership, or your own implementation for
   * tests/custom environments.
   */
  processSingleton?: ProcessSingleton | null
}

export interface AttachOptions {
  /** Identifies this model in the log. Default DEFAULT_WINDOW_ID. */
  windowId?: SessionWindowId
}

export interface RestoreIntoOptions<T> extends RestoreOptions<T> {
  /** Restore (and attach as) this window. Defaults to the first saved window. */
  windowId?: SessionWindowId
}

export interface RestoreIntoResult extends RestoreResult {
  /** False when there was no saved window to restore (e.g. first run). */
  restored: boolean
  /** The full snapshot, for callers that also restore other windows. */
  snapshot: SessionSnapshot
  /**
   * 'owner' when this realm persists the session; 'secondary' when another
   * realm already owns the storage area — this service then restored nothing
   * and will record nothing.
   */
  ownership: ProcessSingletonResult
}

interface WindowEntry<T> {
  model: TabStripModel<T>
  unsubscribe: () => void
  /** Dedupe cache for SetSelectedTabInWindow (session_service.cc keeps the same). */
  lastSelectedIndex: number
}

interface TrackedNavigationState {
  /** Sorted ascending by entry index. */
  navigations: SerializedNavigationEntry[]
  /** Selected navigation *index value* (not array position). */
  currentNavigationIndex: number
}

export class SessionService<T = unknown> {
  private readonly storage_: CommandStorageBackend
  private readonly manager_: CommandStorageManager
  private readonly serializeTabData_: (data: T, tab: Tab<T>) => unknown
  private readonly deserializeTabData_: (raw: unknown) => T
  private readonly writesPerReset_: number
  private readonly maxPersistedNavigations_: number
  private readonly onError_: (error: unknown) => void
  /**
   * Resolves once the profile claim is settled and, for the owner, the
   * previous session has been rotated to the last slot.
   */
  private readonly ready_: Promise<void>

  private readonly windows_ = new Map<SessionWindowId, WindowEntry<T>>()
  private readonly navState_ = new Map<TabId, TrackedNavigationState>()
  private readonly tabExtraData_ = new Map<TabId, Map<string, string>>()
  private readonly windowExtraData_ = new Map<SessionWindowId, Map<string, string>>()
  private activeWindowId_: SessionWindowId | null = null
  /** Mirrors rebuild_on_next_save_ (session_service_base.cc). */
  private rebuildOnNextSave_ = false
  private pageHideListener_: (() => void) | null = null
  private disposed_ = false
  private readonly singleton_: ProcessSingleton | null
  private ownership_: 'pending' | ProcessSingletonResult = 'pending'
  /** Mirrors is_saving_enabled_ (session_service_base.h:337). */
  private savingEnabled_ = false

  constructor(options: SessionServiceOptions<T>) {
    this.storage_ = options.storage
    this.serializeTabData_ = options.serializeTabData ?? ((data) => data)
    this.deserializeTabData_ = options.deserializeTabData ?? ((raw) => raw as T)
    this.writesPerReset_ = options.writesPerReset ?? WRITES_PER_RESET
    this.maxPersistedNavigations_ = options.maxPersistedNavigations ?? MAX_PERSISTED_NAVIGATIONS
    this.onError_ = options.onError ?? ((error) => console.error('chromium-tabs session:', error))

    // Claim the profile before touching storage — the ProcessSingleton port
    // (process_singleton.h:45). Exactly one realm may rotate and write a
    // given storage area; everyone else becomes a read-nothing,
    // write-nothing secondary, the way a second Chrome launch stands down
    // when the profile is already owned.
    this.singleton_ =
      options.processSingleton !== undefined
        ? options.processSingleton
        : createDefaultProcessSingleton(this.storage_.profileLockName)

    let gate: Promise<void> | null = null
    if (this.singleton_ === null) {
      // Sole instance (no lock manager on this platform, in-memory backend,
      // or explicit opt-out): rotate synchronously, exactly the pre-singleton
      // behavior. Keeps the synchronous fast path (pagehide flush) intact.
      this.ownership_ = 'owner'
      gate = this.rotateNow_()
      this.ready_ = gate ?? Promise.resolve()
    } else {
      gate = this.singleton_.acquire().then(async (result) => {
        this.ownership_ = result
        if (result === 'owner' && !this.disposed_) {
          const rotation = this.rotateNow_()
          if (rotation) await rotation
          // SetSavingEnabled(true) — schedules the full snapshot of any
          // models attached while the claim was pending.
          this.setSavingEnabled_(true)
        }
      })
      this.ready_ = gate
    }

    this.manager_ = new CommandStorageManager({
      backend: this.storage_,
      saveDelayMs: options.saveDelayMs,
      ...(gate ? { ready: gate } : {}),
      delegate: {
        // RebuildCommandsIfRequired (session_service_base.cc:856).
        onWillSaveCommands: () => {
          if (this.rebuildOnNextSave_) this.scheduleResetCommands()
        },
        onErrorWritingSessionCommands: () => {
          this.rebuildOnNextSave_ = true
          this.manager_.startSaveTimer()
        },
      },
    })

    if (this.singleton_ === null) this.setSavingEnabled_(true)

    const flushOnPageHide = options.flushOnPageHide ?? true
    if (flushOnPageHide && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.pageHideListener_ = () => {
        void this.saveNow()
      }
      window.addEventListener('pagehide', this.pageHideListener_)
    }
  }

  /**
   * Which side of the profile claim this service landed on: 'pending' until
   * resolved, then 'owner' (this realm persists the session) or 'secondary'
   * (another realm owns the storage area; this service records and restores
   * nothing). Settled by the time getLastSession/restoreInto resolve.
   */
  get ownership(): 'pending' | ProcessSingletonResult {
    return this.ownership_
  }

  /** Starts rotation; returns the pending promise when async, else null. */
  private rotateNow_(): Promise<void> | null {
    let rotation: void | Promise<void>
    try {
      rotation = this.storage_.moveCurrentSessionToLastSession()
    } catch (error) {
      this.onError_(error)
      rotation = undefined
    }
    if (rotation && typeof rotation.then === 'function') {
      return rotation.then(
        () => undefined,
        (error) => {
          this.onError_(error)
        },
      )
    }
    return null
  }

  /** Port of SetSavingEnabled (session_service_base.cc:877). */
  private setSavingEnabled_(enabled: boolean): void {
    if (this.savingEnabled_ === enabled) return
    this.savingEnabled_ = enabled
    if (!this.savingEnabled_) {
      this.manager_.clearPendingCommands()
    } else {
      this.scheduleResetCommands()
    }
  }

  // Attach / detach ////////////////////////////////////////////////////////

  /**
   * Starts recording a model under the given window id and schedules a full
   * snapshot of its current state (the SetSavingEnabled(true) startup path,
   * session_service_base.cc:412). Returns a detach function.
   */
  attach(model: TabStripModel<T>, options: AttachOptions = {}): () => void {
    this.checkNotDisposed_()
    const windowId = options.windowId ?? DEFAULT_WINDOW_ID
    if (this.windows_.has(windowId)) {
      throw new Error(`session: window "${windowId}" is already attached`)
    }
    for (const entry of this.windows_.values()) {
      if (entry.model === model) throw new Error('session: model is already attached')
    }

    const entry: WindowEntry<T> = { model, unsubscribe: () => {}, lastSelectedIndex: NO_TAB }
    entry.unsubscribe = model.addObserver(this.createObserver_(windowId, entry))
    this.windows_.set(windowId, entry)
    if (this.activeWindowId_ === null) this.activeWindowId_ = windowId
    this.scheduleResetCommands()
    return () => this.detach(windowId)
  }

  /**
   * Stops recording a window. The window's commands stay in the log until
   * the next full rewrite; use markWindowClosed first to drop it eagerly.
   */
  detach(windowId: SessionWindowId): void {
    const entry = this.windows_.get(windowId)
    if (!entry) return
    entry.unsubscribe()
    this.windows_.delete(windowId)
    for (const tab of entry.model.getTabs()) {
      this.navState_.delete(tab.id)
      this.tabExtraData_.delete(tab.id)
    }
    this.windowExtraData_.delete(windowId)
    if (this.activeWindowId_ === windowId) this.activeWindowId_ = null
  }

  /**
   * Records the window as closed and detaches it. Tab closes are committed
   * alongside kCommandWindowClosed, mirroring CommitPendingCloses
   * (session_service.cc) — otherwise the tabs' surviving commands would
   * resurrect the window husk during rebuild.
   */
  markWindowClosed(windowId: SessionWindowId): void {
    const entry = this.windows_.get(windowId)
    if (!entry) return
    const tabs = entry.model.getTabs()
    this.detach(windowId)
    for (const tab of tabs) this.scheduleCommand_(createTabClosedCommand(tab.id))
    this.scheduleCommand_(createWindowClosedCommand(windowId))
  }

  /** Records which window is active (kCommandSetActiveWindow). */
  setActiveWindow(windowId: SessionWindowId): void {
    if (!this.windows_.has(windowId)) return
    this.activeWindowId_ = windowId
    this.scheduleCommand_(createSetActiveWindowCommand(windowId))
  }

  // Navigation tracking (the SessionTabHelper surface) /////////////////////

  /**
   * Records that a tab committed a new navigation: forward history is pruned
   * and the new entry becomes current — normal browser semantics. Untracked
   * tab ids are ignored, like commands for untracked windows in Chrome.
   */
  navigateTab(tabId: TabId, entry: { url: string; title?: string; state?: unknown; timestamp?: number }): void {
    if (!this.findTab_(tabId)) return
    let nav = this.navState_.get(tabId)
    if (!nav) {
      nav = { navigations: [], currentNavigationIndex: -1 }
      this.navState_.set(tabId, nav)
    }

    const newIndex = nav.currentNavigationIndex + 1
    const last = nav.navigations[nav.navigations.length - 1]
    if (last && last.index >= newIndex) {
      const count = last.index - newIndex + 1
      processTabNavigationPathPruned(nav, newIndex, count)
      this.scheduleCommand_(createTabNavigationPathPrunedCommand(tabId, newIndex, count))
    }

    const navigation: SerializedNavigationEntry = {
      index: newIndex,
      url: entry.url,
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      ...(entry.state !== undefined ? { state: entry.state } : {}),
      timestamp: entry.timestamp ?? Date.now(),
    }
    this.insertNavigation_(nav, navigation)
    nav.currentNavigationIndex = newIndex
    this.scheduleCommand_(createUpdateTabNavigationCommand(tabId, navigation))
    this.scheduleCommand_(createSetSelectedNavigationIndexCommand(tabId, newIndex))
  }

  /**
   * Replaces-or-inserts one navigation entry by its index — e.g. the current
   * page's title or scroll state changed in place. Mirrors
   * UpdateTabNavigation (session_service.cc).
   */
  updateTabNavigation(tabId: TabId, navigation: SerializedNavigationEntry): void {
    if (!this.findTab_(tabId)) return
    let nav = this.navState_.get(tabId)
    if (!nav) {
      nav = { navigations: [], currentNavigationIndex: -1 }
      this.navState_.set(tabId, nav)
    }
    this.insertNavigation_(nav, { ...navigation })
    this.scheduleCommand_(createUpdateTabNavigationCommand(tabId, { ...navigation }))
  }

  /** Records back/forward movement. Mirrors SetSelectedNavigationIndex. */
  setSelectedNavigationIndex(tabId: TabId, index: number): void {
    if (!this.findTab_(tabId)) return
    const nav = this.navState_.get(tabId)
    if (!nav || !nav.navigations.some((n) => n.index === index)) return
    nav.currentNavigationIndex = index
    this.scheduleCommand_(createSetSelectedNavigationIndexCommand(tabId, index))
  }

  /** Removes `count` entries from index value `index`. Mirrors TabNavigationPathPruned. */
  pruneTabNavigations(tabId: TabId, index: number, count: number): void {
    if (!this.findTab_(tabId)) return
    const nav = this.navState_.get(tabId)
    if (!nav || index < 0 || count < 1) return
    processTabNavigationPathPruned(nav, index, count)
    this.scheduleCommand_(createTabNavigationPathPrunedCommand(tabId, index, count))
  }

  // Extra data (kCommandAddTabExtraData / kCommandAddWindowExtraData) //////

  setTabExtraData(tabId: TabId, key: string, value: string): void {
    if (!this.findTab_(tabId)) return
    let map = this.tabExtraData_.get(tabId)
    if (!map) {
      map = new Map()
      this.tabExtraData_.set(tabId, map)
    }
    map.set(key, value)
    this.scheduleCommand_(createAddTabExtraDataCommand(tabId, key, value))
  }

  setWindowExtraData(windowId: SessionWindowId, key: string, value: string): void {
    if (!this.windows_.has(windowId)) return
    let map = this.windowExtraData_.get(windowId)
    if (!map) {
      map = new Map()
      this.windowExtraData_.set(windowId, map)
    }
    map.set(key, value)
    this.scheduleCommand_(createAddWindowExtraDataCommand(windowId, key, value))
  }

  // Reading and restoring //////////////////////////////////////////////////

  /** Replays the previous session's log. Mirrors GetLastSession. */
  async getLastSession(): Promise<SessionSnapshot> {
    this.checkNotDisposed_()
    await this.ready_
    // A secondary never reads the profile, just as a PROCESS_NOTIFIED Chrome
    // launch never opens it — restoring here would duplicate the owner's
    // live session into this realm.
    if (this.ownership_ === 'secondary') {
      return { windows: [], activeWindowId: null, errorReading: false }
    }
    let commands: readonly SessionCommand[]
    let errorReading: boolean
    try {
      const result = await this.storage_.readLastSessionCommands()
      commands = result.commands
      errorReading = result.errorReading
    } catch (error) {
      this.onError_(error)
      return { windows: [], activeWindowId: null, errorReading: true }
    }
    const snapshot = restoreSessionFromCommands(commands)
    return { ...snapshot, errorReading: snapshot.errorReading || errorReading }
  }

  /**
   * The one-call integration: restores the previous session's window into
   * `model` (when there is one) and attaches the model so the new session is
   * recorded. Restored navigation histories and extra data are re-adopted so
   * they survive future log rewrites.
   */
  async restoreInto(model: TabStripModel<T>, options: RestoreIntoOptions<T> = {}): Promise<RestoreIntoResult> {
    this.checkNotDisposed_()
    const snapshot = await this.getLastSession()
    const window = options.windowId
      ? snapshot.windows.find((w) => w.windowId === options.windowId)
      : snapshot.windows[0]
    const windowId = options.windowId ?? window?.windowId ?? DEFAULT_WINDOW_ID

    let result: RestoreResult = { tabsRestored: 0, tabIdMap: new Map(), groupIdMap: new Map() }
    if (window) {
      result = restoreSessionWindow(model, window, {
        createTabData: options.createTabData ?? ((tab) => this.deserializeTabData_(tab.data)),
        preserveTabIds: options.preserveTabIds,
        deferLoading: options.deferLoading,
      })
      // Re-adopt per-tab state under the (possibly re-generated) live ids.
      for (const sessionTab of window.tabs) {
        const liveId = result.tabIdMap.get(sessionTab.tabId)
        if (liveId === undefined) continue
        if (sessionTab.navigations.length > 0) {
          const position = Math.max(
            0,
            Math.min(sessionTab.currentNavigationIndex, sessionTab.navigations.length - 1),
          )
          this.navState_.set(liveId, {
            navigations: sessionTab.navigations.map((n) => ({ ...n })),
            currentNavigationIndex: sessionTab.navigations[position]!.index,
          })
        }
        const extra = Object.entries(sessionTab.extraData)
        if (extra.length > 0) this.tabExtraData_.set(liveId, new Map(extra))
      }
      const windowExtra = Object.entries(window.extraData)
      if (windowExtra.length > 0) this.windowExtraData_.set(windowId, new Map(windowExtra))
    }

    this.attach(model, { windowId })
    return {
      ...result,
      restored: window !== undefined,
      snapshot,
      ownership: this.ownership_ === 'secondary' ? 'secondary' : 'owner',
    }
  }

  // Persistence control /////////////////////////////////////////////////////

  /** Flushes buffered commands now (e.g. before an intentional teardown). */
  saveNow(): Promise<void> {
    return this.manager_.save()
  }

  /** True while commands are buffered awaiting the save timer. */
  get hasPendingSave(): boolean {
    return this.manager_.hasPendingSave
  }

  /**
   * Discards the log and rewrites it from live state. Mirrors
   * ScheduleResetCommands (session_service_base.cc:404) +
   * BuildCommandsFromBrowsers (cc:767).
   */
  scheduleResetCommands(): void {
    // cc:397: never build commands while saving is disabled.
    if (!this.savingEnabled_) return
    this.manager_.setPendingReset(true)
    this.manager_.clearPendingCommands()
    this.rebuildOnNextSave_ = false
    for (const [windowId, entry] of this.windows_) {
      this.buildCommandsForWindow_(windowId, entry)
    }
    if (this.activeWindowId_ !== null) {
      this.manager_.appendRebuildCommand(createSetActiveWindowCommand(this.activeWindowId_))
    }
    this.manager_.startSaveTimer()
  }

  /** Detaches everything and stops timers. Does not flush — saveNow() first if needed. */
  dispose(): void {
    if (this.disposed_) return
    this.disposed_ = true
    for (const windowId of [...this.windows_.keys()]) this.detach(windowId)
    if (this.pageHideListener_ !== null) {
      window.removeEventListener('pagehide', this.pageHideListener_)
      this.pageHideListener_ = null
    }
    this.manager_.dispose()
    // Cleanup() port: frees the profile for the next realm to claim at boot.
    this.singleton_?.release()
  }

  // Internals ///////////////////////////////////////////////////////////////

  private checkNotDisposed_(): void {
    if (this.disposed_) throw new Error('session: service is disposed')
  }

  private findTab_(tabId: TabId): { windowId: SessionWindowId; tab: Tab<T>; index: number } | null {
    for (const [windowId, entry] of this.windows_) {
      const tab = entry.model.getTabById(tabId)
      if (tab) return { windowId, tab, index: entry.model.indexOfTab(tab) }
    }
    return null
  }

  /** Replace-or-insert by navigation index (session_service_commands.cc:664). */
  private insertNavigation_(nav: TrackedNavigationState, navigation: SerializedNavigationEntry): void {
    const i = findClosestNavigationWithIndex(nav.navigations, navigation.index)
    if (i < nav.navigations.length && nav.navigations[i]!.index === navigation.index) {
      nav.navigations[i] = navigation
    } else {
      nav.navigations.splice(i, 0, navigation)
    }
  }

  private serializeTab_(tab: Tab<T>): unknown {
    try {
      return this.serializeTabData_(tab.data, tab)
    } catch (error) {
      this.onError_(error)
      return undefined
    }
  }

  /**
   * Coalesces a new command with a buffered one when only the latest value
   * matters. Port of ReplacePendingCommand (session_service_commands.cc:1344)
   * — Chrome only handles UpdateTabNavigation and SetActiveWindow; the other
   * last-write-wins commands here are this port's extension, safe because the
   * rebuild treats each of them as a keyed assignment.
   */
  private replacePendingCommand_(command: SessionCommand): boolean {
    const pending = this.manager_.pendingCommands
    for (let i = pending.length - 1; i >= 0; i--) {
      const existing = pending[i]!
      if (existing.id !== command.id) continue
      switch (command.id) {
        case SessionCommandId.UPDATE_TAB_NAVIGATION: {
          const old = existing as Extract<SessionCommand, { id: 6 }>
          if (old.tabId === command.tabId && old.navigation.index === command.navigation.index) {
            // Mirrors cc:1351-1363: drop the stale entry, append the new one.
            this.manager_.eraseCommand(existing)
            this.manager_.appendRebuildCommand(command)
            return true
          }
          continue
        }
        case SessionCommandId.SET_ACTIVE_WINDOW:
          this.manager_.swapCommand(existing, command)
          return true
        case SessionCommandId.SET_TAB_DATA:
        case SessionCommandId.SET_TAB_INDEX_IN_WINDOW:
        case SessionCommandId.LAST_ACTIVE_TIME:
        case SessionCommandId.SET_PINNED_STATE:
        case SessionCommandId.SET_TAB_GROUP: {
          if ((existing as { tabId?: TabId }).tabId === command.tabId) {
            this.manager_.swapCommand(existing, command)
            return true
          }
          continue
        }
        case SessionCommandId.SET_SELECTED_TAB_IN_INDEX: {
          if ((existing as { windowId?: SessionWindowId }).windowId === command.windowId) {
            this.manager_.swapCommand(existing, command)
            return true
          }
          continue
        }
        case SessionCommandId.SET_TAB_GROUP_METADATA2: {
          if ((existing as { groupId?: string }).groupId === command.groupId) {
            this.manager_.swapCommand(existing, command)
            return true
          }
          continue
        }
        default:
          return false
      }
    }
    return false
  }

  /** Mirrors SessionServiceBase::ScheduleCommand (session_service_base.cc:788). */
  private scheduleCommand_(command: SessionCommand): void {
    // cc:790: if (!is_saving_enabled_) return.
    if (this.disposed_ || !this.savingEnabled_) return
    if (this.replacePendingCommand_(command)) return
    const closing = isClosingCommand(command)
    this.manager_.scheduleCommand(command)
    // Never reset on a closing command — we could lose the tabs we want to
    // restore if the app exits right after (cc:802-806).
    if (!this.manager_.pendingReset && this.manager_.commandsSinceReset >= this.writesPerReset_ && !closing) {
      this.scheduleResetCommands()
    }
  }

  /** SetTabIndexInWindow for every tab in [lo, hi] — see the header comment. */
  private emitIndexRange_(model: TabStripModel<T>, lo: number, hi: number): void {
    const tabs = model.getTabs()
    const last = Math.min(hi, tabs.length - 1)
    for (let i = Math.max(0, lo); i <= last; i++) {
      this.scheduleCommand_(createSetTabIndexInWindowCommand(tabs[i]!.id, i))
    }
  }

  /** Dedup-cached SetSelectedTabInWindow, like session_service.cc. */
  private maybeEmitSelectedTab_(windowId: SessionWindowId, entry: WindowEntry<T>): void {
    const index = entry.model.activeIndex
    if (index === entry.lastSelectedIndex || index === NO_TAB) return
    entry.lastSelectedIndex = index
    this.scheduleCommand_(createSetSelectedTabInWindowCommand(windowId, index))
  }

  /**
   * BuildCommandsForBrowser + BuildCommandsForTab
   * (session_service_base.cc:672, :592), adapted to one TabStripModel.
   */
  private buildCommandsForWindow_(windowId: SessionWindowId, entry: WindowEntry<T>): void {
    const model = entry.model
    const m = this.manager_

    const windowExtra = this.windowExtraData_.get(windowId)
    if (windowExtra) {
      for (const [key, value] of windowExtra) {
        m.appendRebuildCommand(createAddWindowExtraDataCommand(windowId, key, value))
      }
    }

    const tabs = model.getTabs()
    tabs.forEach((tab, index) => {
      m.appendRebuildCommand(createSetTabWindowCommand(windowId, tab.id))
      if (Number.isFinite(tab.lastActiveAt)) {
        m.appendRebuildCommand(createLastActiveTimeCommand(tab.id, tab.lastActiveAt))
      }
      const nav = this.navState_.get(tab.id)
      if (nav && nav.navigations.length > 0) {
        // Persist up to maxPersistedNavigations either side of current (cc:608).
        const position = findClosestNavigationWithIndex(nav.navigations, nav.currentNavigationIndex)
        const lo = Math.max(position - this.maxPersistedNavigations_, 0)
        const hi = Math.min(position + this.maxPersistedNavigations_, nav.navigations.length)
        for (let i = lo; i < hi; i++) {
          m.appendRebuildCommand(createUpdateTabNavigationCommand(tab.id, { ...nav.navigations[i]! }))
        }
        m.appendRebuildCommand(createSetSelectedNavigationIndexCommand(tab.id, nav.currentNavigationIndex))
      }
      m.appendRebuildCommand(createSetTabIndexInWindowCommand(tab.id, index))
      if (tab.pinned) m.appendRebuildCommand(createPinnedStateCommand(tab.id, true))
      if (tab.group !== null) m.appendRebuildCommand(createTabGroupCommand(tab.id, tab.group))
      m.appendRebuildCommand(createSetTabDataCommand(tab.id, this.serializeTab_(tab)))
      const extra = this.tabExtraData_.get(tab.id)
      if (extra) {
        for (const [key, value] of extra) {
          m.appendRebuildCommand(createAddTabExtraDataCommand(tab.id, key, value))
        }
      }
    })

    for (const group of model.getGroups()) {
      m.appendRebuildCommand(createTabGroupMetadataUpdateCommand(group.id, group.visualData))
    }

    if (model.activeIndex !== NO_TAB) {
      m.appendRebuildCommand(createSetSelectedTabInWindowCommand(windowId, model.activeIndex))
    }
    entry.lastSelectedIndex = model.activeIndex
  }

  private createObserver_(windowId: SessionWindowId, entry: WindowEntry<T>): TabStripModelObserver<T> {
    const guarded = <A extends unknown[]>(fn: (...args: A) => void) => {
      return (...args: A) => {
        try {
          fn(...args)
        } catch (error) {
          this.onError_(error)
        }
      }
    }

    return {
      onTabStripModelChanged: guarded(
        (change: TabStripModelChange<T>, selection: TabStripSelectionChange<T>) => {
          switch (change.type) {
            case 'inserted': {
              let minIndex = Infinity
              for (const { tab, index } of change.contents) {
                this.scheduleCommand_(createSetTabWindowCommand(windowId, tab.id))
                this.scheduleCommand_(createSetTabDataCommand(tab.id, this.serializeTab_(tab)))
                if (tab.pinned) this.scheduleCommand_(createPinnedStateCommand(tab.id, true))
                if (tab.group !== null) this.scheduleCommand_(createTabGroupCommand(tab.id, tab.group))
                minIndex = Math.min(minIndex, index)
              }
              this.emitIndexRange_(entry.model, minIndex, entry.model.count - 1)
              break
            }
            case 'removed': {
              let minIndex = Infinity
              for (const { tab, index } of change.contents) {
                this.scheduleCommand_(createTabClosedCommand(tab.id))
                this.navState_.delete(tab.id)
                this.tabExtraData_.delete(tab.id)
                minIndex = Math.min(minIndex, index)
              }
              this.emitIndexRange_(entry.model, minIndex, entry.model.count - 1)
              break
            }
            case 'moved':
              this.emitIndexRange_(
                entry.model,
                Math.min(change.fromIndex, change.toIndex),
                Math.max(change.fromIndex, change.toIndex),
              )
              break
            case 'replaced':
              this.scheduleCommand_(createSetTabDataCommand(change.tab.id, this.serializeTab_(change.tab)))
              break
            case 'selectionOnly':
              break
          }

          if (selection.activeTabChanged && selection.oldTab && Number.isFinite(selection.oldTab.lastActiveAt)) {
            this.scheduleCommand_(createLastActiveTimeCommand(selection.oldTab.id, selection.oldTab.lastActiveAt))
          }
          this.maybeEmitSelectedTab_(windowId, entry)
        },
      ),

      onTabPinnedStateChanged: guarded((tab: Tab<T>) => {
        this.scheduleCommand_(createPinnedStateCommand(tab.id, tab.pinned))
      }),

      onTabGroupedStateChanged: guarded((_old, _new, tab: Tab<T>) => {
        this.scheduleCommand_(createTabGroupCommand(tab.id, tab.group))
      }),

      onTabGroupChanged: guarded((change) => {
        if (change.type === 'created' || change.type === 'visualsChanged') {
          const visuals = entry.model.getGroupVisualData(change.groupId)
          if (visuals) {
            this.scheduleCommand_(createTabGroupMetadataUpdateCommand(change.groupId, visuals))
          }
        }
        // 'moved' is covered by the per-tab move events; 'closed' needs no
        // command — rebuild only keeps groups still referenced by live tabs.
      }),

      onTabChanged: guarded((tab: Tab<T>) => {
        this.scheduleCommand_(createSetTabDataCommand(tab.id, this.serializeTab_(tab)))
      }),
    }
  }
}
