import { describe, expect, it } from 'vitest'
import { ListSelectionModel } from '../src/core/list-selection-model'

// Scenarios come from the comments in ui/base/models/list_selection_model.h
// and list_selection_model_unittest.cc.

function modelWith(indices: number[], active: number | null = null, anchor: number | null = null) {
  const m = new ListSelectionModel()
  for (const i of indices) m.addIndexToSelection(i)
  m.setActive(active)
  m.setAnchor(anchor)
  return m
}

describe('ListSelectionModel', () => {
  it('setSelectedIndex sets anchor, active and selection', () => {
    const m = new ListSelectionModel()
    m.setSelectedIndex(2)
    expect(m.toString()).toBe('active=2 anchor=2 selection=2')
  })

  it('incrementFrom shifts indices at or above the insertion point', () => {
    // header: [0, 1, 5] incremented at 1 -> [0, 2, 6]
    const m = modelWith([0, 1, 5], 1, 1)
    m.incrementFrom(1)
    expect(m.selectedIndices()).toEqual([0, 2, 6])
    expect(m.active).toBe(2)
    expect(m.anchor).toBe(2)
  })

  it('decrementFrom removes the index and shifts higher ones down', () => {
    // header: [0, 1, 5] decremented at 1 -> [0, 4]
    const m = modelWith([0, 1, 5], 1, 5)
    m.decrementFrom(1)
    expect(m.selectedIndices()).toEqual([0, 4])
    expect(m.active).toBeNull()
    expect(m.anchor).toBe(4)
  })

  it('setSelectionFromAnchorTo selects the anchor..index range', () => {
    const m = new ListSelectionModel()
    m.setSelectedIndex(2)
    m.setSelectionFromAnchorTo(5)
    expect(m.toString()).toBe('active=5 anchor=2 selection=2 3 4 5')
  })

  it('setSelectionFromAnchorTo with no anchor behaves like setSelectedIndex', () => {
    const m = new ListSelectionModel()
    m.setSelectionFromAnchorTo(3)
    expect(m.toString()).toBe('active=3 anchor=3 selection=3')
  })

  it('addSelectionFromAnchorTo adds to the existing selection', () => {
    const m = new ListSelectionModel()
    m.setSelectedIndex(0)
    m.addSelectionFromAnchorTo(2)
    m.setAnchor(5)
    m.addSelectionFromAnchorTo(4)
    expect(m.selectedIndices()).toEqual([0, 1, 2, 4, 5])
    expect(m.active).toBe(4)
  })

  it('move remaps a move-to-higher-index ("ABC" -> "BCA" is 0,2,1)', () => {
    // header comment: to move A to the end of 'A B C', invoke with (0, 2, 1).
    const m = modelWith([0], 0, 0)
    m.move(0, 2, 1)
    expect(m.selectedIndices()).toEqual([2])
    expect(m.active).toBe(2)
  })

  it('move shifts unrelated selections correctly (ABCDEFG -> CDEFABG)', () => {
    // 'AB' (indices 0-1) move to index 4; selection on C (2) shifts to 0,
    // selection on A (0) shifts to 4.
    const m = modelWith([0, 2], 0, 2)
    m.move(0, 4, 2)
    expect(m.selectedIndices()).toEqual([0, 4])
    expect(m.active).toBe(4)
    expect(m.anchor).toBe(0)
  })

  it('clear empties everything', () => {
    const m = modelWith([1, 2], 1, 2)
    m.clear()
    expect(m.empty).toBe(true)
    expect(m.active).toBeNull()
    expect(m.anchor).toBeNull()
  })

  it('equals compares full state', () => {
    expect(modelWith([1, 2], 1, 2).equals(modelWith([1, 2], 1, 2))).toBe(true)
    expect(modelWith([1, 2], 1, 2).equals(modelWith([1, 3], 1, 2))).toBe(false)
    expect(modelWith([1], 1, 1).equals(modelWith([1], null, 1))).toBe(false)
  })
})
