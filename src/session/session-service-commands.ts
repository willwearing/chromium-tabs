/**
 * Session commands: the persisted mutation log and its rebuild algorithm.
 * Ported from chromium-reference/components/sessions/core/session_service_commands.cc.
 *
 * Chrome appends fixed-size binary payloads (pickles) to an SNSS file; this
 * port keeps the same command ids and semantics but encodes each command as a
 * JSON-serializable object. Restoring a session means replaying the log into
 * SessionTab/SessionWindow structures (RestoreSessionFromCommands, cc:1398).
 */

import { TAB_GROUP_COLORS, type TabGroupId, type TabGroupVisualData, type TabId } from '../core/types'
import type {
  SerializedNavigationEntry,
  SessionSnapshot,
  SessionTab,
  SessionTabGroup,
  SessionWindow,
  SessionWindowId,
} from './session-types'

/**
 * Command ids, numbered as in session_service_commands.cc:58-106. Ids that
 * only make sense for a real browser (window bounds, user agent overrides,
 * extension app ids, session storage, split tabs) are not ported; their
 * numbers stay reserved so logs remain comparable to Chrome's.
 */
export const SessionCommandId = {
  SET_TAB_WINDOW: 0, // cc:58
  SET_TAB_INDEX_IN_WINDOW: 2, // cc:61
  UPDATE_TAB_NAVIGATION: 6, // cc:68
  SET_SELECTED_NAVIGATION_INDEX: 7, // cc:69
  SET_SELECTED_TAB_IN_INDEX: 8, // cc:70
  SET_PINNED_STATE: 12, // cc:80
  TAB_CLOSED: 16, // cc:84
  WINDOW_CLOSED: 17, // cc:85
  SET_ACTIVE_WINDOW: 20, // cc:89
  LAST_ACTIVE_TIME: 21, // cc:90
  TAB_NAVIGATION_PATH_PRUNED: 24, // cc:94
  SET_TAB_GROUP: 25, // cc:95
  SET_TAB_GROUP_METADATA2: 27, // cc:98
  SET_TAB_DATA: 30, // cc:101
  ADD_TAB_EXTRA_DATA: 33, // cc:105
  ADD_WINDOW_EXTRA_DATA: 34, // cc:106
} as const

export type SessionCommand =
  | { id: 0; windowId: SessionWindowId; tabId: TabId }
  | { id: 2; tabId: TabId; index: number }
  | { id: 6; tabId: TabId; navigation: SerializedNavigationEntry }
  | { id: 7; tabId: TabId; index: number }
  | { id: 8; windowId: SessionWindowId; index: number }
  | { id: 12; tabId: TabId; pinned: boolean }
  | { id: 16; tabId: TabId; closeTime: number }
  | { id: 17; windowId: SessionWindowId; closeTime: number }
  | { id: 20; windowId: SessionWindowId }
  | { id: 21; tabId: TabId; lastActiveTime: number }
  | { id: 24; tabId: TabId; index: number; count: number }
  | { id: 25; tabId: TabId; groupId: TabGroupId | null }
  | { id: 27; groupId: TabGroupId; visualData: TabGroupVisualData }
  | { id: 30; tabId: TabId; data: unknown }
  | { id: 33; tabId: TabId; key: string; value: string }
  | { id: 34; windowId: SessionWindowId; key: string; value: string }

// Builders ////////////////////////////////////////////////////////////////
// Mirrors the Create*Command helpers (session_service_commands.cc:719+).

export function createSetTabWindowCommand(windowId: SessionWindowId, tabId: TabId): SessionCommand {
  return { id: SessionCommandId.SET_TAB_WINDOW, windowId, tabId }
}

export function createSetTabIndexInWindowCommand(tabId: TabId, index: number): SessionCommand {
  return { id: SessionCommandId.SET_TAB_INDEX_IN_WINDOW, tabId, index }
}

export function createUpdateTabNavigationCommand(
  tabId: TabId,
  navigation: SerializedNavigationEntry,
): SessionCommand {
  return { id: SessionCommandId.UPDATE_TAB_NAVIGATION, tabId, navigation }
}

export function createSetSelectedNavigationIndexCommand(tabId: TabId, index: number): SessionCommand {
  return { id: SessionCommandId.SET_SELECTED_NAVIGATION_INDEX, tabId, index }
}

export function createSetSelectedTabInWindowCommand(
  windowId: SessionWindowId,
  index: number,
): SessionCommand {
  return { id: SessionCommandId.SET_SELECTED_TAB_IN_INDEX, windowId, index }
}

export function createPinnedStateCommand(tabId: TabId, pinned: boolean): SessionCommand {
  return { id: SessionCommandId.SET_PINNED_STATE, tabId, pinned }
}

export function createTabClosedCommand(tabId: TabId, closeTime = Date.now()): SessionCommand {
  return { id: SessionCommandId.TAB_CLOSED, tabId, closeTime }
}

export function createWindowClosedCommand(
  windowId: SessionWindowId,
  closeTime = Date.now(),
): SessionCommand {
  return { id: SessionCommandId.WINDOW_CLOSED, windowId, closeTime }
}

export function createSetActiveWindowCommand(windowId: SessionWindowId): SessionCommand {
  return { id: SessionCommandId.SET_ACTIVE_WINDOW, windowId }
}

export function createLastActiveTimeCommand(tabId: TabId, lastActiveTime: number): SessionCommand {
  return { id: SessionCommandId.LAST_ACTIVE_TIME, tabId, lastActiveTime }
}

export function createTabNavigationPathPrunedCommand(
  tabId: TabId,
  index: number,
  count: number,
): SessionCommand {
  return { id: SessionCommandId.TAB_NAVIGATION_PATH_PRUNED, tabId, index, count }
}

export function createTabGroupCommand(tabId: TabId, groupId: TabGroupId | null): SessionCommand {
  return { id: SessionCommandId.SET_TAB_GROUP, tabId, groupId }
}

export function createTabGroupMetadataUpdateCommand(
  groupId: TabGroupId,
  visualData: TabGroupVisualData,
): SessionCommand {
  return { id: SessionCommandId.SET_TAB_GROUP_METADATA2, groupId, visualData: { ...visualData } }
}

export function createSetTabDataCommand(tabId: TabId, data: unknown): SessionCommand {
  return { id: SessionCommandId.SET_TAB_DATA, tabId, data }
}

export function createAddTabExtraDataCommand(tabId: TabId, key: string, value: string): SessionCommand {
  return { id: SessionCommandId.ADD_TAB_EXTRA_DATA, tabId, key, value }
}

export function createAddWindowExtraDataCommand(
  windowId: SessionWindowId,
  key: string,
  value: string,
): SessionCommand {
  return { id: SessionCommandId.ADD_WINDOW_EXTRA_DATA, windowId, key, value }
}

/**
 * True for commands recording a close. Closing commands never trigger a
 * rebuild — resetting right after a close could lose the state we want to
 * restore. Mirrors IsClosingCommand (session_service_commands.cc:1374).
 */
export function isClosingCommand(command: SessionCommand): boolean {
  return command.id === SessionCommandId.TAB_CLOSED || command.id === SessionCommandId.WINDOW_CLOSED
}

// Rebuild /////////////////////////////////////////////////////////////////

interface MutableSessionTab extends SessionTab {
  hasWindow: boolean
}

/** GetTab (session_service_commands.cc:240): lazily create on first mention. */
function getTab(tabs: Map<TabId, MutableSessionTab>, tabId: TabId): MutableSessionTab {
  let tab = tabs.get(tabId)
  if (!tab) {
    tab = {
      tabId,
      windowId: '',
      hasWindow: false,
      visualIndex: -1,
      pinned: false,
      groupId: null,
      data: undefined,
      navigations: [],
      currentNavigationIndex: -1,
      extraData: {},
    }
    tabs.set(tabId, tab)
  }
  return tab
}

/** GetWindow (session_service_commands.cc:251). */
function getWindow(windows: Map<SessionWindowId, SessionWindow>, windowId: SessionWindowId): SessionWindow {
  let window = windows.get(windowId)
  if (!window) {
    window = { windowId, selectedTabIndex: -1, tabs: [], tabGroups: [], extraData: {} }
    windows.set(windowId, window)
  }
  return window
}

/**
 * Returns the position of the first navigation whose index is >= `index`,
 * or navigations.length. Navigations are sorted ascending by index.
 * Mirrors FindClosestNavigationWithIndex (session_service_commands.cc:339).
 */
export function findClosestNavigationWithIndex(
  navigations: readonly SerializedNavigationEntry[],
  index: number,
): number {
  for (let i = 0; i < navigations.length; i++) {
    if (navigations[i]!.index >= index) return i
  }
  return navigations.length
}

/**
 * Removes `count` navigation entries starting at index value `index`,
 * fixing up the selected index and renumbering survivors. Mirrors
 * ProcessTabNavigationPathPrunedCommand (session_service_commands.cc:489).
 */
export function processTabNavigationPathPruned(
  tab: Pick<SessionTab, 'navigations' | 'currentNavigationIndex'>,
  index: number,
  count: number,
): void {
  if (tab.currentNavigationIndex >= index && tab.currentNavigationIndex < index + count) {
    tab.currentNavigationIndex = index - 1
  } else if (tab.currentNavigationIndex >= index + count) {
    tab.currentNavigationIndex -= count
  }

  const from = findClosestNavigationWithIndex(tab.navigations, index)
  const to = findClosestNavigationWithIndex(tab.navigations, index + count)
  tab.navigations.splice(from, to - from)

  for (const navigation of tab.navigations) {
    if (navigation.index >= index) navigation.index -= count
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

function isValidNavigation(nav: unknown): nav is SerializedNavigationEntry {
  if (typeof nav !== 'object' || nav === null) return false
  const n = nav as Record<string, unknown>
  return isNum(n.index) && isStr(n.url)
}

function isValidVisualData(v: unknown): v is TabGroupVisualData {
  if (typeof v !== 'object' || v === null) return false
  const d = v as Record<string, unknown>
  return isStr(d.title) && (TAB_GROUP_COLORS as readonly string[]).includes(d.color as string) && isBool(d.isCollapsed)
}

interface RebuildState {
  tabs: Map<TabId, MutableSessionTab>
  tabGroups: Map<TabGroupId, SessionTabGroup>
  windows: Map<SessionWindowId, SessionWindow>
  activeWindowId: SessionWindowId | null
}

/**
 * Applies one command to the in-progress maps. Returns false on a malformed
 * or unknown command, which aborts the replay — the caller keeps whatever
 * was accumulated so far. Mirrors the switch in CreateTabsAndWindows
 * (session_service_commands.cc:521): fault-tolerant, never throws.
 */
function processCommand(state: RebuildState, command: SessionCommand): boolean {
  const { tabs, tabGroups, windows } = state
  // Treat the command as untrusted input: it came from storage.
  const c = command as Record<string, unknown> & { id: number }
  switch (c.id) {
    case SessionCommandId.SET_TAB_WINDOW: {
      if (!isStr(c.tabId) || !isStr(c.windowId)) return false
      const tab = getTab(tabs, c.tabId)
      tab.windowId = c.windowId
      tab.hasWindow = true
      return true
    }
    case SessionCommandId.SET_TAB_INDEX_IN_WINDOW: {
      if (!isStr(c.tabId) || !isNum(c.index)) return false
      getTab(tabs, c.tabId).visualIndex = c.index
      return true
    }
    case SessionCommandId.UPDATE_TAB_NAVIGATION: {
      // Replace-or-insert by navigation index (cc:664-676).
      if (!isStr(c.tabId) || !isValidNavigation(c.navigation)) return false
      const tab = getTab(tabs, c.tabId)
      const navigation = { ...c.navigation }
      const i = findClosestNavigationWithIndex(tab.navigations, navigation.index)
      if (i < tab.navigations.length && tab.navigations[i]!.index === navigation.index) {
        tab.navigations[i] = navigation
      } else {
        tab.navigations.splice(i, 0, navigation)
      }
      return true
    }
    case SessionCommandId.SET_SELECTED_NAVIGATION_INDEX: {
      if (!isStr(c.tabId) || !isNum(c.index)) return false
      getTab(tabs, c.tabId).currentNavigationIndex = c.index
      return true
    }
    case SessionCommandId.SET_SELECTED_TAB_IN_INDEX: {
      if (!isStr(c.windowId) || !isNum(c.index)) return false
      getWindow(windows, c.windowId).selectedTabIndex = c.index
      return true
    }
    case SessionCommandId.SET_PINNED_STATE: {
      if (!isStr(c.tabId) || !isBool(c.pinned)) return false
      getTab(tabs, c.tabId).pinned = c.pinned
      return true
    }
    case SessionCommandId.TAB_CLOSED: {
      if (!isStr(c.tabId)) return false
      tabs.delete(c.tabId)
      return true
    }
    case SessionCommandId.WINDOW_CLOSED: {
      if (!isStr(c.windowId)) return false
      windows.delete(c.windowId)
      return true
    }
    case SessionCommandId.SET_ACTIVE_WINDOW: {
      if (!isStr(c.windowId)) return false
      state.activeWindowId = c.windowId
      return true
    }
    case SessionCommandId.LAST_ACTIVE_TIME: {
      if (!isStr(c.tabId) || !isNum(c.lastActiveTime)) return false
      getTab(tabs, c.tabId).lastActiveTime = c.lastActiveTime
      return true
    }
    case SessionCommandId.TAB_NAVIGATION_PATH_PRUNED: {
      if (!isStr(c.tabId) || !isNum(c.index) || !isNum(c.count)) return false
      if (c.index < 0 || c.count < 1) return false
      processTabNavigationPathPruned(getTab(tabs, c.tabId), c.index, c.count)
      return true
    }
    case SessionCommandId.SET_TAB_GROUP: {
      if (!isStr(c.tabId) || !(c.groupId === null || isStr(c.groupId))) return false
      getTab(tabs, c.tabId).groupId = c.groupId
      return true
    }
    case SessionCommandId.SET_TAB_GROUP_METADATA2: {
      if (!isStr(c.groupId) || !isValidVisualData(c.visualData)) return false
      tabGroups.set(c.groupId, { groupId: c.groupId, visualData: { ...c.visualData } })
      return true
    }
    case SessionCommandId.SET_TAB_DATA: {
      if (!isStr(c.tabId)) return false
      getTab(tabs, c.tabId).data = c.data
      return true
    }
    case SessionCommandId.ADD_TAB_EXTRA_DATA: {
      if (!isStr(c.tabId) || !isStr(c.key) || !isStr(c.value)) return false
      getTab(tabs, c.tabId).extraData[c.key] = c.value
      return true
    }
    case SessionCommandId.ADD_WINDOW_EXTRA_DATA: {
      if (!isStr(c.windowId) || !isStr(c.key) || !isStr(c.value)) return false
      getWindow(windows, c.windowId).extraData[c.key] = c.value
      return true
    }
    default:
      // Unknown command: stop replaying (cc:1330 default case).
      return false
  }
}

/**
 * Replays a command log into restorable windows. Port of
 * RestoreSessionFromCommands (session_service_commands.cc:1398):
 *
 *   1. CreateTabsAndWindows (cc:521) — apply each command to lazily-created
 *      tab/window/group entries, stopping at the first malformed command.
 *   2. AddTabsToWindows (cc:404) — attach tabs to their windows, dropping
 *      tabs that never got a window; remap each tab's selected-navigation
 *      *index value* to a position in its navigations array.
 *   3. SortTabsBasedOnVisualOrderAndClear (cc:372) — order tabs by visual
 *      index and drop windows with no tabs.
 *   4. UpdateSelectedTabIndex (cc:265) — remap each window's selected-tab
 *      *visual index* to a position in its tabs array.
 *
 * Deviation from Chrome: tabs without navigation entries are kept when they
 * carry a data payload — this library's data-only persistence mode has no
 * navigation list, but the tab is still fully restorable from `data`.
 */
export function restoreSessionFromCommands(commands: readonly SessionCommand[]): SessionSnapshot {
  const state: RebuildState = {
    tabs: new Map(),
    tabGroups: new Map(),
    windows: new Map(),
    activeWindowId: null,
  }

  let errorReading = false
  for (const command of commands) {
    if (!processCommand(state, command)) {
      errorReading = true
      break
    }
  }

  // AddTabsToWindows (cc:404).
  for (const tab of state.tabs.values()) {
    if (!tab.hasWindow) continue
    if (tab.navigations.length === 0 && tab.data === undefined) continue
    const window = getWindow(state.windows, tab.windowId)
    window.tabs.push(tab)
    if (tab.navigations.length > 0) {
      const j = findClosestNavigationWithIndex(tab.navigations, tab.currentNavigationIndex)
      tab.currentNavigationIndex = j === tab.navigations.length ? tab.navigations.length - 1 : j
    } else {
      tab.currentNavigationIndex = -1
    }
  }

  // Collect the groups referenced by each window's tabs (cc:441-452). Groups
  // whose metadata never arrived still get an entry, with default visuals.
  for (const window of state.windows.values()) {
    const seen = new Set<TabGroupId>()
    for (const tab of window.tabs) {
      if (tab.groupId === null || seen.has(tab.groupId)) continue
      seen.add(tab.groupId)
      window.tabGroups.push(
        state.tabGroups.get(tab.groupId) ?? {
          groupId: tab.groupId,
          visualData: { title: '', color: 'grey', isCollapsed: false },
        },
      )
    }
  }

  // SortTabsBasedOnVisualOrderAndClear (cc:372). Array.prototype.sort is
  // stable, so tabs sharing a visual index keep command order — Chrome
  // tie-breaks on its monotonic numeric ids instead (cc:380).
  const validWindows = [...state.windows.values()].filter((w) => w.tabs.length > 0)
  for (const window of validWindows) {
    window.tabs.sort((a, b) => a.visualIndex - b.visualIndex)
  }
  validWindows.sort((a, b) => (a.windowId < b.windowId ? -1 : a.windowId > b.windowId ? 1 : 0))

  // UpdateSelectedTabIndex (cc:265): visual index -> array position.
  for (const window of validWindows) {
    const i = window.tabs.findIndex((t) => t.visualIndex === window.selectedTabIndex)
    window.selectedTabIndex = i === -1 ? 0 : i
  }

  // Strip the rebuild-only marker before handing windows out.
  for (const window of validWindows) {
    for (const tab of window.tabs) delete (tab as Partial<MutableSessionTab>).hasWindow
  }

  return {
    windows: validWindows as SessionWindow[],
    activeWindowId: state.activeWindowId,
    errorReading,
  }
}
