import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TabStripModel } from '../src/core/tab-strip-model'
import { TabStrip } from '../src/react/tab-strip'
import { useTabStrip } from '../src/react/use-tab-strip'

function makeModel(labels: string[]): TabStripModel<string> {
  const model = new TabStripModel<string>()
  for (const label of labels) model.appendTab(label, false)
  return model
}

function ActiveLabel({ model }: { model: TabStripModel<string> }) {
  const snapshot = useTabStrip(model)
  return <span data-testid="active">{snapshot.activeTab?.data ?? 'none'}</span>
}

describe('useTabStrip', () => {
  it('re-renders when the model changes', () => {
    const model = makeModel(['A', 'B'])
    render(<ActiveLabel model={model} />)
    expect(screen.getByTestId('active').textContent).toBe('A')
    act(() => model.activateTabAt(1))
    expect(screen.getByTestId('active').textContent).toBe('B')
    act(() => model.closeTabAt(1))
    expect(screen.getByTestId('active').textContent).toBe('A')
  })
})

describe('TabStrip', () => {
  it('renders tabs and marks the active one', () => {
    const model = makeModel(['A', 'B', 'C'])
    render(<TabStrip model={model} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
  })

  it('click activates a tab', () => {
    const model = makeModel(['A', 'B'])
    render(<TabStrip model={model} />)
    fireEvent.click(screen.getAllByRole('tab')[1]!)
    expect(model.activeTab?.data).toBe('B')
  })

  it('close button closes the tab', () => {
    const model = makeModel(['A', 'B'])
    render(<TabStrip model={model} />)
    fireEvent.click(screen.getAllByLabelText('Close tab')[0]!)
    expect(model.getTabs().map((t) => t.data)).toEqual(['B'])
  })

  it('middle click closes the tab', () => {
    const model = makeModel(['A', 'B'])
    render(<TabStrip model={model} />)
    fireEvent.mouseDown(screen.getAllByRole('tab')[0]!, { button: 1 })
    expect(model.getTabs().map((t) => t.data)).toEqual(['B'])
  })

  it('ctrl-click toggles selection', () => {
    const model = makeModel(['A', 'B', 'C'])
    model.activateTabAt(0)
    render(<TabStrip model={model} />)
    fireEvent.click(screen.getAllByRole('tab')[2]!, { ctrlKey: true })
    expect(model.selectionModel().selectedIndices()).toEqual([0, 2])
  })

  it('shift-click extends the selection from the anchor', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    model.activateTabAt(0)
    render(<TabStrip model={model} />)
    fireEvent.click(screen.getAllByRole('tab')[2]!, { shiftKey: true })
    expect(model.selectionModel().selectedIndices()).toEqual([0, 1, 2])
  })

  it('arrow keys change the active tab; ctrl+arrows move it', () => {
    const model = makeModel(['A', 'B', 'C'])
    model.activateTabAt(0)
    render(<TabStrip model={model} />)
    const strip = screen.getByRole('tablist')
    fireEvent.keyDown(strip, { key: 'ArrowRight' })
    expect(model.activeTab?.data).toBe('B')
    fireEvent.keyDown(strip, { key: 'ArrowRight', ctrlKey: true })
    expect(model.getTabs().map((t) => t.data)).toEqual(['A', 'C', 'B'])
  })

  it('collapsed group tabs are hidden, header still shown', () => {
    const model = makeModel(['A', 'B', 'C'])
    const group = model.addToNewGroup([1, 2])
    model.updateGroupVisuals(group, { title: 'work' })
    model.setGroupCollapsed(group, true)
    render(<TabStrip model={model} />)
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByText('work')).toBeTruthy()
  })

  it('new tab button calls the handler', () => {
    const model = makeModel(['A'])
    let calls = 0
    render(<TabStrip model={model} onNewTab={() => calls++} />)
    fireEvent.click(screen.getByLabelText('New tab'))
    expect(calls).toBe(1)
  })
})
