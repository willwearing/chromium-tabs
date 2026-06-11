/**
 * Automatic tab discarding. Port of Chrome's tab lifecycle stack:
 *
 * - chrome/browser/resource_coordinator/tab_manager.cc (orchestration)
 * - chrome/browser/performance_manager/policies/discard_eligibility_policy.h
 *   (CanDiscardResult tri-state, CannotDiscardReason, the importance sort in
 *   PageNodeSortProxy::operator<, kNonVisiblePagesUrgentProtectionTime)
 * - chrome/browser/resource_coordinator/tab_lifecycle_unit.cc (discard
 *   mechanics live on the model as discardTabAt/restore-on-focus)
 *
 * Chrome triggers discards on OS memory pressure, which the web platform
 * does not expose reliably. The deterministic equivalent is a budget on the
 * number of loaded (mounted) tabs: when `maxLoadedTabs` is exceeded, the
 * least important tabs are discarded, in exactly Chrome's importance order.
 */

import type { TabStripModel } from './tab-strip-model'
import type { Tab } from './types'

/** Mirrors LifecycleUnitDiscardReason (minus Chrome-internal variants). */
export type DiscardReason = 'proactive' | 'urgent' | 'external'

/** Trimmed CannotDiscardReason (cannot_discard_reason.h). */
export type CannotDiscardReason =
  | 'activeTab'
  | 'alreadyDiscarded'
  | 'optedOut'
  | 'appVeto'
  | 'pinnedTab'
  | 'recentlyActive'

/** Mirrors CanDiscardResult (discard_eligibility_policy.h:56). */
export type CanDiscardResult = 'eligible' | 'protected' | 'disallowed'

export interface CanDiscardDecision {
  result: CanDiscardResult
  reasons: CannotDiscardReason[]
}

export interface TabLifecycleOptions<T> {
  /**
   * Maximum number of tabs whose content stays loaded at once. Exceeding it
   * triggers automatic discarding of the least important tabs. Pass null to
   * disable automatic discarding (manual discardLeastImportant still works).
   * Chrome's equivalent trigger is OS memory pressure.
   */
  maxLoadedTabs?: number | null
  /**
   * Tabs active within this window are protected (not disallowed) from
   * discarding. Mirrors kNonVisiblePagesUrgentProtectionTime, 10 minutes on
   * desktop (discard_eligibility_policy.h:38).
   */
  recentlyActiveProtectionMs?: number
  /**
   * Protect pinned tabs (CannotDiscardReason::kPinnedTab). Protected tabs
   * are only discarded when eligible tabs alone can't satisfy the budget.
   */
  protectPinnedTabs?: boolean
  /**
   * App-level veto, the equivalent of the protections Chrome detects in the
   * renderer (playing audio, form input, user edits, capturing, PiP...).
   * Return false to disallow discarding a tab.
   */
  canDiscardTab?: (tab: Tab<T>) => boolean
  /**
   * Called just before a tab's content is dropped, the equivalent of
   * WebContents::AboutToBeDiscarded. Last chance to snapshot restorable
   * state (scroll position, draft text) into tab.data.
   */
  onBeforeDiscard?: (tab: Tab<T>) => void
  /**
   * Apps whose tab content shares global state per content type (a
   * singleton store per route/scene) can return a key here: at most one
   * non-discarded tab per distinct key stays loaded. Whenever two loaded
   * tabs share a key, every one except the active (else the most recently
   * active) is discarded immediately, and reload-on-focus re-derives each
   * tab's state from its own `data` when it is next activated — shared
   * state can then never bleed between two visible-at-once duplicates.
   * Return null to exempt a tab (e.g. content that isolates correctly).
   *
   * This is a correctness policy, not a memory policy: it overrides the
   * pinned/recently-active protections and the `canDiscardTab` veto (the
   * active tab still always keeps its content). No Chrome equivalent —
   * Chrome tabs never share renderer state.
   */
  exclusiveContentKey?: (tab: Tab<T>) => string | null
}

const DEFAULT_MAX_LOADED_TABS = 10
const DEFAULT_RECENTLY_ACTIVE_PROTECTION_MS = 10 * 60 * 1000

export class TabLifecycleManager<T = unknown> {
  private readonly model_: TabStripModel<T>
  private readonly maxLoadedTabs_: number | null
  private readonly recentlyActiveProtectionMs_: number
  private readonly protectPinnedTabs_: boolean
  private readonly canDiscardTab_: ((tab: Tab<T>) => boolean) | null
  private readonly onBeforeDiscard_: ((tab: Tab<T>) => void) | null
  private readonly exclusiveContentKey_: ((tab: Tab<T>) => string | null) | null
  private detach_: (() => void) | null = null
  private enforcePending_ = false

  constructor(model: TabStripModel<T>, options: TabLifecycleOptions<T> = {}) {
    this.model_ = model
    this.maxLoadedTabs_ = options.maxLoadedTabs === undefined ? DEFAULT_MAX_LOADED_TABS : options.maxLoadedTabs
    this.recentlyActiveProtectionMs_ =
      options.recentlyActiveProtectionMs ?? DEFAULT_RECENTLY_ACTIVE_PROTECTION_MS
    this.protectPinnedTabs_ = options.protectPinnedTabs ?? true
    this.canDiscardTab_ = options.canDiscardTab ?? null
    this.onBeforeDiscard_ = options.onBeforeDiscard ?? null
    this.exclusiveContentKey_ = options.exclusiveContentKey ?? null
  }

  /**
   * Starts observing the model and enforcing the loaded-tab budget. Returns
   * a stop function. Discards run on a microtask after model changes, never
   * re-entrantly (Chrome posts discard tasks for the same reason).
   */
  start(): () => void {
    if (this.detach_) return () => this.stop()
    const schedule = () => this.scheduleEnforce_()
    this.detach_ = this.model_.addObserver({
      onTabStripModelChanged: (change) => {
        // 'replaced' matters for exclusive content keys: a data swap can
        // navigate a tab into a key another loaded tab already holds.
        if (change.type === 'inserted' || change.type === 'selectionOnly' || change.type === 'replaced') {
          schedule()
        }
      },
      onTabChanged: () => schedule(),
      onTabDiscardedStateChanged: (_tab, _index, discarded) => {
        if (!discarded) schedule()
      },
    })
    this.scheduleEnforce_()
    return () => this.stop()
  }

  stop(): void {
    this.detach_?.()
    this.detach_ = null
  }

  /**
   * Tri-state discard eligibility for one tab. Port of
   * DiscardEligibilityPolicy::CanDiscard.
   */
  canDiscard(tab: Tab<T>): CanDiscardDecision {
    const reasons: CannotDiscardReason[] = []
    let result: CanDiscardResult = 'eligible'
    const disallow = (r: CannotDiscardReason) => {
      reasons.push(r)
      result = 'disallowed'
    }
    const protect = (r: CannotDiscardReason) => {
      reasons.push(r)
      if (result === 'eligible') result = 'protected'
    }

    if (tab.discarded) disallow('alreadyDiscarded')
    if (tab === this.model_.activeTab) disallow('activeTab')
    if (!tab.autoDiscardable) disallow('optedOut')
    if (this.canDiscardTab_ && !this.canDiscardTab_(tab)) disallow('appVeto')

    if (this.protectPinnedTabs_ && tab.pinned) protect('pinnedTab')
    if (Date.now() - tab.lastActiveAt < this.recentlyActiveProtectionMs_) {
      protect('recentlyActive')
    }
    return { result, reasons }
  }

  /**
   * Discard candidates in Chrome's importance order, least important first:
   * eligible before protected, each group least-recently-active first,
   * disallowed never. Port of PageNodeSortProxy::operator<
   * (discard_eligibility_policy.h:95) with focused/visible folded into
   * 'activeTab' (a single-window strip has one visible tab).
   */
  getDiscardCandidates(includeProtected: boolean): Array<Tab<T>> {
    const eligible: Array<Tab<T>> = []
    const protectedTabs: Array<Tab<T>> = []
    for (const tab of this.model_.getTabs()) {
      const decision = this.canDiscard(tab)
      if (decision.result === 'eligible') eligible.push(tab)
      else if (decision.result === 'protected') protectedTabs.push(tab)
    }
    const byLeastRecentlyActive = (a: Tab<T>, b: Tab<T>) => a.lastActiveAt - b.lastActiveAt
    eligible.sort(byLeastRecentlyActive)
    protectedTabs.sort(byLeastRecentlyActive)
    return includeProtected ? [...eligible, ...protectedTabs] : eligible
  }

  /**
   * Discards the least important discardable tab. 'urgent' may take
   * protected tabs (Chrome: urgent discarding under memory pressure);
   * 'proactive' and 'external' only take eligible ones. Port of
   * PageDiscardingHelper::DiscardAPage. Returns the discarded tab or null.
   */
  discardLeastImportant(reason: DiscardReason = 'proactive'): Tab<T> | null {
    const candidates = this.getDiscardCandidates(reason === 'urgent')
    const tab = candidates[0]
    if (!tab) return null
    this.discardTab_(tab)
    return tab
  }

  /**
   * Discards tabs until the loaded count fits the budget. Eligible tabs go
   * first; protected tabs are taken only if the budget still isn't met
   * (matching the sort order Chrome walks when reclaiming memory).
   * Disallowed tabs are never discarded, so the budget can be exceeded when
   * everything left is active/opted-out/vetoed.
   */
  enforceBudget(): number {
    if (this.maxLoadedTabs_ === null) return 0
    let discarded = 0
    const overBudget = () => this.model_.loadedTabCount > this.maxLoadedTabs_!
    if (!overBudget()) return 0
    for (const tab of this.getDiscardCandidates(true)) {
      if (!overBudget()) break
      this.discardTab_(tab)
      discarded++
    }
    return discarded
  }

  /**
   * Enforces `exclusiveContentKey`: for every key shared by more than one
   * loaded tab, keep the active tab (else the most recently active) and
   * discard the rest. Returns the number of tabs discarded. Runs before the
   * budget pass, so duplicates count toward freed budget first.
   */
  enforceExclusiveContent(): number {
    if (!this.exclusiveContentKey_) return 0
    const groups = new Map<string, Array<Tab<T>>>()
    for (const tab of this.model_.getTabs()) {
      if (tab.discarded) continue
      const key = this.exclusiveContentKey_(tab)
      if (key === null || key === undefined) continue
      const group = groups.get(key)
      if (group) group.push(tab)
      else groups.set(key, [tab])
    }
    const activeTab = this.model_.activeTab
    let discarded = 0
    for (const tabs of groups.values()) {
      if (tabs.length < 2) continue
      const keep = tabs.includes(activeTab as Tab<T>)
        ? (activeTab as Tab<T>)
        : tabs.reduce((a, b) => (b.lastActiveAt > a.lastActiveAt ? b : a))
      for (const tab of tabs) {
        if (tab === keep) continue
        this.discardTab_(tab)
        discarded++
      }
    }
    return discarded
  }

  private discardTab_(tab: Tab<T>): void {
    const index = this.model_.indexOfTab(tab)
    if (index === -1) return
    this.onBeforeDiscard_?.(tab)
    this.model_.discardTabAt(index)
  }

  private scheduleEnforce_(): void {
    if (this.enforcePending_) return
    this.enforcePending_ = true
    queueMicrotask(() => {
      this.enforcePending_ = false
      if (this.detach_) {
        this.enforceExclusiveContent()
        this.enforceBudget()
      }
    })
  }
}
