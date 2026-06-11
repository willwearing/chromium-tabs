import { describe, expect, it, vi } from 'vitest'
import { TabStripModel } from '../src/core/tab-strip-model'
import { AddTabFlags } from '../src/core/types'

// Scenario shapes mirror chrome/browser/ui/tabs/tab_strip_model_unittest.cc.
// Tabs carry string payloads; state assertions use the payload sequence.

function strip(model: TabStripModel<string>): string {
  return model
    .getTabs()
    .map((t) => {
      let s = t.data
      if (t.pinned) s += 'p'
      if (t.group) s += `(${t.group})`
      return s
    })
    .join(' ')
}

function makeModel(labels: string[], options = {}): TabStripModel<string> {
  const model = new TabStripModel<string>(options)
  for (const label of labels) model.appendTab(label, false)
  return model
}

describe('adding tabs', () => {
  it('first tab becomes active even when added in background', () => {
    const model = new TabStripModel<string>()
    model.appendTab('A', false)
    expect(model.activeIndex).toBe(0)
  })

  it('appendTab foreground activates, background does not', () => {
    const model = makeModel(['A', 'B'])
    model.activateTabAt(0)
    model.appendTab('C', false)
    expect(model.activeIndex).toBe(0)
    model.appendTab('D', true)
    expect(model.activeTab?.data).toBe('D')
  })

  it('link-opened foreground tab inserts adjacent to the opener', () => {
    const model = makeModel(['A', 'B', 'C'])
    model.activateTabAt(0)
    model.addTab('child', { cause: 'link', flags: AddTabFlags.ACTIVE })
    expect(strip(model)).toBe('A child B C')
    expect(model.getTabAt(1).opener?.data).toBe('A')
  })

  it('link-opened background tabs stack after the last tab the opener opened', () => {
    const model = makeModel(['A', 'B'])
    model.activateTabAt(0)
    model.addTab('c1', { cause: 'link' })
    model.addTab('c2', { cause: 'link' })
    // c2 goes after c1 (both opened by A), not directly after A.
    expect(strip(model)).toBe('A c1 c2 B')
  })

  it('typed tabs open at the end of the strip', () => {
    const model = makeModel(['A', 'B'])
    model.activateTabAt(0)
    model.addTab('new', { cause: 'typed', flags: AddTabFlags.ACTIVE })
    expect(strip(model)).toBe('A B new')
  })

  it('insertTabAt clamps unpinned inserts to after the pinned block', () => {
    const model = makeModel(['A', 'B'])
    model.setTabPinned(0, true)
    model.insertTabAt(0, 'X')
    expect(strip(model)).toBe('Ap X B')
  })

  it('insertTabAt keeps pinned inserts inside the pinned block', () => {
    const model = makeModel(['A', 'B'])
    model.setTabPinned(0, true)
    model.insertTabAt(2, 'X', { flags: AddTabFlags.PINNED })
    expect(strip(model)).toBe('Ap Xp B')
  })
})

describe('selection after closing the active tab', () => {
  it('prefers a tab the closing tab opened', () => {
    const model = makeModel(['A', 'B'])
    model.activateTabAt(0)
    model.addTab('child', { cause: 'link', flags: AddTabFlags.ACTIVE })
    model.activateTabAt(0, { userGesture: false })
    model.closeTabAt(0)
    expect(model.activeTab?.data).toBe('child')
  })

  it('falls back to the opener when the closing tab has no children', () => {
    const model = makeModel(['A', 'B', 'C'])
    model.activateTabAt(2)
    model.addTab('child', { cause: 'link', flags: AddTabFlags.ACTIVE })
    model.closeTabAt(model.activeIndex)
    expect(model.activeTab?.data).toBe('C')
  })

  it('without opener relationships, activates the tab after the closed one', () => {
    const model = makeModel(['A', 'B', 'C'])
    model.activateTabAt(1)
    model.closeTabAt(1)
    expect(model.activeTab?.data).toBe('C')
  })

  it('closing the last tab in the strip activates the new last tab', () => {
    const model = makeModel(['A', 'B', 'C'])
    model.activateTabAt(2)
    model.closeTabAt(2)
    expect(model.activeTab?.data).toBe('B')
  })

  it('typed new-tab-at-end returns to the previous tab when closed', () => {
    const model = makeModel(['A', 'B'])
    model.activateTabAt(0)
    model.addTab('quick', { cause: 'typed', flags: AddTabFlags.ACTIVE })
    model.closeTabAt(model.activeIndex)
    expect(model.activeTab?.data).toBe('A')
  })

  it('stays inside the group when closing a grouped tab', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    const group = model.addToNewGroup([1, 2])
    model.activateTabAt(2)
    expect(model.getTabGroupForTab(2)).toBe(group)
    model.closeTabAt(2)
    // Prefers the remaining group member (B), not the outside neighbor D.
    expect(model.activeTab?.data).toBe('B')
  })
})

describe('closing tabs', () => {
  it('canCloseTab veto cancels the close and notifies', () => {
    const cancelled = vi.fn()
    const model = new TabStripModel<string>({ canCloseTab: (t) => t.data !== 'keep' })
    model.appendTab('keep', false)
    model.appendTab('B', false)
    model.addObserver({ onTabCloseCancelled: cancelled })
    expect(model.closeTabAt(0)).toBe(false)
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(model.count).toBe(2)
  })

  it('closeAllTabs fires willCloseAllTabs and closeAllTabsStopped', () => {
    const events: string[] = []
    const model = makeModel(['A', 'B'])
    model.addObserver({
      willCloseAllTabs: () => events.push('will'),
      closeAllTabsStopped: (reason) => events.push(`stopped:${reason}`),
    })
    model.closeAllTabs()
    expect(events).toEqual(['will', 'stopped:completed'])
    expect(model.empty).toBe(true)
    expect(model.activeTab).toBeNull()
  })

  it('closeOtherTabs spares pinned tabs', () => {
    const model = makeModel(['A', 'B', 'C'])
    model.setTabPinned(0, true)
    model.closeOtherTabs(2)
    expect(strip(model)).toBe('Ap C')
  })

  it('batched close reports indices at time of removal', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    let recorded: Array<{ data: string; index: number }> = []
    model.addObserver({
      onTabStripModelChanged: (change) => {
        if (change.type === 'removed') {
          recorded = change.contents.map((c) => ({ data: c.tab.data, index: c.index }))
        }
      },
    })
    model.closeTabsAt([1, 2])
    // B removed at 1; C is then at index 1 too.
    expect(recorded).toEqual([
      { data: 'B', index: 1 },
      { data: 'C', index: 1 },
    ])
  })
})

describe('pinning', () => {
  it('pinning moves the tab to the pinned boundary', () => {
    const model = makeModel(['A', 'B', 'C'])
    expect(model.setTabPinned(2, true)).toBe(0)
    expect(strip(model)).toBe('Cp A B')
  })

  it('unpinning moves the tab to just after the pinned block', () => {
    const model = makeModel(['A', 'B', 'C'])
    model.setTabPinned(0, true)
    model.setTabPinned(1, true)
    expect(strip(model)).toBe('Ap Bp C')
    expect(model.setTabPinned(0, false)).toBe(1)
    expect(strip(model)).toBe('Bp A C')
  })

  it('pinning a grouped tab removes it from the group', () => {
    const model = makeModel(['A', 'B', 'C'])
    const group = model.addToNewGroup([1])
    model.setTabPinned(1, true)
    expect(model.getTabAt(0).data).toBe('B')
    expect(model.getTabAt(0).group).toBeNull()
    expect(model.containsGroup(group)).toBe(false)
  })

  it('move requests across the pinned boundary are clamped', () => {
    const model = makeModel(['A', 'B', 'C'])
    model.setTabPinned(0, true)
    expect(model.moveTabTo(0, 2)).toBe(0)
    expect(model.moveTabTo(2, 0)).toBe(1)
    expect(strip(model)).toBe('Ap C B')
  })
})

describe('moving tabs', () => {
  it('moveTabTo reorders and reports the final index', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    expect(model.moveTabTo(0, 2)).toBe(2)
    expect(strip(model)).toBe('B C A D')
  })

  it('selection follows the moved tabs by identity', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    model.activateTabAt(0)
    model.moveTabTo(0, 3)
    expect(model.activeTab?.data).toBe('A')
    expect(model.activeIndex).toBe(3)
  })

  it('moveSelectedTabsTo matches the header example [A b c D E f] -> 1', () => {
    const model = makeModel(['A', 'B', 'C', 'D', 'E', 'F'])
    model.activateTabAt(0)
    model.selectTabAt(3)
    model.selectTabAt(4)
    model.selectTabAt(0)
    model.moveSelectedTabsTo(1)
    expect(strip(model)).toBe('B A D E C F')
  })

  it('moving a tab into the middle of a group adopts the group', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    const group = model.addToNewGroup([1, 2])
    model.moveTabTo(3, 2)
    expect(model.getTabAt(2).data).toBe('D')
    expect(model.getTabAt(2).group).toBe(group)
  })

  it('moving a grouped tab out of its group clears membership', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    const group = model.addToNewGroup([1, 2])
    model.moveTabTo(1, 3)
    expect(model.getTabAt(3).data).toBe('B')
    expect(model.getTabAt(3).group).toBeNull()
    expect(model.containsGroup(group)).toBe(true)
  })
})

describe('moveTabNext / moveTabPrevious group boundaries', () => {
  it('entering a group toggles membership before moving', () => {
    const model = makeModel(['A', 'B', 'C'])
    const group = model.addToNewGroup([1, 2])
    model.activateTabAt(0)
    model.moveTabNext()
    // A joined the group without changing position.
    expect(strip(model)).toBe(`A(${group}) B(${group}) C(${group})`)
    model.moveTabNext()
    expect(strip(model)).toBe(`B(${group}) A(${group}) C(${group})`)
  })

  it('leaving a group at its edge toggles membership before moving', () => {
    const model = makeModel(['A', 'B', 'C'])
    const group = model.addToNewGroup([1, 2])
    model.activateTabAt(2)
    model.moveTabNext()
    // C left the group but stayed at index 2.
    expect(strip(model)).toBe(`A B(${group}) C`)
  })

  it('hops over a collapsed group as if it were one tab', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    const group = model.addToNewGroup([1, 2])
    model.setGroupCollapsed(group, true)
    model.activateTabAt(0)
    model.moveTabNext()
    expect(strip(model)).toBe(`B(${group}) C(${group}) A D`)
  })
})

describe('tab groups', () => {
  it('addToNewGroup gathers non-contiguous tabs after the first', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    const group = model.addToNewGroup([0, 2])
    expect(strip(model)).toBe(`A(${group}) C(${group}) B D`)
  })

  it('addToNewGroup with a tab inside another group exits past it', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    const g1 = model.addToNewGroup([0, 1, 2])
    const g2 = model.addToNewGroup([0])
    // A exits to just past g1 so g1 is not split in half.
    expect(strip(model)).toBe(`B(${g1}) C(${g1}) A(${g2}) D`)
  })

  it('addToExistingGroup moves left tabs to the start and right tabs to the end', () => {
    const model = makeModel(['A', 'B', 'C', 'D', 'E'])
    const group = model.addToNewGroup([2])
    model.addToExistingGroup([0, 4], group)
    expect(strip(model)).toBe(`B A(${group}) C(${group}) E(${group}) D`)
  })

  it('removeFromGroup exits first-half tabs left and second-half tabs right', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    const group = model.addToNewGroup([0, 1, 2, 3])
    model.removeFromGroup([0, 3])
    expect(strip(model)).toBe(`A B(${group}) C(${group}) D`)
    expect(model.getTabAt(0).group).toBeNull()
    expect(model.getTabAt(3).group).toBeNull()
  })

  it('the group is deleted when its last tab leaves', () => {
    const events: string[] = []
    const model = makeModel(['A', 'B'])
    const group = model.addToNewGroup([0])
    model.addObserver({
      onTabGroupChanged: (change) => events.push(change.type),
    })
    model.removeFromGroup([0])
    expect(model.containsGroup(group)).toBe(false)
    expect(events).toContain('closed')
  })

  it('moveGroupTo moves the whole group', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    const group = model.addToNewGroup([0, 1])
    model.moveGroupTo(group, 3)
    expect(strip(model)).toBe(`C D A(${group}) B(${group})`)
  })

  it('inserting into a group span via addTab group option clamps inside it', () => {
    const model = makeModel(['A', 'B', 'C'])
    const group = model.addToNewGroup([1, 2])
    model.addTab('X', { index: 0, flags: AddTabFlags.FORCE_INDEX, group })
    expect(strip(model)).toBe(`A X(${group}) B(${group}) C(${group})`)
  })

  it('an ungrouped insert between two tabs of the same group adopts it', () => {
    const model = makeModel(['A', 'B', 'C'])
    const group = model.addToNewGroup([1, 2])
    model.addTab('X', { index: 2, flags: AddTabFlags.FORCE_INDEX })
    expect(model.getTabAt(2).data).toBe('X')
    expect(model.getTabAt(2).group).toBe(group)
  })

  it('group colors cycle least-used-first', () => {
    const model = makeModel(['A', 'B'])
    const g1 = model.addToNewGroup([0])
    const g2 = model.addToNewGroup([1])
    expect(model.getGroupVisualData(g1)?.color).toBe('grey')
    expect(model.getGroupVisualData(g2)?.color).toBe('blue')
  })

  it('collapsing the group holding the active tab activates an expanded tab', () => {
    const model = makeModel(['A', 'B', 'C'])
    const group = model.addToNewGroup([0, 1])
    model.activateTabAt(0)
    model.setGroupCollapsed(group, true)
    expect(model.activeTab?.data).toBe('C')
  })

  it('selectNextTab skips collapsed groups and wraps', () => {
    const model = makeModel(['A', 'B', 'C'])
    const group = model.addToNewGroup([1])
    model.setGroupCollapsed(group, true)
    model.activateTabAt(0)
    model.selectNextTab()
    expect(model.activeTab?.data).toBe('C')
    model.selectNextTab()
    expect(model.activeTab?.data).toBe('A')
  })
})

describe('multi-selection', () => {
  it('extendSelectionTo selects the anchor..index range', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    model.activateTabAt(1)
    model.extendSelectionTo(3)
    expect(model.selectionModel().selectedIndices()).toEqual([1, 2, 3])
    expect(model.activeIndex).toBe(3)
    expect(model.selectionModel().anchor).toBe(1)
  })

  it('deselectTabAt refuses to remove the last selected tab', () => {
    const model = makeModel(['A', 'B'])
    model.activateTabAt(0)
    model.deselectTabAt(0)
    expect(model.isTabSelected(0)).toBe(true)
  })

  it('closing the active tab with a multi-selection activates the first remaining selected', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    model.activateTabAt(1)
    model.selectTabAt(2)
    model.selectTabAt(3)
    model.closeTabAt(3)
    expect(model.activeTab?.data).toBe('B')
    expect(model.selectionModel().selectedIndices()).toEqual([1, 2])
  })

  it('closeSelectedTabs closes every selected tab', () => {
    const model = makeModel(['A', 'B', 'C', 'D'])
    model.activateTabAt(0)
    model.selectTabAt(2)
    model.closeSelectedTabs()
    expect(strip(model)).toBe('B D')
  })
})

describe('opener bookkeeping', () => {
  it('a user-gesture switch outside the opener tree forgets all openers', () => {
    const model = makeModel(['A', 'B', 'C'])
    model.activateTabAt(0)
    model.addTab('child', { cause: 'link', flags: AddTabFlags.ACTIVE })
    expect(model.getTabAt(1).opener?.data).toBe('A')
    model.activateTabAt(3, { userGesture: true })
    expect(model.getTabAt(1).opener).toBeNull()
  })

  it('switching to the opener keeps relationships', () => {
    const model = makeModel(['A', 'B'])
    model.activateTabAt(0)
    model.addTab('child', { cause: 'link', flags: AddTabFlags.ACTIVE })
    model.activateTabAt(0, { userGesture: true })
    expect(model.getTabAt(1).opener?.data).toBe('A')
  })

  it('tabNavigating with a typed cause forgets openers', () => {
    const model = makeModel(['A', 'B'])
    model.activateTabAt(0)
    model.addTab('child', { cause: 'link', flags: AddTabFlags.ACTIVE })
    model.tabNavigating(model.getTabAt(1), 'typed')
    expect(model.getTabAt(1).opener).toBeNull()
  })

  it('moving a tab re-points its children at its own opener', () => {
    const model = makeModel(['A', 'B', 'C'])
    // Opener chain A <- B <- C, set directly so foreground-add does not
    // forget relationships along the way.
    model.setOpenerOfTabAt(1, model.getTabAt(0))
    model.setOpenerOfTabAt(2, model.getTabAt(1))
    model.moveTabTo(1, 2)
    const c = model.getTabs().find((t) => t.data === 'C')!
    expect(c.opener?.data).toBe('A')
  })

  it('foreground link-opens forget prior opener relationships (cc:3602)', () => {
    const model = makeModel(['A'])
    model.activateTabAt(0)
    model.addTab('B', { cause: 'link', flags: AddTabFlags.ACTIVE })
    model.addTab('C', { cause: 'link', flags: AddTabFlags.ACTIVE })
    // Opening C in the foreground forgot B's opener first.
    expect(model.getTabAt(1).opener).toBeNull()
    expect(model.getTabAt(2).opener?.data).toBe('B')
  })
})

describe('observer notifications', () => {
  it('insert, selection, move, pin and group events fire with payloads', () => {
    const events: string[] = []
    const model = new TabStripModel<string>()
    model.addObserver({
      onTabStripModelChanged: (change) => events.push(change.type),
      onTabPinnedStateChanged: (tab) => events.push(`pinned:${tab.data}`),
      onTabGroupedStateChanged: (oldG, newG, tab) =>
        events.push(`grouped:${tab.data}:${oldG === null ? '-' : 'g'}->${newG === null ? '-' : 'g'}`),
    })
    model.appendTab('A', true)
    model.appendTab('B', false)
    model.activateTabAt(1)
    model.moveTabTo(1, 0)
    model.setTabPinned(0, true)
    expect(events).toEqual([
      'inserted',
      'inserted',
      'selectionOnly',
      'moved',
      'pinned:B',
    ])
  })

  it('observers cannot mutate the model reentrantly', () => {
    const model = makeModel(['A', 'B'])
    model.addObserver({
      onTabStripModelChanged: () => {
        expect(() => model.activateTabAt(0)).toThrow(/not re-entrant/)
      },
    })
    model.activateTabAt(1)
  })

  it('removeObserver stops notifications', () => {
    const fn = vi.fn()
    const model = makeModel(['A'])
    const unsubscribe = model.addObserver({ onTabStripModelChanged: fn })
    unsubscribe()
    model.appendTab('B', true)
    expect(fn).not.toHaveBeenCalled()
  })
})
