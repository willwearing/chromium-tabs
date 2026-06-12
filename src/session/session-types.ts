/**
 * Session snapshot types. Ported from
 * chromium-reference/components/sessions/core/session_types.h and
 * serialized_navigation_entry.h.
 *
 * These are the plain-data structures produced by replaying a command log
 * (restoreSessionFromCommands) and consumed by session restore. Chrome's
 * SessionTab carries WebContents-specific state (user agent overrides,
 * extension app ids, session storage ids); this port carries the library's
 * generic `data` payload instead, plus the same extra-data escape hatch.
 */

import type { TabGroupId, TabGroupVisualData, TabId } from '../core/types'

/**
 * Identifies a window (one TabStripModel) within a session. Chrome uses
 * monotonic int32 SessionIDs (session_id.h); this port uses caller-supplied
 * strings so ids stay stable across process restarts.
 */
export type SessionWindowId = string

export const DEFAULT_WINDOW_ID: SessionWindowId = 'window-1'

/**
 * One entry in a tab's navigation history. Trimmed from
 * SerializedNavigationEntry (serialized_navigation_entry.h:88): we keep the
 * fields a headless tab strip can act on. `state` is the analog of Chrome's
 * encoded_page_state — an opaque app-defined blob (scroll position, form
 * state, …) that must be JSON-serializable.
 */
export interface SerializedNavigationEntry {
  /**
   * Position in the tab's navigation list. Like Chrome's
   * SerializedNavigationEntry::index_, values may have gaps after pruning;
   * order is what matters.
   */
  index: number
  url: string
  title?: string
  /** Opaque app state for this entry (encoded_page_state analog). */
  state?: unknown
  /** Wall-clock ms when the entry was created/updated. */
  timestamp?: number
}

/** Mirrors SessionTab (session_types.h:34), adapted to this library. */
export interface SessionTab {
  tabId: TabId
  windowId: SessionWindowId
  /**
   * Visual position in the window. Mirrors tab_visual_index. May contain
   * gaps (closed tabs leave holes); restore sorts by it.
   */
  visualIndex: number
  pinned: boolean
  groupId: TabGroupId | null
  /**
   * Serialized tab data payload (the result of serializeTabData). This is
   * where your url lives if you don't use navigation tracking. Analog of
   * kCommandSetTabData's key/value map, generalized to one JSON value.
   */
  data: unknown
  /** Navigation history, sorted ascending by entry index. */
  navigations: SerializedNavigationEntry[]
  /**
   * While rebuilding this is a navigation *index value*; after
   * restoreSessionFromCommands completes it has been remapped to a position
   * in `navigations` (AddTabsToWindows, session_service_commands.cc:404), or
   * -1 when there are no navigations.
   */
  currentNavigationIndex: number
  /** Wall-clock ms the tab was last active, if recorded. */
  lastActiveTime?: number
  /** App-defined string map (kCommandAddTabExtraData). */
  extraData: Record<string, string>
}

/** Mirrors SessionTabGroup (session_types.h:103). */
export interface SessionTabGroup {
  groupId: TabGroupId
  visualData: TabGroupVisualData
}

/** Mirrors SessionWindow (session_types.h:120), minus desktop geometry. */
export interface SessionWindow {
  windowId: SessionWindowId
  /**
   * While rebuilding this is the selected tab's *visual index*; after
   * restoreSessionFromCommands completes it has been remapped to a position
   * in `tabs` (UpdateSelectedTabIndex, session_service_commands.cc:265).
   */
  selectedTabIndex: number
  /** Tabs sorted by visual order (SortTabsBasedOnVisualOrderAndClear). */
  tabs: SessionTab[]
  /** Groups referenced by this window's tabs. */
  tabGroups: SessionTabGroup[]
  /** App-defined string map (kCommandAddWindowExtraData). */
  extraData: Record<string, string>
}

/** The result of reading back a persisted session. */
export interface SessionSnapshot {
  /** Windows with at least one restorable tab, in stable windowId order. */
  windows: SessionWindow[]
  activeWindowId: SessionWindowId | null
  /**
   * True when the log was truncated, corrupted, or contained an unknown
   * command. Mirrors ReadCommandsResult::error_reading — whatever was
   * readable is still returned (the rebuild is fault-tolerant).
   */
  errorReading: boolean
}

/**
 * The selected navigation entry of a restored tab, or null when the tab was
 * persisted without navigation tracking. Convenience over
 * normalized_navigation_index() (session_types.h:62).
 */
export function currentNavigationEntry(
  tab: SessionTab,
): SerializedNavigationEntry | null {
  if (tab.navigations.length === 0) return null
  const i = Math.max(0, Math.min(tab.currentNavigationIndex, tab.navigations.length - 1))
  return tab.navigations[i]!
}
