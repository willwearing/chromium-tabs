import { useMemo, useRef, useSyncExternalStore } from 'react'
import type { Tab, TabGroup, TabStripModelOptions } from '../core/types'
import { TabStripModel } from '../core/tab-strip-model'

export interface TabStripSnapshot<T> {
  tabs: ReadonlyArray<Tab<T>>
  activeTab: Tab<T> | null
  activeIndex: number
  selectedIndices: ReadonlyArray<number>
  groups: ReadonlyArray<TabGroup>
}

/** Creates a TabStripModel once for the component's lifetime. */
export function useTabStripModel<T>(
  init?: (model: TabStripModel<T>) => void,
  options?: TabStripModelOptions<T>,
): TabStripModel<T> {
  const ref = useRef<TabStripModel<T> | null>(null)
  if (ref.current === null) {
    ref.current = new TabStripModel<T>(options)
    init?.(ref.current)
  }
  return ref.current
}

/**
 * Subscribes a component to a TabStripModel. Re-renders on any model change
 * (the model batches per-operation, so one operation is one render).
 */
export function useTabStrip<T>(model: TabStripModel<T>): TabStripSnapshot<T> {
  const store = useMemo(() => {
    let version = 0
    let snapshotVersion = -1
    let snapshot: TabStripSnapshot<T> | null = null
    return {
      subscribe(onStoreChange: () => void): () => void {
        return model.addObserver({
          onTabStripModelChanged: () => {
            version++
            onStoreChange()
          },
          onTabPinnedStateChanged: () => {
            version++
            onStoreChange()
          },
          onTabGroupedStateChanged: () => {
            version++
            onStoreChange()
          },
          onTabGroupChanged: () => {
            version++
            onStoreChange()
          },
          onTabChanged: () => {
            version++
            onStoreChange()
          },
          onTabDiscardedStateChanged: () => {
            version++
            onStoreChange()
          },
        })
      },
      getSnapshot(): TabStripSnapshot<T> {
        if (snapshot === null || snapshotVersion !== version) {
          snapshot = {
            tabs: model.getTabs(),
            activeTab: model.activeTab,
            activeIndex: model.activeIndex,
            selectedIndices: model.selectionModel().selectedIndices(),
            groups: model.getGroups(),
          }
          snapshotVersion = version
        }
        return snapshot
      },
    }
  }, [model])

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
