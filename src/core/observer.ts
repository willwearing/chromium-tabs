/**
 * Observer event types. Ported from
 * chromium-reference/chrome/browser/ui/tabs/tab_strip_model_observer.h.
 *
 * Changes to (1) the selection model, (2) the active tab, and (3) the set of
 * tabs are bundled into a single onTabStripModelChanged call because the
 * first two consist of indices into the list determined by the third.
 */

import type { ListSelectionModel } from './list-selection-model'
import type { Tab, TabGroupId, TabGroupVisualData } from './types'

/** Mirrors TabStripModelChange::Type. */
export type TabStripModelChange<T> =
  | { type: 'selectionOnly' }
  | {
      /**
       * Tabs were inserted at the given indices (index is the position at the
       * time of that insertion, see tab_strip_model_observer.h:88).
       */
      type: 'inserted'
      contents: Array<{ tab: Tab<T>; index: number }>
    }
  | {
      /**
       * Tabs were removed; index is the position at the time of that removal
       * (tab_strip_model_observer.h:123).
       */
      type: 'removed'
      contents: Array<{ tab: Tab<T>; index: number }>
    }
  | { type: 'moved'; tab: Tab<T>; fromIndex: number; toIndex: number }
  | { type: 'replaced'; tab: Tab<T>; oldData: T; newData: T; index: number }

/** Mirrors TabStripSelectionChange. */
export interface TabStripSelectionChange<T> {
  oldTab: Tab<T> | null
  newTab: Tab<T> | null
  oldModel: ListSelectionModel
  newModel: ListSelectionModel
  /** Mirrors TabStripModelObserver::CHANGE_REASON_USER_GESTURE. */
  reason: 'none' | 'userGesture'
  get activeTabChanged(): boolean
  get selectionChanged(): boolean
}

/** Mirrors TabGroupChange::Type (minus editor-UI concerns). */
export type TabGroupChange =
  | { type: 'created'; groupId: TabGroupId }
  | {
      type: 'visualsChanged'
      groupId: TabGroupId
      oldVisuals: TabGroupVisualData
      newVisuals: TabGroupVisualData
    }
  | { type: 'moved'; groupId: TabGroupId }
  | { type: 'closed'; groupId: TabGroupId }

export type CloseAllStoppedReason = 'completed' | 'canceled'

/**
 * Observer interface. All methods optional — implement what you need.
 * Mirrors TabStripModelObserver.
 */
export interface TabStripModelObserver<T> {
  onTabStripModelChanged?(
    change: TabStripModelChange<T>,
    selection: TabStripSelectionChange<T>,
  ): void

  /** A tab's pinned state changed. Fired after any accompanying move. */
  onTabPinnedStateChanged?(tab: Tab<T>, index: number): void

  /** A tab entered or left a group. */
  onTabGroupedStateChanged?(
    oldGroup: TabGroupId | null,
    newGroup: TabGroupId | null,
    tab: Tab<T>,
    index: number,
  ): void

  /** Group lifecycle and visual changes. */
  onTabGroupChanged?(change: TabGroupChange): void

  /** A tab's data payload or blocked state changed in place. */
  onTabChanged?(tab: Tab<T>, index: number): void

  /**
   * A tab was discarded (content dropped to save memory) or restored.
   * Mirrors TabLifecycleObserver::OnDiscardedStateChange.
   */
  onTabDiscardedStateChanged?(tab: Tab<T>, index: number, discarded: boolean): void

  /** A close was vetoed by canCloseTab. */
  onTabCloseCancelled?(tab: Tab<T>): void

  /** CloseAllTabs is starting. */
  willCloseAllTabs?(): void

  /** CloseAllTabs finished or was canceled by a veto. */
  closeAllTabsStopped?(reason: CloseAllStoppedReason): void
}
