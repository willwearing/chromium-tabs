import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { TabStripModel } from '../core/tab-strip-model'
import type { Tab } from '../core/types'
import { GroupHeader, GROUP_COLOR_VALUES } from './group-header'
import { TabItem } from './tab-item'
import { useTabDrag } from './use-tab-drag'
import { useTabStrip } from './use-tab-strip'

export interface TabStripProps<T> {
  model: TabStripModel<T>
  /** Renders a tab's content. Defaults to String(tab.data). */
  renderTab?: (tab: Tab<T>) => ReactNode
  /** Shows the new-tab button and handles clicks on it. */
  onNewTab?: () => void
  onTabContextMenu?: (index: number, event: MouseEvent) => void
  className?: string
}

/**
 * A Chrome-style tab strip bound to a TabStripModel. Click activates,
 * ctrl/cmd-click toggles selection, shift-click extends from the anchor,
 * middle-click closes, dragging reorders, arrow keys switch tabs and
 * ctrl/cmd+arrows move the active tab (hopping group boundaries like Chrome).
 */
export function TabStrip<T>({
  model,
  renderTab = (tab) => String(tab.data),
  onNewTab,
  onTabContextMenu,
  className,
}: TabStripProps<T>) {
  const snapshot = useTabStrip(model)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const { draggingTabId, onTabPointerDown } = useTabDrag(model, containerRef)

  const onActivate = (index: number, event: MouseEvent) => {
    if (event.shiftKey) {
      model.extendSelectionTo(index)
    } else if (event.metaKey || event.ctrlKey) {
      if (model.isTabSelected(index)) model.deselectTabAt(index)
      else model.selectTabAt(index)
    } else {
      model.activateTabAt(index, { userGesture: true })
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const move = event.metaKey || event.ctrlKey
    if (event.key === 'ArrowRight') {
      move ? model.moveTabNext() : model.selectNextTab({ userGesture: true })
      event.preventDefault()
    } else if (event.key === 'ArrowLeft') {
      move ? model.moveTabPrevious() : model.selectPreviousTab({ userGesture: true })
      event.preventDefault()
    }
  }

  const selected = new Set(snapshot.selectedIndices)
  const groupById = new Map(snapshot.groups.map((g) => [g.id, g]))
  const items: ReactNode[] = []
  let previousGroup: string | null = null

  snapshot.tabs.forEach((tab, index) => {
    if (tab.group !== null && tab.group !== previousGroup) {
      const group = groupById.get(tab.group)
      if (group) {
        items.push(
          <GroupHeader
            key={`group-${group.id}`}
            group={group}
            onToggleCollapsed={(id) => model.setGroupCollapsed(id, !model.isGroupCollapsed(id))}
          />,
        )
      }
    }
    previousGroup = tab.group

    if (tab.group !== null && model.isGroupCollapsed(tab.group)) return

    const groupColor = tab.group
      ? (GROUP_COLOR_VALUES[groupById.get(tab.group)?.visualData.color ?? 'grey'] ?? null)
      : null

    items.push(
      <TabItem
        key={tab.id}
        tab={tab}
        index={index}
        active={index === snapshot.activeIndex}
        selected={selected.has(index)}
        dragging={tab.id === draggingTabId}
        groupColor={groupColor}
        renderContent={renderTab}
        onPointerDown={onTabPointerDown}
        onActivate={onActivate}
        onClose={(i) => model.closeTabAt(i)}
        onContextMenu={onTabContextMenu}
      />,
    )
  })

  return (
    <div
      ref={containerRef}
      role="tablist"
      tabIndex={0}
      className={['ctabs-strip', className].filter(Boolean).join(' ')}
      onKeyDown={onKeyDown}
    >
      {items}
      {onNewTab && (
        <button
          type="button"
          className="ctabs-new-tab"
          aria-label="New tab"
          onClick={onNewTab}
        >
          +
        </button>
      )}
    </div>
  )
}
