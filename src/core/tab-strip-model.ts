/**
 * Port of chrome/browser/ui/tabs/tab_strip_model.{h,cc} (Chromium main
 * @ 3dbd2135). Line references in comments point into chromium-reference/.
 *
 * Differences from Chrome are listed in PORTING_NOTES.md. The big ones:
 * tabs carry generic `data: T` instead of WebContents, split tabs are not
 * ported, and there is no async unload-handler dance — closes are
 * synchronous, vetoable via `canCloseTab`.
 *
 * Like Chrome, the model maintains these invariants:
 * - all pinned tabs occur before all non-pinned tabs
 * - tabs of a group are contiguous, and never pinned
 * - the active tab is always valid while the strip is non-empty
 */

import { ListSelectionModel } from './list-selection-model'
import type {
  TabStripModelChange,
  TabStripModelObserver,
  TabStripSelectionChange,
} from './observer'
import {
  AddTabFlags,
  NO_TAB,
  TAB_GROUP_COLORS,
  type AddTabOptions,
  type ReconcileOptions,
  type ReconcileTab,
  type Tab,
  type TabGroup,
  type TabGroupId,
  type TabGroupVisualData,
  type TabId,
  type TabOpenCause,
  type TabStripModelOptions,
} from './types'

function defaultGenerateId(): string {
  return `t${Math.random().toString(36).slice(2, 10)}`
}

/** [start, end) index range, mirroring gfx::Range usage for group spans. */
export interface IndexRange {
  start: number
  end: number
}

interface ActivateOptions {
  /**
   * Marks the activation as a direct user gesture. Mirrors
   * TabStripUserGestureDetails; gates the opener-forgetting heuristic
   * (tab_strip_model.cc:5301).
   */
  userGesture?: boolean
}

/** Internal: 'keep' preserves each tab's current group (group block moves). */
type GroupAssignment = TabGroupId | null | 'keep'

export class TabStripModel<T = unknown> {
  private tabs_: Array<Tab<T>> = []
  private groups_ = new Map<TabGroupId, TabGroupVisualData>()

  // Selection is tracked by tab identity, mirroring Chrome's
  // TabStripModelSelectionState; index views are derived on demand.
  private selectedTabs_ = new Set<Tab<T>>()
  private activeTab_: Tab<T> | null = null
  private anchorTab_: Tab<T> | null = null

  private observers_ = new Set<TabStripModelObserver<T>>()
  private closingAll_ = false
  private reentrancyGuard_ = false

  private readonly canCloseTab_: (tab: Tab<T>) => boolean
  private readonly supportsGroups_: boolean
  private readonly generateId_: () => string

  constructor(options: TabStripModelOptions<T> = {}) {
    this.canCloseTab_ = options.canCloseTab ?? (() => true)
    this.supportsGroups_ = options.supportsGroups ?? true
    this.generateId_ = options.generateId ?? defaultGenerateId
  }

  // Basic queries ////////////////////////////////////////////////////////////

  get count(): number {
    return this.tabs_.length
  }

  get empty(): boolean {
    return this.tabs_.length === 0
  }

  /** True while closeAllTabs is in progress. */
  get closingAll(): boolean {
    return this.closingAll_
  }

  containsIndex(index: number): boolean {
    return index >= 0 && index < this.tabs_.length
  }

  getTabAt(index: number): Tab<T> {
    const tab = this.tabs_[index]
    if (!tab) throw new RangeError(`no tab at index ${index}`)
    return tab
  }

  indexOfTab(tab: Tab<T> | null): number {
    if (!tab) return NO_TAB
    return this.tabs_.indexOf(tab)
  }

  getTabById(id: TabId): Tab<T> | null {
    return this.tabs_.find((t) => t.id === id) ?? null
  }

  /** Snapshot of the tabs in strip order. */
  getTabs(): ReadonlyArray<Tab<T>> {
    return [...this.tabs_]
  }

  get activeTab(): Tab<T> | null {
    return this.activeTab_
  }

  get activeIndex(): number {
    return this.activeTab_ ? this.indexOfTab(this.activeTab_) : NO_TAB
  }

  /** Index of the first non-pinned tab; count if all pinned. (cc:1418 area) */
  indexOfFirstNonPinnedTab(): number {
    const i = this.tabs_.findIndex((t) => !t.pinned)
    return i === -1 ? this.tabs_.length : i
  }

  isTabPinned(index: number): boolean {
    return this.getTabAt(index).pinned
  }

  isTabBlocked(index: number): boolean {
    return this.getTabAt(index).blocked
  }

  isTabSelected(index: number): boolean {
    return this.selectedTabs_.has(this.getTabAt(index))
  }

  /** Derived index-based view of the selection (Chrome: GetListSelectionModel). */
  selectionModel(): ListSelectionModel {
    const model = new ListSelectionModel()
    for (const tab of this.selectedTabs_) {
      const i = this.indexOfTab(tab)
      if (i !== NO_TAB) model.addIndexToSelection(i)
    }
    model.setActive(this.activeTab_ ? this.indexOfTab(this.activeTab_) : null)
    model.setAnchor(this.anchorTab_ ? this.indexOfTab(this.anchorTab_) : null)
    return model
  }

  // Group queries //////////////////////////////////////////////////////////

  get supportsTabGroups(): boolean {
    return this.supportsGroups_
  }

  getTabGroupForTab(index: number): TabGroupId | null {
    if (!this.containsIndex(index)) return null
    return this.tabs_[index]!.group
  }

  getGroups(): TabGroup[] {
    return [...this.groups_.entries()].map(([id, visualData]) => ({ id, visualData }))
  }

  getGroupVisualData(group: TabGroupId): TabGroupVisualData | null {
    return this.groups_.get(group) ?? null
  }

  containsGroup(group: TabGroupId): boolean {
    return this.groups_.has(group)
  }

  /** [start, end) range of the group's tabs. Mirrors TabGroup::ListTabs. */
  listTabsInGroup(group: TabGroupId): IndexRange {
    let start = -1
    let end = -1
    for (let i = 0; i < this.tabs_.length; i++) {
      if (this.tabs_[i]!.group === group) {
        if (start === -1) start = i
        end = i + 1
      }
    }
    if (start === -1) throw new Error(`no such group: ${group}`)
    return { start, end }
  }

  isGroupCollapsed(group: TabGroupId): boolean {
    return this.groups_.get(group)?.isCollapsed ?? false
  }

  /** True if the tab is inside a collapsed group. (cc:1423) */
  isTabCollapsed(index: number): boolean {
    const group = this.getTabGroupForTab(index)
    return group !== null && this.isGroupCollapsed(group)
  }

  /**
   * If a tab inserted at index would land inside a group, returns that group.
   * Returns null at the first index of a group (a tab there sits between
   * groups, not inside one). Mirrors GetSurroundingTabGroup.
   */
  getSurroundingTabGroup(index: number): TabGroupId | null {
    const before = this.getTabGroupForTab(index - 1)
    const at = this.getTabGroupForTab(index)
    return before !== null && before === at ? before : null
  }

  // Observers //////////////////////////////////////////////////////////////

  addObserver(observer: TabStripModelObserver<T>): () => void {
    this.observers_.add(observer)
    return () => this.observers_.delete(observer)
  }

  removeObserver(observer: TabStripModelObserver<T>): void {
    this.observers_.delete(observer)
  }

  // Add / insert ///////////////////////////////////////////////////////////

  /**
   * Command-level add: picks the position from the open cause and opener
   * relationships, then inserts. Port of AddTab (cc:1715-1828).
   */
  addTab(data: T, options: AddTabOptions = {}): Tab<T> {
    this.checkReentrancy_()
    const cause: TabOpenCause = options.cause ?? 'other'
    const flags = options.flags ?? 0
    let index = options.index ?? NO_TAB
    let group = options.group ?? null

    let inheritOpener = (flags & AddTabFlags.INHERIT_OPENER) !== 0

    if (cause === 'link' && (flags & AddTabFlags.FORCE_INDEX) === 0) {
      // Tabs opened via links are part of the same task as their parent.
      index = this.determineInsertionIndex(cause, (flags & AddTabFlags.ACTIVE) !== 0)
      inheritOpener = true
      // The active tab is our opener; inherit its group too. (cc:1742)
      if (group === null) {
        group = this.getTabGroupForTab(this.activeIndex)
      }
    } else if (index < 0 || index > this.count) {
      index = this.count
    }

    if (this.supportsGroups_) {
      if (group !== null && this.groups_.has(group)) {
        // Clamp so the group stays contiguous. (cc:1759)
        const range = this.listTabsInGroup(group)
        index = Math.min(Math.max(index, range.start), range.end)
      } else if (
        group === null &&
        this.getTabGroupForTab(index - 1) !== null &&
        this.getTabGroupForTab(index - 1) === this.getTabGroupForTab(index)
      ) {
        // Inserting between two tabs of the same group adopts it. (cc:1767)
        group = this.getTabGroupForTab(index)
      }
      // Pinned tabs cannot be grouped. (cc:1771)
      if (flags & AddTabFlags.PINNED) group = null
    } else {
      group = null
    }

    // A tab opened at the end of the strip by a typed action inherits the
    // opener too — the "quick look-up" pattern. Closing it returns to the
    // previous tab. (cc:1786-1796)
    if (cause === 'typed' && index === this.count) {
      inheritOpener = true
    }

    const tab = this.createTab_(data, options.id)
    this.insertTabAtImpl_(
      index,
      tab,
      flags | (inheritOpener ? AddTabFlags.INHERIT_OPENER : 0),
      group,
    )

    if (inheritOpener && cause === 'typed') {
      tab.resetOpenerOnActiveTabChange = true
    }
    return tab
  }

  /** Adds a tab at the end of the strip. Port of AppendTab. */
  appendTab(data: T, foreground = true): Tab<T> {
    return this.addTab(data, {
      index: this.count,
      cause: 'other',
      flags: AddTabFlags.FORCE_INDEX | (foreground ? AddTabFlags.ACTIVE : 0),
    })
  }

  /**
   * Inserts at the given index, only adjusting it to keep pinned tabs at the
   * front. Does NOT consult the order controller. Port of InsertWebContentsAt.
   * Returns the index actually used.
   */
  insertTabAt(index: number, data: T, options: Omit<AddTabOptions, 'index' | 'cause'> = {}): Tab<T> {
    this.checkReentrancy_()
    const group = options.group ?? null
    if (group !== null && !this.groups_.has(group)) {
      throw new Error(`no such group: ${group}`)
    }
    const tab = this.createTab_(data, options.id)
    this.insertTabAtImpl_(index, tab, options.flags ?? 0, group)
    return tab
  }

  // Activate / selection ///////////////////////////////////////////////////

  /** Makes the tab at index active. Port of ActivateTabAt (cc:1022). */
  activateTabAt(index: number, options: ActivateOptions = {}): void {
    this.checkReentrancy_()
    if (!this.containsIndex(index)) throw new RangeError(`no tab at index ${index}`)
    const tab = this.tabs_[index]!
    this.setSelection_(
      () => this.setSelectedTab_(tab),
      options.userGesture ? 'userGesture' : 'none',
    )
  }

  /** Extends the selection from the anchor to index. Port of cc:1514. */
  extendSelectionTo(index: number): void {
    this.checkReentrancy_()
    const tab = this.getTabAt(index)
    this.setSelection_(() => {
      if (!this.anchorTab_) {
        this.setSelectedTab_(tab)
        return
      }
      const anchorIndex = this.indexOfTab(this.anchorTab_)
      const lo = Math.min(anchorIndex, index)
      const hi = Math.max(anchorIndex, index)
      this.selectedTabs_ = new Set(this.tabs_.slice(lo, hi + 1))
      this.activeTab_ = tab
    }, 'none')
  }

  /** Adds the tab at index to the selection and makes it active+anchor. (cc:1545) */
  selectTabAt(index: number): void {
    this.checkReentrancy_()
    const tab = this.getTabAt(index)
    this.setSelection_(() => {
      this.selectedTabs_.add(tab)
      this.anchorTab_ = tab
      this.activeTab_ = tab
    }, 'none')
  }

  /** Removes the tab at index from the selection. No-op if it's the last one. (cc:1570) */
  deselectTabAt(index: number): void {
    this.checkReentrancy_()
    const tab = this.getTabAt(index)
    if (!this.selectedTabs_.has(tab)) return
    if (this.selectedTabs_.size === 1) return
    this.setSelection_(() => {
      this.selectedTabs_.delete(tab)
      const first = this.firstSelectedTab_()
      if (!this.activeTab_ || this.activeTab_ === tab) this.activeTab_ = first
      if (!this.anchorTab_ || this.anchorTab_ === tab) this.anchorTab_ = first
    }, 'none')
  }

  /** Selects anchor..index, adding to the current selection. (cc:1616) */
  addSelectionFromAnchorTo(index: number): void {
    this.checkReentrancy_()
    const tab = this.getTabAt(index)
    this.setSelection_(() => {
      if (!this.anchorTab_) {
        this.setSelectedTab_(tab)
        return
      }
      const anchorIndex = this.indexOfTab(this.anchorTab_)
      const lo = Math.min(anchorIndex, index)
      const hi = Math.max(anchorIndex, index)
      for (const t of this.tabs_.slice(lo, hi + 1)) this.selectedTabs_.add(t)
      this.activeTab_ = tab
    }, 'none')
  }

  /** Replaces the selection with the given index-based model. */
  setSelectionFromModel(source: ListSelectionModel): void {
    this.checkReentrancy_()
    if (source.active === null) throw new Error('selection must have an active index')
    this.setSelection_(() => {
      this.selectedTabs_ = new Set(source.selectedIndices().map((i) => this.getTabAt(i)))
      this.activeTab_ = this.getTabAt(source.active!)
      this.anchorTab_ = source.anchor === null ? null : this.getTabAt(source.anchor)
    }, 'none')
  }

  /**
   * Activates the next/previous tab, wrapping around and skipping collapsed
   * groups. Port of SelectRelativeTab (cc:3951).
   */
  selectNextTab(options: ActivateOptions = {}): void {
    this.selectRelativeTab_(1, options)
  }

  selectPreviousTab(options: ActivateOptions = {}): void {
    this.selectRelativeTab_(-1, options)
  }

  selectLastTab(options: ActivateOptions = {}): void {
    if (this.empty) return
    this.activateTabAt(this.count - 1, options)
  }

  private selectRelativeTab_(delta: 1 | -1, options: ActivateOptions): void {
    if (this.empty) return
    const startIndex = this.activeIndex
    let index = (startIndex + this.count + delta) % this.count
    let group = this.getTabGroupForTab(index)
    while (group !== null && this.isGroupCollapsed(group)) {
      index = (index + this.count + delta) % this.count
      group = this.getTabGroupForTab(index)
    }
    this.activateTabAt(index, options)
  }

  // Move ///////////////////////////////////////////////////////////////////

  /**
   * Moves the tab at index to toPosition (clamped so pinned tabs stay
   * together). Group membership adjusts to keep groups contiguous. Port of
   * MoveWebContentsAt (cc:1053). Returns the final index.
   */
  moveTabTo(index: number, toPosition: number, selectAfterMove = false): number {
    this.checkReentrancy_()
    if (!this.containsIndex(index)) throw new RangeError(`no tab at index ${index}`)
    const pinned = this.isTabPinned(index)
    toPosition = this.constrainMoveIndex_(toPosition, pinned)
    if (index === toPosition) return toPosition
    const group = this.getGroupToAssign_(index, toPosition)
    this.moveTabToIndexImpl_(index, toPosition, group, pinned, selectAfterMove)
    return toPosition
  }

  /**
   * Moves the selected tabs to index, pinned tabs first as a chunk, then
   * unpinned. `index` is interpreted as if the strip did not contain the
   * selected tabs. Port of MoveSelectedTabsTo (cc:1089).
   */
  moveSelectedTabsTo(index: number, group: TabGroupId | null = null): void {
    this.checkReentrancy_()
    const pinnedTabCount = this.indexOfFirstNonPinnedTab()
    const pinnedSelected = this.selectedIndices_().filter((i) => i < pinnedTabCount)
    const unpinnedSelected = this.selectedIndices_().filter((i) => i >= pinnedTabCount)

    const lastPinnedIndex = clamp(
      index + pinnedSelected.length - 1,
      pinnedSelected.length - 1,
      pinnedTabCount - 1,
    )
    this.moveTabsToIndexImpl_(pinnedSelected, lastPinnedIndex - pinnedSelected.length + 1, 'keep')

    const firstUnpinnedIndex = clamp(
      index + pinnedSelected.length,
      pinnedTabCount,
      this.count - unpinnedSelected.length,
    )
    this.moveTabsToIndexImpl_(unpinnedSelected, firstUnpinnedIndex, group)
  }

  /** Moves all tabs of a group to toIndex. Port of MoveGroupTo (cc:1117). */
  moveGroupTo(group: TabGroupId, toIndex: number): void {
    this.checkReentrancy_()
    if (!this.groups_.has(group)) throw new Error(`no such group: ${group}`)
    toIndex = this.constrainMoveIndex_(toIndex, false)
    const range = this.listTabsInGroup(group)
    if (range.start === toIndex) return
    const indices = []
    for (let i = range.start; i < range.end; i++) indices.push(i)
    // Block destination is in post-removal coordinates.
    const length = indices.length
    const dest = clamp(
      toIndex > range.start ? toIndex - length + 1 : toIndex,
      this.indexOfFirstNonPinnedTab() - countLessThan(indices, this.indexOfFirstNonPinnedTab()),
      this.count - length,
    )
    this.moveTabsToIndexImpl_(indices, dest, 'keep')
    this.notifyAll_((o) => o.onTabGroupChanged?.({ type: 'moved', groupId: group }))
  }

  /**
   * Moves the active tab one slot right/left. At a group boundary the tab
   * first changes group membership without moving; collapsed neighbor groups
   * are hopped over entirely. Port of MoveTabRelative (cc:3976).
   */
  moveTabNext(): void {
    this.moveTabRelative_(1)
  }

  moveTabPrevious(): void {
    this.moveTabRelative_(-1)
  }

  private moveTabRelative_(delta: 1 | -1): void {
    this.checkReentrancy_()
    const start = this.activeIndex
    if (start === NO_TAB) throw new Error('no active tab')

    let targetIndex = start
    const neighborIndex = delta === 1 ? start + 1 : start - 1
    if (this.containsIndex(neighborIndex) && this.isTabPinned(start) === this.isTabPinned(neighborIndex)) {
      targetIndex += delta
    }

    const currentGroup = this.getTabGroupForTab(start)
    let targetGroup = targetIndex === start ? null : this.getTabGroupForTab(neighborIndex)

    if (this.supportsGroups_ && currentGroup !== targetGroup) {
      if (currentGroup !== null) {
        // Leave the current group before moving out of its span.
        targetIndex = start
        targetGroup = null
      } else if (targetGroup !== null) {
        if (this.isGroupCollapsed(targetGroup)) {
          // Hop over the collapsed group as if it were one tab.
          const range = this.listTabsInGroup(targetGroup)
          targetIndex = delta === 1 ? range.end - 1 : range.start
          targetGroup = null
        } else {
          // Enter the group without moving.
          targetIndex = start
        }
      }
    }
    this.moveTabsToIndexImpl_([start], targetIndex, targetGroup)
  }

  // Pinning ////////////////////////////////////////////////////////////////

  /**
   * Pins or unpins the tab, moving it to the pinned/unpinned boundary.
   * Pinning removes the tab from its group. Returns the final index.
   * Port of SetTabPinned (cc:1407) + SetTabPinnedImpl (cc:5052).
   */
  setTabPinned(index: number, pinned: boolean): number {
    this.checkReentrancy_()
    if (!this.containsIndex(index)) throw new RangeError(`no tab at index ${index}`)
    if (this.isTabPinned(index) === pinned) return index
    const finalIndex = pinned
      ? this.indexOfFirstNonPinnedTab()
      : this.indexOfFirstNonPinnedTab() - 1
    this.moveTabToIndexImpl_(index, finalIndex, null, pinned, false)
    return finalIndex
  }

  // Close //////////////////////////////////////////////////////////////////

  /** Closes the tab at index. Returns true if it closed (not vetoed). */
  closeTabAt(index: number): boolean {
    return this.closeTabs_([this.getTabAt(index)])
  }

  /** Closes the tabs at the given indices. */
  closeTabsAt(indices: number[]): boolean {
    return this.closeTabs_(indices.map((i) => this.getTabAt(i)))
  }

  /** Port of CloseSelectedTabs. */
  closeSelectedTabs(): boolean {
    return this.closeTabs_([...this.selectedTabs_])
  }

  /** Port of CloseAllTabs (cc:455). */
  closeAllTabs(): boolean {
    return this.closeTabs_([...this.tabs_])
  }

  /** Context-menu style helper: close every tab except the one at index. */
  closeOtherTabs(index: number): boolean {
    const keep = this.getTabAt(index)
    return this.closeTabs_(this.tabs_.filter((t) => t !== keep && !t.pinned))
  }

  /** Context-menu style helper: close unpinned tabs to the right of index. */
  closeTabsToRight(index: number): boolean {
    return this.closeTabs_(this.tabs_.slice(index + 1).filter((t) => !t.pinned))
  }

  /** Closes all tabs in a group. Port of CloseAllTabsInGroup. */
  closeAllTabsInGroup(group: TabGroupId): boolean {
    const range = this.listTabsInGroup(group)
    return this.closeTabs_(this.tabs_.slice(range.start, range.end))
  }

  private closeTabs_(tabs: Array<Tab<T>>, options: { bypassVeto?: boolean } = {}): boolean {
    this.checkReentrancy_()
    const closable: Array<Tab<T>> = []
    for (const tab of tabs) {
      if (options.bypassVeto || this.canCloseTab_(tab)) {
        closable.push(tab)
      } else {
        this.notifyAll_((o) => o.onTabCloseCancelled?.(tab))
      }
    }
    if (closable.length === 0) return false

    const closingAll = closable.length === this.count
    if (closingAll) {
      this.closingAll_ = true
      this.notifyAll_((o) => o.willCloseAllTabs?.())
    }

    const oldActive = this.activeTab_
    const oldModel = this.selectionModel()
    const removed: Array<{ tab: Tab<T>; index: number }> = []
    const groupNotifications: Array<{ tab: Tab<T>; index: number; group: TabGroupId }> = []

    for (const tab of closable) {
      const index = this.indexOfTab(tab)
      if (index === NO_TAB) continue
      this.removeTabFromIndexImpl_(index)
      removed.push({ tab, index })
      if (tab.group !== null) {
        groupNotifications.push({ tab, index, group: tab.group })
        tab.group = null
      }
    }

    this.validate_()

    const selection = this.buildSelectionChange_(oldActive, oldModel, 'none')
    this.notifyAll_((o) =>
      o.onTabStripModelChanged?.({ type: 'removed', contents: removed }, selection),
    )
    for (const { tab, index, group } of groupNotifications) {
      this.notifyAll_((o) => o.onTabGroupedStateChanged?.(group, null, tab, index))
    }
    // Delete groups that became empty.
    for (const { group } of groupNotifications) {
      if (this.groups_.has(group) && !this.tabs_.some((t) => t.group === group)) {
        this.groups_.delete(group)
        this.notifyAll_((o) => o.onTabGroupChanged?.({ type: 'closed', groupId: group }))
      }
    }
    this.handleActiveTabChanged_(selection)

    if (closingAll) {
      this.closingAll_ = false
      this.notifyAll_((o) => o.closeAllTabsStopped?.('completed'))
    }
    return true
  }

  /**
   * Removes the tab and fixes up the selection. Port of
   * RemoveTabFromIndexImpl (cc:4551). Caller batches notifications.
   */
  private removeTabFromIndexImpl_(index: number): Tab<T> {
    const tab = this.tabs_[index]!
    const nextSelectedIndex = this.determineNewSelectedIndex_(index)

    this.fixOpeners_(index)
    this.tabs_.splice(index, 1)
    this.selectedTabs_.delete(tab)
    if (this.anchorTab_ === tab) this.anchorTab_ = null

    if (this.empty) {
      this.selectedTabs_.clear()
      this.activeTab_ = null
      this.anchorTab_ = null
    } else if (this.activeTab_ === tab) {
      if (this.selectedTabs_.size > 0) {
        // Active tab removed but something is still selected: first selected
        // tab becomes active and anchor. (cc:4595)
        const first = this.firstSelectedTab_()
        this.activeTab_ = first
        this.anchorTab_ = first
      } else {
        // Nothing selected: fall back to the order-controller choice. (cc:4601)
        if (nextSelectedIndex === null) throw new Error('invariant: no next tab to select')
        this.setSelectedTab_(this.tabs_[nextSelectedIndex]!)
      }
    }
    return tab
  }

  // External-state reconciliation //////////////////////////////////////////

  /**
   * Converges the strip to an external source-of-truth list with minimal
   * mutations (no remove-all/re-add), so an app whose canonical tab state
   * lives elsewhere (a router, a store, another window) can mirror it into
   * the model without losing tab identity, content state, or discard status.
   *
   * - tabs absent from `desired` are removed, bypassing `canCloseTab` (the
   *   external state has already decided)
   * - missing tabs are inserted at their position under the given id
   * - `data` is swapped via setTabData where `dataEquals` reports a change
   * - pinned state and order converge to the desired list; pass a
   *   pinned-first-consistent list or Chrome's clamping rules win
   * - `activeId`, when provided and present, is activated last
   *
   * Observers fire for each underlying mutation as usual; reconcile-driven
   * activations carry reason 'none', so a consumer that also writes model
   * changes back to the external store can tell them from user gestures.
   * Groups are not reconciled. No Chrome equivalent: this is integration
   * surface for embedding apps.
   */
  reconcile(desired: ReadonlyArray<ReconcileTab<T>>, options: ReconcileOptions<T> = {}): void {
    this.checkReentrancy_()
    const dataEquals = options.dataEquals ?? Object.is
    const desiredIds = new Set<TabId>()
    for (const want of desired) {
      if (desiredIds.has(want.id)) throw new Error(`duplicate tab id in reconcile: ${want.id}`)
      desiredIds.add(want.id)
    }

    const toRemove = this.tabs_.filter((tab) => !desiredIds.has(tab.id))
    if (toRemove.length > 0) this.closeTabs_(toRemove, { bypassVeto: true })

    desired.forEach((want, position) => {
      const existing = this.getTabById(want.id)
      const pinned = want.pinned ?? false
      if (!existing) {
        this.insertTabAt(position, want.data, {
          id: want.id,
          flags: pinned ? AddTabFlags.PINNED : AddTabFlags.NONE,
        })
        return
      }
      if (!dataEquals(existing.data, want.data)) {
        this.setTabData(this.indexOfTab(existing), want.data)
      }
      if (existing.pinned !== pinned) {
        this.setTabPinned(this.indexOfTab(existing), pinned)
      }
      const index = this.indexOfTab(existing)
      if (index !== position) {
        this.moveTabTo(index, position)
      }
    })

    if (options.activeId != null) {
      const activeIndex = this.indexOfTab(this.getTabById(options.activeId))
      if (activeIndex !== NO_TAB && activeIndex !== this.activeIndex) {
        this.activateTabAt(activeIndex)
      }
    }
  }

  // Openers ////////////////////////////////////////////////////////////////

  getOpenerOfTabAt(index: number): Tab<T> | null {
    return this.getTabAt(index).opener
  }

  setOpenerOfTabAt(index: number, opener: Tab<T> | null): void {
    const tab = this.getTabAt(index)
    if (opener === tab) throw new Error('a tab cannot be its own opener')
    if (opener && this.indexOfTab(opener) === NO_TAB) {
      throw new Error('opener must be in this tab strip')
    }
    tab.opener = opener
  }

  /** Port of ForgetAllOpeners (cc:3376). */
  forgetAllOpeners(): void {
    for (const tab of this.tabs_) tab.opener = null
  }

  forgetOpener(tab: Tab<T>): void {
    tab.opener = null
  }

  /**
   * Call when the user navigates a tab. Typed-style navigations reset all
   * opener relationships (the user started a new task), except in a fresh
   * end-of-strip tab. Port of TabNavigating (cc:1378).
   */
  tabNavigating(tab: Tab<T>, cause: TabOpenCause): void {
    if (cause !== 'typed') return
    const isNewTabAtEnd =
      tab === this.tabs_[this.tabs_.length - 1] && tab.resetOpenerOnActiveTabChange
    if (!isNewTabAtEnd) this.forgetAllOpeners()
  }

  /**
   * Index of the last tab opened (transitively) by the tab at startIndex,
   * scanning right, skipping pinned tabs, stopping at the first unrelated
   * unpinned tab. Port of GetIndexOfLastWebContentsOpenedBy (cc:1351).
   */
  getIndexOfLastTabOpenedBy(opener: Tab<T>, startIndex: number): number {
    const openerAndDescendants = new Set<Tab<T>>([opener])
    let lastIndex = NO_TAB
    for (let i = startIndex + 1; i < this.count; i++) {
      const tab = this.tabs_[i]!
      if (!tab.opener || !openerAndDescendants.has(tab.opener)) {
        if (tab.pinned) continue
        break
      }
      openerAndDescendants.add(tab)
      lastIndex = i
    }
    return lastIndex
  }

  // Groups /////////////////////////////////////////////////////////////////

  /**
   * Creates a group containing the tabs at indices (ascending). Tabs are
   * unpinned and made contiguous without splitting other groups. Returns the
   * group id. Port of AddToNewGroup (cc:671) + AddToNewGroupImpl (cc:4344).
   */
  addToNewGroup(indices: number[], visualData?: Partial<TabGroupVisualData>): TabGroupId {
    this.checkReentrancy_()
    this.requireGroups_()
    assertAscending(indices)
    if (indices.length === 0) throw new Error('indices must not be empty')

    const groupId = this.generateId_()
    this.groups_.set(groupId, {
      title: visualData?.title ?? '',
      color: visualData?.color ?? this.nextGroupColor_(),
      isCollapsed: visualData?.isCollapsed ?? false,
    })
    this.notifyAll_((o) => o.onTabGroupChanged?.({ type: 'created', groupId }))

    // Find a destination for the first tab that's not pinned or inside
    // another group; the rest stack up to its right. (cc:4376)
    const firstGroup = this.getTabGroupForTab(indices[0]!)
    let destinationIndex = -1
    for (let i = indices[0]!; i <= this.count; i++) {
      if (!this.containsIndex(i)) {
        destinationIndex = i
        break
      }
      if (this.isTabPinned(i)) continue
      const destinationGroup = this.getTabGroupForTab(i)
      if (destinationGroup === null || destinationGroup !== firstGroup) {
        destinationIndex = i
        break
      }
    }

    this.moveTabsAndSetProperties_(indices, destinationIndex, groupId, false)

    // Deselect all grouped tabs except the active one. (cc:4404)
    const range = this.listTabsInGroup(groupId)
    for (let i = range.start; i < range.end; i++) {
      if (this.activeIndex !== i && this.isTabSelected(i)) this.deselectTabAt(i)
    }
    return groupId
  }

  /**
   * Adds the tabs at indices (ascending) to an existing group. Tabs left of
   * the group move to its start, tabs right of it to its end; addToEnd sends
   * everything to the end. Port of AddToExistingGroup (cc:4415).
   */
  addToExistingGroup(indices: number[], group: TabGroupId, addToEnd = false): void {
    this.checkReentrancy_()
    this.requireGroups_()
    assertAscending(indices)
    if (!this.groups_.has(group)) return

    const range = this.listTabsInGroup(group)
    const firstTabIndex = range.start
    const lastTabIndex = range.end - 1

    const tabsLeftOfGroup = indices.filter((i) => i < firstTabIndex)
    const tabsRightOfGroup = indices.filter((i) => i > lastTabIndex)

    if (addToEnd) {
      this.moveTabsAndSetProperties_(
        [...tabsLeftOfGroup, ...tabsRightOfGroup],
        lastTabIndex + 1,
        group,
        false,
      )
    } else {
      this.moveTabsAndSetProperties_(tabsLeftOfGroup, firstTabIndex, group, false)
      this.moveTabsAndSetProperties_(tabsRightOfGroup, lastTabIndex + 1, group, false)
    }
  }

  /**
   * Removes the tabs at indices (ascending) from their groups. Tabs in the
   * first half of a group exit left of it, the rest exit right. Port of
   * RemoveFromGroup (cc:4253 area) + SeparateTabsByVisualPosition.
   */
  removeFromGroup(indices: number[]): void {
    this.checkReentrancy_()
    this.requireGroups_()
    assertAscending(indices)

    const indicesPerGroup = new Map<TabGroupId, number[]>()
    for (const index of indices) {
      const group = this.getTabGroupForTab(index)
      if (group !== null) {
        if (!indicesPerGroup.has(group)) indicesPerGroup.set(group, [])
        indicesPerGroup.get(group)!.push(index)
      }
    }

    for (const [group, groupIndices] of indicesPerGroup) {
      const range = this.listTabsInGroup(group)
      const firstTabIndex = range.start
      const lastTabIndex = range.end - 1
      const midpoint = Math.floor((range.end - range.start) / 2)

      const leftOfGroup = groupIndices.filter((i) => i - firstTabIndex < midpoint)
      const rightOfGroup = groupIndices.filter((i) => i - firstTabIndex >= midpoint)

      this.moveTabsAndSetProperties_(leftOfGroup, firstTabIndex, null, false)
      this.moveTabsAndSetProperties_(rightOfGroup, lastTabIndex + 1, null, false)
    }
  }

  /** Updates a group's title/color/collapsed state. Port of ChangeTabGroupVisuals. */
  updateGroupVisuals(group: TabGroupId, visuals: Partial<TabGroupVisualData>): void {
    const old = this.groups_.get(group)
    if (!old) throw new Error(`no such group: ${group}`)
    const next: TabGroupVisualData = { ...old, ...visuals }
    if (old.isCollapsed !== next.isCollapsed && next.isCollapsed) {
      // Collapsing the group containing the active tab moves activation to
      // the nearest expanded tab; if there is none the collapse is refused
      // (Chrome opens a new tab in that case — we have no tab factory).
      const range = this.listTabsInGroup(group)
      const active = this.activeIndex
      if (active >= range.start && active < range.end) {
        this.groups_.set(group, next)
        const fallback = this.getNextExpandedActiveTab_(range.start, range.end)
        if (fallback === null) {
          this.groups_.set(group, old)
          throw new Error('cannot collapse the only expanded tabs in the strip')
        }
        this.activateTabAt(fallback)
        this.notifyAll_((o) =>
          o.onTabGroupChanged?.({ type: 'visualsChanged', groupId: group, oldVisuals: old, newVisuals: next }),
        )
        return
      }
    }
    this.groups_.set(group, next)
    this.notifyAll_((o) =>
      o.onTabGroupChanged?.({ type: 'visualsChanged', groupId: group, oldVisuals: old, newVisuals: next }),
    )
  }

  setGroupCollapsed(group: TabGroupId, collapsed: boolean): void {
    this.updateGroupVisuals(group, { isCollapsed: collapsed })
  }

  /** Chrome's TabGroupModel::GetNextColor: least-used color, in palette order. */
  private nextGroupColor_(): TabGroupVisualData['color'] {
    const usage = new Map<string, number>()
    for (const color of TAB_GROUP_COLORS) usage.set(color, 0)
    for (const { color } of this.groups_.values()) {
      usage.set(color, (usage.get(color) ?? 0) + 1)
    }
    let best = TAB_GROUP_COLORS[0]!
    for (const color of TAB_GROUP_COLORS) {
      if (usage.get(color)! < usage.get(best)!) best = color
    }
    return best
  }

  // Tab data / state ///////////////////////////////////////////////////////

  /** Swaps the tab's data payload. Emits a 'replaced' change (Chrome: Replace). */
  setTabData(index: number, data: T): void {
    const tab = this.getTabAt(index)
    const oldData = tab.data
    tab.data = data
    const selection = this.buildSelectionChange_(this.activeTab_, this.selectionModel(), 'none')
    this.notifyAll_((o) =>
      o.onTabStripModelChanged?.(
        { type: 'replaced', tab, oldData, newData: data, index },
        selection,
      ),
    )
  }

  /** Notify observers the tab changed in place (after mutating tab.data). */
  notifyTabChanged(index: number): void {
    const tab = this.getTabAt(index)
    this.notifyAll_((o) => o.onTabChanged?.(tab, index))
  }

  /** Port of SetTabBlocked (cc:1397). */
  setTabBlocked(index: number, blocked: boolean): void {
    const tab = this.getTabAt(index)
    if (tab.blocked === blocked) return
    tab.blocked = blocked
    this.notifyAll_((o) => o.onTabChanged?.(tab, index))
  }

  // Lifecycle (discarding) /////////////////////////////////////////////////

  /**
   * Drops the tab's content to save memory while keeping the tab in the
   * strip. The active tab cannot be discarded (it's visible). Content
   * remounts fresh on the next activation, like Chrome's reload-on-focus.
   * Port of TabLifecycleUnit::Discard (tab_lifecycle_unit.cc:346) +
   * TabStripModel::DiscardWebContentsAt semantics. Returns true on success.
   */
  discardTabAt(index: number): boolean {
    const tab = this.getTabAt(index)
    if (tab.discarded) return false
    if (tab === this.activeTab_) return false
    tab.discarded = true
    this.notifyAll_((o) => o.onTabDiscardedStateChanged?.(tab, index, true))
    return true
  }

  /**
   * Restores a discarded tab without activating it (Chrome: reloading a
   * background discarded tab, DidStartLoading path).
   */
  restoreTabAt(index: number): boolean {
    const tab = this.getTabAt(index)
    if (!tab.discarded) return false
    this.restoreTab_(tab)
    return true
  }

  /** Per-tab opt-out from automatic discarding (extensions setAutoDiscardable). */
  setTabAutoDiscardable(index: number, autoDiscardable: boolean): void {
    this.getTabAt(index).autoDiscardable = autoDiscardable
  }

  isTabDiscarded(index: number): boolean {
    return this.getTabAt(index).discarded
  }

  /** Number of tabs whose content is currently live (not discarded). */
  get loadedTabCount(): number {
    return this.tabs_.reduce((n, t) => n + (t.discarded ? 0 : 1), 0)
  }

  private restoreTab_(tab: Tab<T>): void {
    tab.discarded = false
    const index = this.indexOfTab(tab)
    this.notifyAll_((o) => o.onTabDiscardedStateChanged?.(tab, index, false))
  }

  // Order controller ///////////////////////////////////////////////////////

  /**
   * Where to place a newly opened tab. Port of DetermineInsertionIndex
   * (cc:5329).
   */
  determineInsertionIndex(cause: TabOpenCause, foreground: boolean): number {
    if (this.count === 0) return 0

    if (cause === 'link' && this.activeIndex !== NO_TAB) {
      if (foreground) {
        // Opened in the foreground from a link: insert adjacent to the opener.
        return this.activeIndex + 1
      }
      const opener = this.activeTab_!
      const index = this.getIndexOfLastTabOpenedBy(opener, this.activeIndex)
      if (index === NO_TAB) return this.activeIndex + 1

      // Insert before the first group discontinuity after the opener.
      // (cc:5351, crbug.com/40789226)
      const openerGroup = this.getTabGroupForTab(this.activeIndex)
      for (let i = this.activeIndex + 1; i <= index; i++) {
        if (this.getTabGroupForTab(i) !== openerGroup) return i
      }
      return index + 1
    }
    // Ctrl+T and friends: open at the end of the strip.
    return this.count
  }

  /**
   * Which tab should become active after the tab at `index` closes.
   * Port of DetermineNewSelectedIndex (cc:5377), single-tab block, with the
   * "parent collection" preference specialized to groups. Returns the index
   * in post-close coordinates, or null if this is the last tab.
   */
  private determineNewSelectedIndex_(index: number): number | null {
    if (this.count === 1) return null
    const blockStart = index
    const blockEnd = index + 1

    const afterClosing = (i: number) => (i > blockEnd - 1 ? i - 1 : i)

    // First preference: a tab this tab opened. (cc:5407)
    let next = this.getIndexOfNextTabOpenedBy_(blockStart, blockEnd)
    if (next !== NO_TAB && !this.isTabCollapsed(next)) return afterClosing(next)

    // Second preference: a tab opened by this tab's opener. (cc:5414)
    next = this.getIndexOfNextTabOpenedByOpenerOf_(blockStart, blockEnd)
    if (next !== NO_TAB && !this.isTabCollapsed(next)) return afterClosing(next)

    // Third preference: the opener itself. (cc:5422)
    const opener = this.tabs_[index]!.opener
    if (opener) {
      const openerIndex = this.indexOfTab(opener)
      if (openerIndex !== NO_TAB && openerIndex !== index && !this.isTabCollapsed(openerIndex)) {
        return afterClosing(openerIndex)
      }
    }

    // Fourth preference: stay inside the closing tab's group. (cc:5432)
    const group = this.tabs_[index]!.group
    if (group !== null) {
      const range = this.listTabsInGroup(group)
      if (range.end !== blockEnd) return afterClosing(blockEnd)
      if (range.start !== blockStart) return afterClosing(blockStart - 1)
    }

    // Otherwise pick the nearest non-collapsed tab. (cc:5467)
    const nextAvailable = this.getNextExpandedActiveTab_(blockStart, blockEnd)
    if (nextAvailable !== null) return afterClosing(nextAvailable)

    // Fall back to the neighbor. (cc:5473)
    if (blockEnd - 1 >= this.count - 1) return blockStart - 1
    return blockEnd - 1
  }

  /** Port of GetIndexOfNextWebContentsOpenedBy (cc:3286). */
  private getIndexOfNextTabOpenedBy_(blockStart: number, blockEnd: number): number {
    const blockTabs = new Set(this.tabs_.slice(blockStart, blockEnd))
    for (let i = blockEnd; i < this.count; i++) {
      const opener = this.tabs_[i]!.opener
      if (opener && blockTabs.has(opener)) return i
    }
    for (let i = blockStart - 1; i >= 0; i--) {
      const opener = this.tabs_[i]!.opener
      if (opener && blockTabs.has(opener)) return i
    }
    return NO_TAB
  }

  /** Port of GetIndexOfNextWebContentsOpenedByOpenerOf (cc:3312). */
  private getIndexOfNextTabOpenedByOpenerOf_(blockStart: number, blockEnd: number): number {
    const blockOpeners = new Set<Tab<T>>()
    for (let i = blockStart; i < blockEnd; i++) {
      const opener = this.tabs_[i]!.opener
      if (opener) blockOpeners.add(opener)
    }
    if (blockOpeners.size === 0) return NO_TAB
    for (let i = blockEnd; i < this.count; i++) {
      const opener = this.tabs_[i]!.opener
      if (opener && blockOpeners.has(opener)) return i
    }
    for (let i = blockStart - 1; i >= 0; i--) {
      const opener = this.tabs_[i]!.opener
      if (opener && blockOpeners.has(opener)) return i
    }
    return NO_TAB
  }

  /** Port of GetNextExpandedActiveTab (cc:3346): right of block, then left. */
  private getNextExpandedActiveTab_(blockStart: number, blockEnd: number): number | null {
    for (let i = blockEnd; i < this.count; i++) {
      if (!this.isTabCollapsed(i)) return i
    }
    for (let i = blockStart - 1; i >= 0; i--) {
      if (!this.isTabCollapsed(i)) return i
    }
    return null
  }

  // Internal mechanics /////////////////////////////////////////////////////

  private createTab_(data: T, id?: TabId): Tab<T> {
    return {
      id: id ?? this.generateId_(),
      data,
      opener: null,
      resetOpenerOnActiveTabChange: false,
      pinned: false,
      group: null,
      blocked: false,
      discarded: false,
      lastActiveAt: Date.now(),
      autoDiscardable: true,
    }
  }

  /** Port of ConstrainInsertionIndex (cc:3408). */
  private constrainInsertionIndex_(index: number, pinned: boolean): number {
    return pinned
      ? clamp(index, 0, this.indexOfFirstNonPinnedTab())
      : clamp(index, this.indexOfFirstNonPinnedTab(), this.count)
  }

  /** Port of ConstrainMoveIndex (cc:3413). */
  private constrainMoveIndex_(index: number, pinned: boolean): number {
    return pinned
      ? clamp(index, 0, this.indexOfFirstNonPinnedTab() - 1)
      : clamp(index, this.indexOfFirstNonPinnedTab(), this.count - 1)
  }

  /** Port of InsertTabAtImpl (cc:3575). Returns the index actually used. */
  private insertTabAtImpl_(
    index: number,
    tab: Tab<T>,
    flags: number,
    group: TabGroupId | null,
  ): number {
    const active = (flags & AddTabFlags.ACTIVE) !== 0 || this.empty
    const pin = (flags & AddTabFlags.PINNED) !== 0
    index = this.constrainInsertionIndex_(index, pin)

    const activeTab = this.activeTab_
    if ((flags & AddTabFlags.INHERIT_OPENER) !== 0 && activeTab) {
      // Forget existing relationships first so multiple openers aren't live
      // at once. (cc:3602)
      if (active) this.forgetAllOpeners()
      tab.opener = activeTab
    }

    // InsertTabAtIndexImpl (cc:4504)
    tab.pinned = pin
    tab.group = pin ? null : group
    const oldActive = this.activeTab_
    this.tabs_.splice(index, 0, tab)
    const oldModel = this.selectionModel()
    if (active) this.setSelectedTab_(tab)
    this.validate_()

    const selection = this.buildSelectionChange_(oldActive, oldModel, 'none')
    this.notifyAll_((o) =>
      o.onTabStripModelChanged?.(
        { type: 'inserted', contents: [{ tab, index }] },
        selection,
      ),
    )
    if (tab.group !== null) {
      this.notifyAll_((o) => o.onTabGroupedStateChanged?.(null, tab.group, tab, index))
    }
    this.handleActiveTabChanged_(selection)
    return index
  }

  /**
   * Single-tab move with explicit final group/pin state. Port of
   * MoveTabToIndexImpl (cc:4617).
   */
  private moveTabToIndexImpl_(
    initialIndex: number,
    finalIndex: number,
    group: TabGroupId | null,
    pin: boolean,
    selectAfterMove: boolean,
  ): void {
    const tab = this.tabs_[initialIndex]!
    const initialPinned = tab.pinned
    const initialGroup = tab.group

    if (initialIndex === finalIndex && group === initialGroup && pin === initialPinned) return

    if (initialIndex !== finalIndex) this.fixOpeners_(initialIndex)

    const oldActive = this.activeTab_
    const oldModel = this.selectionModel()

    this.tabs_.splice(initialIndex, 1)
    this.tabs_.splice(finalIndex, 0, tab)
    tab.pinned = pin
    tab.group = pin ? null : group

    if (selectAfterMove) this.setSelectedTab_(tab)
    this.validate_()

    const selection = this.buildSelectionChange_(oldActive, oldModel, 'none')
    if (initialIndex !== finalIndex) {
      this.notifyAll_((o) =>
        o.onTabStripModelChanged?.(
          { type: 'moved', tab, fromIndex: initialIndex, toIndex: finalIndex },
          selection,
        ),
      )
    }
    if (initialPinned !== tab.pinned) {
      this.notifyAll_((o) => o.onTabPinnedStateChanged?.(tab, finalIndex))
    }
    this.emitGroupStateChange_(tab, finalIndex, initialGroup, tab.group)
    this.handleActiveTabChanged_(selection)
  }

  /**
   * Block move: removes the tabs at `indices`, reinserts them contiguously at
   * `destination` (post-removal coordinates), assigning the given group and
   * the pinned state of the first moving tab. Port of MoveTabsToIndexImpl
   * (cc:4698) + MoveTabsWithNotifications (cc:5081).
   */
  private moveTabsToIndexImpl_(
    indices: number[],
    destination: number,
    group: GroupAssignment,
  ): void {
    if (indices.length === 0) return
    assertAscending(indices)

    const pin = this.tabs_[indices[0]!]!.pinned
    const moving = indices.map((i) => this.tabs_[i]!)
    const initial = moving.map((tab, k) => ({
      tab,
      index: indices[k]!,
      group: tab.group,
      pinned: tab.pinned,
    }))

    const oldActive = this.activeTab_
    const oldModel = this.selectionModel()

    // FixOpeners for every tab that will change position. (PrepareTabsToMoveToIndex)
    for (const i of indices) this.fixOpeners_(i)

    const movingSet = new Set(moving)
    const remaining = this.tabs_.filter((t) => !movingSet.has(t))
    remaining.splice(destination, 0, ...moving)
    this.tabs_ = remaining
    for (const tab of moving) {
      tab.pinned = pin
      if (group !== 'keep') tab.group = pin ? null : group
    }
    this.validate_()

    const selection = this.buildSelectionChange_(oldActive, oldModel, 'none')
    for (const note of initial) {
      const finalIndex = this.indexOfTab(note.tab)
      if (note.index !== finalIndex) {
        this.notifyAll_((o) =>
          o.onTabStripModelChanged?.(
            { type: 'moved', tab: note.tab, fromIndex: note.index, toIndex: finalIndex },
            selection,
          ),
        )
      }
      if (note.pinned !== note.tab.pinned) {
        this.notifyAll_((o) => o.onTabPinnedStateChanged?.(note.tab, finalIndex))
      }
      this.emitGroupStateChange_(note.tab, finalIndex, note.group, note.tab.group)
    }
    this.handleActiveTabChanged_(selection)
  }

  /**
   * Port of MoveTabsAndSetPropertiesImpl (cc:4469): destination is given in
   * pre-removal coordinates and adjusted here.
   */
  private moveTabsAndSetProperties_(
    indices: number[],
    destinationIndex: number,
    group: TabGroupId | null,
    pinned: boolean,
  ): void {
    if (indices.length === 0) return
    let numTabsLeftOfDestination = 0
    for (const i of indices) {
      if (i >= destinationIndex) break
      numTabsLeftOfDestination++
    }
    void pinned // all current callers pass false; pin comes from the first moving tab
    this.moveTabsToIndexImpl_(indices, destinationIndex - numTabsLeftOfDestination, group)
  }

  /**
   * Group to assign when a tab moves from index to toPosition so groups stay
   * contiguous. Port of GetGroupToAssign (cc:5195).
   */
  private getGroupToAssign_(index: number, toPosition: number): TabGroupId | null {
    const tab = this.tabs_[index]!
    if (!this.supportsGroups_) return null

    let newLeftGroup: TabGroupId | null = null
    let newRightGroup: TabGroupId | null = null
    if (toPosition > index) {
      newLeftGroup = this.getTabGroupForTab(toPosition)
      newRightGroup = this.getTabGroupForTab(toPosition + 1)
    } else if (toPosition < index) {
      newLeftGroup = this.getTabGroupForTab(toPosition - 1)
      newRightGroup = this.getTabGroupForTab(toPosition)
    }

    if (tab.group !== newLeftGroup && tab.group !== newRightGroup) {
      if (newLeftGroup === newRightGroup && newLeftGroup !== null) {
        // Landing in the middle of an existing group: join it.
        return newLeftGroup
      }
      if (tab.group !== null && this.tabs_.filter((t) => t.group === tab.group).length > 1) {
        // Landing between groups while leaving a non-empty group behind:
        // clear membership so the old group stays contiguous.
        return null
      }
    }
    return tab.group
  }

  /**
   * Re-points the openers of any tab that referenced the tab at index at that
   * tab's own opener. Port of FixOpeners (cc:5171).
   */
  private fixOpeners_(index: number): void {
    const oldTab = this.tabs_[index]!
    const newOpener = oldTab.opener
    for (const tab of this.tabs_) {
      if (tab.opener !== oldTab) continue
      tab.opener = newOpener === tab ? null : newOpener
    }
  }

  /** Selection helpers (Chrome: TabStripModelSelectionState). */
  private setSelectedTab_(tab: Tab<T>): void {
    this.selectedTabs_ = new Set([tab])
    this.activeTab_ = tab
    this.anchorTab_ = tab
  }

  private firstSelectedTab_(): Tab<T> | null {
    let best: Tab<T> | null = null
    let bestIndex = Infinity
    for (const tab of this.selectedTabs_) {
      const i = this.indexOfTab(tab)
      if (i !== NO_TAB && i < bestIndex) {
        bestIndex = i
        best = tab
      }
    }
    return best
  }

  private selectedIndices_(): number[] {
    return [...this.selectedTabs_]
      .map((t) => this.indexOfTab(t))
      .filter((i) => i !== NO_TAB)
      .sort((a, b) => a - b)
  }

  /**
   * Wraps a selection mutation in change tracking + notification. Mirrors
   * SetSelection (cc:1178).
   */
  private setSelection_(mutate: () => void, reason: 'none' | 'userGesture'): void {
    const oldActive = this.activeTab_
    const oldModel = this.selectionModel()
    mutate()
    const selection = this.buildSelectionChange_(oldActive, oldModel, reason)
    if (selection.activeTabChanged || selection.selectionChanged) {
      this.notifyAll_((o) =>
        o.onTabStripModelChanged?.({ type: 'selectionOnly' }, selection),
      )
      this.handleActiveTabChanged_(selection)
    }
  }

  private buildSelectionChange_(
    oldTab: Tab<T> | null,
    oldModel: ListSelectionModel,
    reason: 'none' | 'userGesture',
  ): TabStripSelectionChange<T> {
    const newTab = this.activeTab_
    const newModel = this.selectionModel()
    return {
      oldTab,
      newTab,
      oldModel,
      newModel,
      reason,
      get activeTabChanged() {
        return oldTab !== newTab
      },
      get selectionChanged() {
        return !oldModel.equals(newModel)
      },
    }
  }

  /**
   * Opener and lifecycle bookkeeping when the active tab changes. Port of
   * OnActiveTabChanged (cc:5255) plus TabLifecycleUnit::SetFocused
   * (tab_lifecycle_unit.cc:135).
   */
  private handleActiveTabChanged_(selection: TabStripSelectionChange<T>): void {
    if (!selection.activeTabChanged || this.empty) return
    const oldTab = selection.oldTab
    const newTab = selection.newTab
    let oldOpener: Tab<T> | null = null

    // SetFocused(false) on the old tab: record when it left the foreground.
    // SetFocused(true) on the new tab: Infinity while focused, and a
    // discarded tab reloads on focus (MaybeLoad, tab_lifecycle_unit.cc:155).
    if (oldTab && this.indexOfTab(oldTab) !== NO_TAB) {
      oldTab.lastActiveAt = Date.now()
    }
    if (newTab) {
      newTab.lastActiveAt = Infinity
      if (newTab.discarded) this.restoreTab_(newTab)
    }

    if (oldTab && this.indexOfTab(oldTab) !== NO_TAB) {
      oldOpener = oldTab.opener
      // Transient opener relationships reset on any active-tab change. (cc:5292)
      if (oldTab.resetOpenerOnActiveTabChange) {
        oldTab.opener = null
        oldTab.resetOpenerOnActiveTabChange = false
      }
    }
    const newOpener = newTab?.opener ?? null

    // On a user-gesture switch outside the opener tree, forget all openers
    // to keep future close-activation predictable. (cc:5301)
    if (
      selection.reason === 'userGesture' &&
      newOpener !== oldOpener &&
      newOpener !== oldTab &&
      oldOpener !== newTab
    ) {
      this.forgetAllOpeners()
    }
  }

  private emitGroupStateChange_(
    tab: Tab<T>,
    index: number,
    oldGroup: TabGroupId | null,
    newGroup: TabGroupId | null,
  ): void {
    if (oldGroup === newGroup) return
    this.notifyAll_((o) => o.onTabGroupedStateChanged?.(oldGroup, newGroup, tab, index))
    if (oldGroup !== null && this.groups_.has(oldGroup) && !this.tabs_.some((t) => t.group === oldGroup)) {
      this.groups_.delete(oldGroup)
      this.notifyAll_((o) => o.onTabGroupChanged?.({ type: 'closed', groupId: oldGroup }))
    }
  }

  private notifyAll_(fn: (observer: TabStripModelObserver<T>) => void): void {
    // Observers must not mutate the model while being notified (Chrome:
    // ReentrancyCheck).
    this.reentrancyGuard_ = true
    try {
      for (const observer of [...this.observers_]) fn(observer)
    } finally {
      this.reentrancyGuard_ = false
    }
  }

  private requireGroups_(): void {
    if (!this.supportsGroups_) throw new Error('tab groups are disabled for this model')
  }

  private checkReentrancy_(): void {
    if (this.reentrancyGuard_) {
      throw new Error('TabStripModel is not re-entrant; do not mutate it from an observer')
    }
  }

  /**
   * Invariant validation. Port of CompleteModelUpdateTransaction; Chrome
   * CHECKs, we throw.
   */
  private validate_(): void {
    // Pinned tabs strictly before unpinned tabs.
    const firstNonPinned = this.indexOfFirstNonPinnedTab()
    for (let i = 0; i < this.tabs_.length; i++) {
      const tab = this.tabs_[i]!
      if (tab.pinned !== i < firstNonPinned) {
        throw new Error(`invariant violated: pinned tab at index ${i} after unpinned tabs`)
      }
      if (tab.pinned && tab.group !== null) {
        throw new Error(`invariant violated: pinned tab at index ${i} is grouped`)
      }
    }
    // Group contiguity.
    const seenGroups = new Set<TabGroupId>()
    let currentGroup: TabGroupId | null = null
    for (const tab of this.tabs_) {
      if (tab.group !== currentGroup) {
        if (tab.group !== null && seenGroups.has(tab.group)) {
          throw new Error(`invariant violated: group ${tab.group} is not contiguous`)
        }
        if (tab.group !== null) seenGroups.add(tab.group)
        currentGroup = tab.group
      }
    }
    // Active tab valid while non-empty.
    if (!this.empty && (!this.activeTab_ || this.indexOfTab(this.activeTab_) === NO_TAB)) {
      throw new Error('invariant violated: no valid active tab')
    }
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi)
}

function countLessThan(sorted: number[], threshold: number): number {
  let n = 0
  for (const v of sorted) {
    if (v < threshold) n++
    else break
  }
  return n
}

function assertAscending(indices: number[]): void {
  for (let i = 1; i < indices.length; i++) {
    if (indices[i]! <= indices[i - 1]!) {
      throw new Error('indices must be sorted in ascending order')
    }
  }
}
