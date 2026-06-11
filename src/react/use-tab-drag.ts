import { useCallback, useRef, useState, type PointerEvent, type RefObject } from 'react'
import type { TabStripModel } from '../core/tab-strip-model'

const DRAG_THRESHOLD_PX = 4

/**
 * Pointer-based drag-to-reorder. On drag, the hovered insertion position is
 * computed from the midpoints of the rendered tabs and the model's moveTabTo
 * applies Chrome's clamping (pinned boundary) and group-assignment rules.
 */
export function useTabDrag<T>(
  model: TabStripModel<T>,
  containerRef: RefObject<HTMLElement | null>,
): {
  draggingTabId: string | null
  onTabPointerDown: (event: PointerEvent, tabId: string) => void
} {
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const drag = useRef<{ tabId: string; startX: number; started: boolean } | null>(null)

  const onTabPointerDown = useCallback(
    (event: PointerEvent, tabId: string) => {
      if (event.button !== 0) return
      drag.current = { tabId, startX: event.clientX, started: false }
      const target = event.currentTarget as HTMLElement
      target.setPointerCapture(event.pointerId)

      const onMove = (e: globalThis.PointerEvent) => {
        const state = drag.current
        if (!state) return
        if (!state.started) {
          if (Math.abs(e.clientX - state.startX) < DRAG_THRESHOLD_PX) return
          state.started = true
          setDraggingTabId(state.tabId)
        }
        const container = containerRef.current
        if (!container) return

        const tab = model.getTabById(state.tabId)
        if (!tab) return
        const currentIndex = model.indexOfTab(tab)

        // Insertion position: how many other tabs' midpoints are left of the
        // pointer.
        const elements = [...container.querySelectorAll<HTMLElement>('[data-tab-id]')]
        let targetIndex = 0
        for (const el of elements) {
          if (el.dataset['tabId'] === state.tabId) continue
          const rect = el.getBoundingClientRect()
          if (e.clientX > rect.left + rect.width / 2) targetIndex++
        }
        if (targetIndex !== currentIndex) {
          model.moveTabTo(currentIndex, targetIndex)
        }
      }

      const onUp = () => {
        drag.current = null
        setDraggingTabId(null)
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onUp)
        target.removeEventListener('pointercancel', onUp)
      }

      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onUp)
      target.addEventListener('pointercancel', onUp)
    },
    [model, containerRef],
  )

  return { draggingTabId, onTabPointerDown }
}
