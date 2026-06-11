import { describe, expect, it } from 'vitest'
import { TabStripModel } from '../src/core/tab-strip-model'
import type { ReconcileTab, Tab } from '../src/core/types'

function makeModel(entries: Array<{ id: string; data: string; pinned?: boolean }>): TabStripModel<string> {
  const model = new TabStripModel<string>()
  model.reconcile(entries)
  return model
}

const ids = (model: TabStripModel<string>) => model.getTabs().map((t) => t.id)
const want = (id: string, data = id, pinned = false): ReconcileTab<string> => ({ id, data, pinned })

describe('TabStripModel.reconcile (external source-of-truth sync)', () => {
  it('populates an empty strip and first tab becomes active', () => {
    const model = makeModel([want('a'), want('b'), want('c')])
    expect(ids(model)).toEqual(['a', 'b', 'c'])
    expect(model.activeTab?.id).toBe('a')
  })

  it('activates the tab named by activeId', () => {
    const model = makeModel([want('a'), want('b')])
    model.reconcile([want('a'), want('b')], { activeId: 'b' })
    expect(model.activeTab?.id).toBe('b')
  })

  it('is idempotent: a second identical reconcile fires no observer events', () => {
    const model = makeModel([want('a'), want('b')])
    model.reconcile([want('a'), want('b')], { activeId: 'a' })
    const events: string[] = []
    model.addObserver({
      onTabStripModelChanged: (change) => events.push(change.type),
      onTabPinnedStateChanged: () => events.push('pinned'),
    })
    model.reconcile([want('a'), want('b')], { activeId: 'a' })
    expect(events).toEqual([])
  })

  it('inserts missing tabs at their position without stealing activation', () => {
    const model = makeModel([want('a'), want('c')])
    model.reconcile([want('a'), want('b'), want('c')], { activeId: 'a' })
    expect(ids(model)).toEqual(['a', 'b', 'c'])
    expect(model.activeTab?.id).toBe('a')
  })

  it('removes tabs absent from the desired list, even when canCloseTab vetoes', () => {
    const model = new TabStripModel<string>({ canCloseTab: () => false })
    model.reconcile([want('a'), want('b'), want('c')])
    model.reconcile([want('a'), want('c')])
    expect(ids(model)).toEqual(['a', 'c'])
  })

  it('reorders to match the desired list, preserving tab identity', () => {
    const model = makeModel([want('a'), want('b'), want('c')])
    const tabB = model.getTabById('b')
    model.reconcile([want('c'), want('a'), want('b')])
    expect(ids(model)).toEqual(['c', 'a', 'b'])
    expect(model.getTabById('b')).toBe(tabB)
  })

  it('swaps data only when dataEquals reports a change', () => {
    const model = makeModel([want('a', 'one')])
    const replaced: Array<{ oldData: string; newData: string }> = []
    model.addObserver({
      onTabStripModelChanged: (change) => {
        if (change.type === 'replaced') replaced.push({ oldData: change.oldData, newData: change.newData })
      },
    })
    model.reconcile([want('a', 'one')])
    expect(replaced).toEqual([])
    model.reconcile([want('a', 'two')])
    expect(replaced).toEqual([{ oldData: 'one', newData: 'two' }])
    expect(model.getTabById('a')?.data).toBe('two')
  })

  it('supports custom dataEquals for object payloads', () => {
    type Page = { url: string }
    const model = new TabStripModel<Page>()
    model.reconcile([{ id: 'a', data: { url: '/x' } }])
    const tab = model.getTabById('a') as Tab<Page>
    const before = tab.data
    model.reconcile([{ id: 'a', data: { url: '/x' } }], { dataEquals: (x, y) => x.url === y.url })
    expect(tab.data).toBe(before)
    model.reconcile([{ id: 'a', data: { url: '/y' } }], { dataEquals: (x, y) => x.url === y.url })
    expect(tab.data.url).toBe('/y')
  })

  it('converges pinned state: pinned tabs move to the front block', () => {
    const model = makeModel([want('a'), want('b'), want('c')])
    model.reconcile([want('b', 'b', true), want('a'), want('c')])
    expect(ids(model)).toEqual(['b', 'a', 'c'])
    expect(model.getTabById('b')?.pinned).toBe(true)
    model.reconcile([want('a'), want('b'), want('c')])
    expect(model.getTabById('b')?.pinned).toBe(false)
    expect(ids(model)).toEqual(['a', 'b', 'c'])
  })

  it('keeps discarded state across reconciles that do not touch the tab', () => {
    const model = makeModel([want('a'), want('b')])
    model.activateTabAt(0)
    model.discardTabAt(1)
    model.reconcile([want('a'), want('b')], { activeId: 'a' })
    expect(model.getTabById('b')?.discarded).toBe(true)
  })

  it('removing the active tab falls back to the model choice, then activeId wins', () => {
    const model = makeModel([want('a'), want('b'), want('c')])
    model.activateTabAt(1)
    model.reconcile([want('a'), want('c')], { activeId: 'c' })
    expect(ids(model)).toEqual(['a', 'c'])
    expect(model.activeTab?.id).toBe('c')
  })

  it('clears the strip when desired is empty', () => {
    const model = makeModel([want('a'), want('b')])
    model.reconcile([])
    expect(model.count).toBe(0)
    expect(model.activeTab).toBeNull()
  })

  it('throws on duplicate ids in the desired list', () => {
    const model = makeModel([want('a')])
    expect(() => model.reconcile([want('a'), want('a')])).toThrow(/duplicate tab id/)
  })

  it('reconcile-driven activation reports reason "none" so consumers can tell it from user gestures', () => {
    const model = makeModel([want('a'), want('b')])
    const reasons: string[] = []
    model.addObserver({
      onTabStripModelChanged: (_change, selection) => {
        if (selection.activeTabChanged) reasons.push(selection.reason)
      },
    })
    model.reconcile([want('a'), want('b')], { activeId: 'b' })
    expect(reasons).toEqual(['none'])
  })
})
