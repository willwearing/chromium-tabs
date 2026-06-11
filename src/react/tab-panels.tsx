import { createContext, useContext, type CSSProperties, type ReactNode } from 'react'
import type { TabStripModel } from '../core/tab-strip-model'
import type { Tab } from '../core/types'
import { useTabStrip } from './use-tab-strip'

export type TabVisibility = 'visible' | 'hidden'

const TabVisibilityContext = createContext<TabVisibility>('visible')

/**
 * Visibility of the enclosing tab panel. The React analogue of the page
 * visibility signal Chrome sends background tabs (WasShown/WasHidden): use it
 * to pause polling, animations, or media while the tab is in the background.
 */
export function useTabVisibility(): TabVisibility {
  return useContext(TabVisibilityContext)
}

export interface TabPanelsProps<T> {
  model: TabStripModel<T>
  /** Renders a tab's content. Mounted once, kept alive while hidden. */
  children: (tab: Tab<T>) => ReactNode
  className?: string
  /**
   * Hiding strategy for inactive panels. 'display-none' (default) removes
   * hidden panels from layout. 'visibility' keeps layout (useful when
   * content measures itself and must not collapse to zero size).
   */
  hideMode?: 'display-none' | 'visibility'
}

/**
 * The content host: the React analogue of Chrome keeping background tabs'
 * pages alive. Every non-discarded tab's content stays mounted (component
 * state survives tab switches); only the active tab is visible. Discarded
 * tabs render nothing, and remount fresh when activated, which is exactly
 * Chrome's discard + reload-on-focus lifecycle.
 *
 * Panels are keyed by tab id, so reordering tabs never remounts content.
 */
export function TabPanels<T>({ model, children, className, hideMode = 'display-none' }: TabPanelsProps<T>) {
  const snapshot = useTabStrip(model)

  return (
    <div className={['ctabs-panels', className].filter(Boolean).join(' ')}>
      {snapshot.tabs.map((tab) => {
        if (tab.discarded) return null
        const visible = tab === snapshot.activeTab
        const style: CSSProperties =
          hideMode === 'display-none'
            ? { display: visible ? undefined : 'none' }
            : {
                visibility: visible ? undefined : 'hidden',
                position: visible ? undefined : 'absolute',
                inset: visible ? undefined : 0,
              }
        return (
          <div
            key={tab.id}
            role="tabpanel"
            data-tab-panel-id={tab.id}
            className="ctabs-panel"
            style={style}
          >
            <TabVisibilityContext.Provider value={visible ? 'visible' : 'hidden'}>
              {children(tab)}
            </TabVisibilityContext.Provider>
          </div>
        )
      })}
    </div>
  )
}
