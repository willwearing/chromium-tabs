import type { MouseEvent, ReactNode } from 'react'
import type { TabStripModel } from '../core/tab-strip-model'
import type { Tab } from '../core/types'
import { TabPanels } from './tab-panels'
import { TabStrip } from './tab-strip'

export interface TabsProps<T> {
  model: TabStripModel<T>
  /** Renders a tab's strip label. Defaults to String(tab.data). */
  renderTab?: (tab: Tab<T>) => ReactNode
  /**
   * Renders a tab's content. Hosted in TabPanels: mounted once, kept alive
   * while the tab is in the background, unmounted only on discard.
   */
  children: (tab: Tab<T>) => ReactNode
  onNewTab?: () => void
  onTabContextMenu?: (index: number, event: MouseEvent) => void
  /** Panel hiding strategy, see TabPanels. */
  hideMode?: 'display-none' | 'visibility'
  className?: string
}

/**
 * The batteries-included layout: strip on top, keep-alive content below.
 * This is the recommended entry point — content state survives tab switches
 * by construction, because the panels host every loaded tab's tree like
 * Chrome keeps background pages alive.
 *
 * Use the composable pieces (TabStrip, TabPanels) directly only when you
 * need a custom layout, and keep content inside TabPanels unless you
 * specifically want remount-on-switch semantics.
 */
export function Tabs<T>({
  model,
  renderTab,
  children,
  onNewTab,
  onTabContextMenu,
  hideMode,
  className,
}: TabsProps<T>) {
  return (
    <div className={['ctabs', className].filter(Boolean).join(' ')}>
      <TabStrip
        model={model}
        renderTab={renderTab}
        onNewTab={onNewTab}
        onTabContextMenu={onTabContextMenu}
      />
      <TabPanels model={model} hideMode={hideMode}>
        {children}
      </TabPanels>
    </div>
  )
}
