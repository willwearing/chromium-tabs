import type { MouseEvent, PointerEvent, ReactNode } from 'react'
import type { Tab } from '../core/types'

export interface TabItemProps<T> {
  tab: Tab<T>
  index: number
  active: boolean
  selected: boolean
  dragging: boolean
  groupColor: string | null
  renderContent: (tab: Tab<T>) => ReactNode
  onPointerDown: (event: PointerEvent, tabId: string) => void
  onActivate: (index: number, event: MouseEvent) => void
  onClose: (index: number) => void
  onContextMenu?: (index: number, event: MouseEvent) => void
}

export function TabItem<T>({
  tab,
  index,
  active,
  selected,
  dragging,
  groupColor,
  renderContent,
  onPointerDown,
  onActivate,
  onClose,
  onContextMenu,
}: TabItemProps<T>) {
  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-id={tab.id}
      className={[
        'ctabs-tab',
        active && 'ctabs-tab--active',
        selected && !active && 'ctabs-tab--selected',
        tab.pinned && 'ctabs-tab--pinned',
        tab.discarded && 'ctabs-tab--discarded',
        dragging && 'ctabs-tab--dragging',
        groupColor && 'ctabs-tab--grouped',
      ]
        .filter(Boolean)
        .join(' ')}
      style={groupColor ? { ['--ctabs-group-color' as string]: groupColor } : undefined}
      onPointerDown={(e) => onPointerDown(e, tab.id)}
      onMouseDown={(e) => {
        // Middle click closes, like Chrome.
        if (e.button === 1) {
          e.preventDefault()
          onClose(index)
        }
      }}
      onClick={(e) => onActivate(index, e)}
      onContextMenu={(e) => onContextMenu?.(index, e)}
    >
      <span className="ctabs-tab__content">{renderContent(tab)}</span>
      {!tab.pinned && (
        <button
          type="button"
          className="ctabs-tab__close"
          aria-label="Close tab"
          onClick={(e) => {
            e.stopPropagation()
            onClose(index)
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          ×
        </button>
      )}
    </div>
  )
}
