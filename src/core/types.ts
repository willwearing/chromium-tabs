/**
 * Core types. Ported from chromium-reference/chrome/browser/ui/tabs/tab_enums.h
 * and the supporting types in tab_strip_model.h.
 *
 * Chrome's tabs carry a WebContents. This library carries a generic `data: T`
 * payload instead so it works for any application.
 */

/** Sentinel for "no tab" — mirrors TabStripModel::kNoTab. */
export const NO_TAB = -1

export type TabId = string
export type TabGroupId = string

/**
 * How a tab is being opened. Trimmed from ui::PageTransition to the two
 * qualities the TabStripModel actually branches on (tab_strip_model.cc:1731,
 * 1786): link-like openings (inherit opener, insert adjacent) and typed/manual
 * openings (append at end, transient opener at end-of-strip).
 */
export type TabOpenCause = 'link' | 'typed' | 'other'

/** Bitmask flags used when adding tabs. Mirrors AddTabTypes (tab_enums.h:42). */
export const AddTabFlags = {
  NONE: 0,
  /** The tab should become the active tab. */
  ACTIVE: 1 << 0,
  /** The tab should be pinned. */
  PINNED: 1 << 1,
  /**
   * Use the caller-supplied index rather than letting the model determine
   * the position from the open cause and opener relationships.
   */
  FORCE_INDEX: 1 << 2,
  /** Set the new tab's opener to the currently active tab. */
  INHERIT_OPENER: 1 << 3,
} as const

/** Bitmask flags used when closing tabs. Mirrors TabCloseTypes (tab_enums.h:26). */
export const CloseTabFlags = {
  NONE: 0,
  /** The close was triggered directly by a user gesture. */
  USER_GESTURE: 1 << 0,
} as const

/**
 * Visual data attached to a tab group. Mirrors tab_groups::TabGroupVisualData.
 * Chrome cycles through 9 named colors; we keep the names so UIs can map them
 * to whatever palette they like.
 */
export type TabGroupColor =
  | 'grey'
  | 'blue'
  | 'red'
  | 'yellow'
  | 'green'
  | 'pink'
  | 'purple'
  | 'cyan'
  | 'orange'

export const TAB_GROUP_COLORS: readonly TabGroupColor[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]

export interface TabGroupVisualData {
  title: string
  color: TabGroupColor
  isCollapsed: boolean
}

/**
 * A tab in the strip. Identity is the object (like Chrome's TabModel pointer);
 * `id` exists for React keys and serialization.
 */
export interface Tab<T = unknown> {
  readonly id: TabId
  /** Application payload (your "WebContents"). */
  data: T
  /** The tab that opened this tab, if tracked. Mirrors TabModel::opener(). */
  opener: Tab<T> | null
  /**
   * When true, the opener relationship is cleared the next time the active
   * tab changes. Set for typed new-tabs at end of strip ("quick look-up"
   * pattern, tab_strip_model.cc:1804-1810).
   */
  resetOpenerOnActiveTabChange: boolean
  /** Pinned tabs are locked to the left side of the strip. */
  pinned: boolean
  /** Group membership, if any. Pinned tabs are never grouped. */
  group: TabGroupId | null
  /** Blocked by a modal — selectable but flagged. Mirrors TabModel::blocked. */
  blocked: boolean
  /**
   * True when the tab's content has been dropped to save memory. The tab
   * stays in the strip (title intact via `data`); content remounts fresh
   * when the tab is next activated. Mirrors TabLifecycleUnit::is_discarded_
   * (tab_lifecycle_unit.cc:312) and WebContents::WasDiscarded.
   */
  discarded: boolean
  /**
   * Wall-clock ms of the last time this tab stopped being active, or
   * Infinity while it is active. Used for least-recently-used discard
   * ordering. Mirrors last_focused_time_ (tab_lifecycle_unit.cc:142, which
   * uses Time::Max() while focused).
   */
  lastActiveAt: number
  /**
   * Per-tab opt-out from automatic discarding. Mirrors
   * TabLifecycleUnit::auto_discardable_ (the extensions setAutoDiscardable
   * API surface).
   */
  autoDiscardable: boolean
}

export interface TabGroup {
  readonly id: TabGroupId
  visualData: TabGroupVisualData
}

/** Options for TabStripModel.addTab / insertTabAt. */
export interface AddTabOptions {
  /** Target index. Omit (or pass NO_TAB) to let the model decide. */
  index?: number
  /** What kind of action opened this tab. Default 'other'. */
  cause?: TabOpenCause
  /** Bitmask of AddTabFlags. */
  flags?: number
  /** Insert directly into an existing group. */
  group?: TabGroupId
  /** Stable id; generated if omitted. */
  id?: TabId
}

/** Desired state of one tab, for TabStripModel.reconcile. */
export interface ReconcileTab<T> {
  id: TabId
  data: T
  /** Defaults to false. The list should be pinned-first-consistent. */
  pinned?: boolean
}

export interface ReconcileOptions<T> {
  /** Tab to end up active. Omit to leave activation to the model. */
  activeId?: TabId | null
  /** Equality for data payloads; defaults to Object.is. */
  dataEquals?: (a: T, b: T) => boolean
}

export interface TabStripModelOptions<T> {
  /**
   * Veto tab closes (Chrome: IsTabClosable / policy). Return false to keep
   * the tab open; observers get a tabCloseCancelled event.
   */
  canCloseTab?: (tab: Tab<T>) => boolean
  /** Disable the group feature entirely (Chrome: null TabGroupModelFactory). */
  supportsGroups?: boolean
  /** Custom id generator for tabs and groups. */
  generateId?: () => string
}
