import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TabLifecycleManager } from '../src/core/tab-lifecycle-manager'
import { TabStripModel } from '../src/core/tab-strip-model'
import { TabPanels, useTabVisibility } from '../src/react/tab-panels'
import { Tabs } from '../src/react/tabs'

function makeModel(labels: string[]): TabStripModel<string> {
  const model = new TabStripModel<string>()
  for (const label of labels) model.appendTab(label, false)
  return model
}

const tick = () => act(() => Promise.resolve())

/** Stateful content: a counter that would reset if the component remounted. */
function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0)
  const visibility = useTabVisibility()
  return (
    <button data-testid={`counter-${label}`} data-visibility={visibility} onClick={() => setCount(count + 1)}>
      {label}:{count}
    </button>
  )
}

describe('TabPanels keep-alive (the WebContents equivalent)', () => {
  it('component state survives switching away and back', () => {
    const model = makeModel(['A', 'B'])
    render(<TabPanels model={model}>{(tab) => <Counter label={tab.data} />}</TabPanels>)

    fireEvent.click(screen.getByTestId('counter-A'))
    fireEvent.click(screen.getByTestId('counter-A'))
    expect(screen.getByTestId('counter-A').textContent).toBe('A:2')

    act(() => model.activateTabAt(1))
    act(() => model.activateTabAt(0))
    // No remount: the count is intact.
    expect(screen.getByTestId('counter-A').textContent).toBe('A:2')
  })

  it('only the active panel is visible; hidden panels stay mounted', () => {
    const model = makeModel(['A', 'B'])
    render(<TabPanels model={model}>{(tab) => <Counter label={tab.data} />}</TabPanels>)
    const panels = document.querySelectorAll('.ctabs-panel')
    expect(panels).toHaveLength(2)
    expect((panels[0] as HTMLElement).style.display).not.toBe('none')
    expect((panels[1] as HTMLElement).style.display).toBe('none')
  })

  it('useTabVisibility reports hidden for background tabs (freeze signal)', () => {
    const model = makeModel(['A', 'B'])
    render(<TabPanels model={model}>{(tab) => <Counter label={tab.data} />}</TabPanels>)
    expect(screen.getByTestId('counter-A').dataset['visibility']).toBe('visible')
    expect(screen.getByTestId('counter-B').dataset['visibility']).toBe('hidden')
    act(() => model.activateTabAt(1))
    expect(screen.getByTestId('counter-B').dataset['visibility']).toBe('visible')
  })

  it('reordering tabs does not remount content (keyed by tab id)', () => {
    const model = makeModel(['A', 'B', 'C'])
    render(<TabPanels model={model}>{(tab) => <Counter label={tab.data} />}</TabPanels>)
    fireEvent.click(screen.getByTestId('counter-C'))
    act(() => model.moveTabTo(2, 0))
    expect(screen.getByTestId('counter-C').textContent).toBe('C:1')
  })

  it('discarded tabs unmount; activation remounts fresh (reload-on-focus)', () => {
    const model = makeModel(['A', 'B'])
    render(<TabPanels model={model}>{(tab) => <Counter label={tab.data} />}</TabPanels>)
    fireEvent.click(screen.getByTestId('counter-B'))
    expect(screen.getByTestId('counter-B').textContent).toBe('B:1')

    act(() => void model.discardTabAt(1))
    expect(screen.queryByTestId('counter-B')).toBeNull()

    // Activating restores the tab; content remounts from scratch.
    act(() => model.activateTabAt(1))
    expect(model.isTabDiscarded(1)).toBe(false)
    expect(screen.getByTestId('counter-B').textContent).toBe('B:0')
  })
})

describe('Tabs compound component (the opinionated default)', () => {
  it('strip and keep-alive panels are wired together; state survives switching via strip clicks', () => {
    const model = makeModel(['A', 'B'])
    render(
      <Tabs model={model} renderTab={(t) => t.data}>
        {(tab) => <Counter label={tab.data} />}
      </Tabs>,
    )
    fireEvent.click(screen.getByTestId('counter-A'))
    expect(screen.getByTestId('counter-A').textContent).toBe('A:1')

    // Switch via the rendered strip, not the model, end to end.
    fireEvent.click(screen.getAllByRole('tab')[1]!)
    expect(model.activeTab?.data).toBe('B')
    fireEvent.click(screen.getAllByRole('tab')[0]!)
    expect(screen.getByTestId('counter-A').textContent).toBe('A:1')
  })
})

describe('TabStripModel discard mechanics', () => {
  it('cannot discard the active tab or an already-discarded tab', () => {
    const model = makeModel(['A', 'B'])
    expect(model.discardTabAt(0)).toBe(false)
    expect(model.discardTabAt(1)).toBe(true)
    expect(model.discardTabAt(1)).toBe(false)
  })

  it('keeps the tab in the strip with its data (title survives)', () => {
    const model = makeModel(['A', 'B'])
    model.discardTabAt(1)
    expect(model.count).toBe(2)
    expect(model.getTabAt(1).data).toBe('B')
    expect(model.isTabDiscarded(1)).toBe(true)
  })

  it('notifies onTabDiscardedStateChanged both ways', () => {
    const events: string[] = []
    const model = makeModel(['A', 'B'])
    model.addObserver({
      onTabDiscardedStateChanged: (tab, _i, discarded) => events.push(`${tab.data}:${discarded}`),
    })
    model.discardTabAt(1)
    model.activateTabAt(1)
    expect(events).toEqual(['B:true', 'B:false'])
  })

  it('tracks lastActiveAt: Infinity while active, timestamp after blur', () => {
    const model = makeModel(['A', 'B'])
    expect(model.getTabAt(0).lastActiveAt).toBe(Infinity)
    model.activateTabAt(1)
    expect(model.getTabAt(0).lastActiveAt).toBeLessThanOrEqual(Date.now())
    expect(model.getTabAt(1).lastActiveAt).toBe(Infinity)
  })
})

describe('TabLifecycleManager (TabManager / eligibility policy port)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeAgedModel(labels: string[]): TabStripModel<string> {
    // Activate each tab in order with time passing, so lastActiveAt encodes
    // the activation order: earlier labels are least recently used.
    const model = makeModel(labels)
    for (let i = 0; i < labels.length; i++) {
      model.activateTabAt(i)
      vi.advanceTimersByTime(60_000)
    }
    return model
  }

  it('discards least-recently-active eligible tabs first', () => {
    const model = makeAgedModel(['A', 'B', 'C', 'D'])
    const lifecycle = new TabLifecycleManager(model, { recentlyActiveProtectionMs: 0 })
    const first = lifecycle.discardLeastImportant()
    expect(first?.data).toBe('A')
    const second = lifecycle.discardLeastImportant()
    expect(second?.data).toBe('B')
  })

  it('never discards the active tab even under urgent pressure', () => {
    const model = makeAgedModel(['A', 'B'])
    model.activateTabAt(0)
    const lifecycle = new TabLifecycleManager(model, { recentlyActiveProtectionMs: 0 })
    lifecycle.discardLeastImportant('urgent')
    lifecycle.discardLeastImportant('urgent')
    expect(model.isTabDiscarded(0)).toBe(false)
    expect(model.isTabDiscarded(1)).toBe(true)
  })

  it('recently active tabs are protected from proactive but not urgent discards', () => {
    const model = makeAgedModel(['A', 'B', 'C'])
    model.activateTabAt(2)
    // A and B were last active 2-3 minutes ago, inside the 10 min window.
    const lifecycle = new TabLifecycleManager(model)
    expect(lifecycle.discardLeastImportant('proactive')).toBeNull()
    expect(lifecycle.discardLeastImportant('urgent')?.data).toBe('A')
  })

  it('pinned tabs are protected: taken only after eligible tabs', () => {
    const model = makeAgedModel(['A', 'B', 'C'])
    model.setTabPinned(0, true)
    model.activateTabAt(2)
    const lifecycle = new TabLifecycleManager(model, { recentlyActiveProtectionMs: 0 })
    expect(lifecycle.discardLeastImportant('urgent')?.data).toBe('B')
    expect(lifecycle.discardLeastImportant('urgent')?.data).toBe('A')
  })

  it('app veto (canDiscardTab) disallows discarding entirely', () => {
    const model = makeAgedModel(['A', 'B', 'C'])
    model.activateTabAt(2)
    const lifecycle = new TabLifecycleManager(model, {
      recentlyActiveProtectionMs: 0,
      canDiscardTab: (tab) => tab.data !== 'A',
    })
    expect(lifecycle.discardLeastImportant('urgent')?.data).toBe('B')
    expect(lifecycle.discardLeastImportant('urgent')).toBeNull()
    expect(model.isTabDiscarded(model.indexOfTab(model.getTabById(model.getTabs()[0]!.id)!))).toBe(false)
  })

  it('setTabAutoDiscardable(false) opts a tab out', () => {
    const model = makeAgedModel(['A', 'B', 'C'])
    model.activateTabAt(2)
    model.setTabAutoDiscardable(0, false)
    const lifecycle = new TabLifecycleManager(model, { recentlyActiveProtectionMs: 0 })
    expect(lifecycle.discardLeastImportant()?.data).toBe('B')
    expect(lifecycle.discardLeastImportant()).toBeNull()
  })

  it('enforceBudget discards down to maxLoadedTabs, LRU first', () => {
    const model = makeAgedModel(['A', 'B', 'C', 'D', 'E'])
    const lifecycle = new TabLifecycleManager(model, {
      maxLoadedTabs: 2,
      recentlyActiveProtectionMs: 0,
    })
    const discarded = lifecycle.enforceBudget()
    expect(discarded).toBe(3)
    expect(model.loadedTabCount).toBe(2)
    expect(model.getTabs().map((t) => `${t.data}:${t.discarded ? 'd' : 'l'}`)).toEqual([
      'A:d',
      'B:d',
      'C:d',
      'D:l',
      'E:l',
    ])
  })

  it('onBeforeDiscard fires before content is dropped (snapshot hook)', () => {
    const model = makeAgedModel(['A', 'B'])
    model.activateTabAt(1)
    const seen: Array<{ data: string; discardedAtCall: boolean }> = []
    const lifecycle = new TabLifecycleManager(model, {
      recentlyActiveProtectionMs: 0,
      onBeforeDiscard: (tab) => seen.push({ data: tab.data, discardedAtCall: tab.discarded }),
    })
    lifecycle.discardLeastImportant()
    expect(seen).toEqual([{ data: 'A', discardedAtCall: false }])
  })

  it('started manager auto-enforces the budget when tabs are added', async () => {
    vi.useRealTimers()
    const model = makeModel(['A', 'B'])
    model.activateTabAt(1)
    const lifecycle = new TabLifecycleManager(model, {
      maxLoadedTabs: 2,
      recentlyActiveProtectionMs: 0,
    })
    const stop = lifecycle.start()
    model.appendTab('C', true)
    await Promise.resolve()
    expect(model.loadedTabCount).toBe(2)
    expect(model.getTabs().filter((t) => t.discarded).map((t) => t.data)).toEqual(['A'])
    stop()
  })

  it('integration: budget + panels = bounded mounted content, state intact within budget', async () => {
    const model = makeModel(['A', 'B', 'C'])
    model.activateTabAt(0)
    const lifecycle = new TabLifecycleManager(model, {
      maxLoadedTabs: 2,
      recentlyActiveProtectionMs: 0,
    })
    render(<TabPanels model={model}>{(tab) => <Counter label={tab.data} />}</TabPanels>)
    fireEvent.click(screen.getByTestId('counter-A'))

    const stop = lifecycle.start()
    // Activate B then C; the budget of 2 forces the LRU tab out.
    act(() => model.activateTabAt(1))
    await tick()
    act(() => model.activateTabAt(2))
    await tick()

    expect(model.loadedTabCount).toBe(2)
    expect(document.querySelectorAll('.ctabs-panel')).toHaveLength(2)
    // A (least recently used) was discarded and unmounted.
    expect(screen.queryByTestId('counter-A')).toBeNull()

    // Activating A restores it, fresh content, still within budget.
    act(() => model.activateTabAt(0))
    await tick()
    expect(screen.getByTestId('counter-A').textContent).toBe('A:0')
    expect(model.loadedTabCount).toBe(2)
    stop()
  })
})
