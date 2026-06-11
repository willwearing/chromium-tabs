/**
 * Port of ui/base/models/list_selection_model.{h,cc}.
 *
 * Selection model represented as a list of indexes. In addition to the set of
 * selected indices it maintains:
 *
 * - active: the index of the currently visible item, or null if nothing is
 *   selected.
 * - anchor: the index of the last item the user clicked on. Extending the
 *   selection extends it from this index. Null if nothing is selected.
 *
 * Typically there is one selected item, in which case anchor and active are
 * the same.
 */

// list_selection_model.cc:21
function indexAfterInsertion(insertPosition: number, originalIndex: number): number {
  return originalIndex >= insertPosition ? originalIndex + 1 : originalIndex
}

// list_selection_model.cc:40 — null means "erase from container"
function indexAfterRemoval(removePosition: number, originalIndex: number): number | null {
  if (originalIndex === removePosition) return null
  return originalIndex > removePosition ? originalIndex - 1 : originalIndex
}

// list_selection_model.cc:68 — assumes destination <= source (move to lower index)
function indexAfterMove(
  sourcePosition: number,
  destinationPosition: number,
  rangeSize: number,
  originalIndex: number | null,
): number | null {
  if (originalIndex === null) return null
  if (destinationPosition <= originalIndex && originalIndex < sourcePosition + rangeSize) {
    if (originalIndex < sourcePosition) {
      // Items in [destination, source) see rangeSize items inserted before
      // them, so their indices increase.
      return originalIndex + rangeSize
    }
    // Items in [source, source + rangeSize) shift down by
    // (source - destination) spots.
    return originalIndex - (sourcePosition - destinationPosition)
  }
  return originalIndex
}

export class ListSelectionModel {
  private selectedIndices_ = new Set<number>()
  private active_: number | null = null
  private anchor_: number | null = null

  get anchor(): number | null {
    return this.anchor_
  }

  setAnchor(anchor: number | null): void {
    this.anchor_ = anchor
  }

  get active(): number | null {
    return this.active_
  }

  setActive(active: number | null): void {
    this.active_ = active
  }

  /** True if nothing is selected. */
  get empty(): boolean {
    return this.selectedIndices_.size === 0
  }

  get size(): number {
    return this.selectedIndices_.size
  }

  /** Selected indices in ascending order. */
  selectedIndices(): number[] {
    return [...this.selectedIndices_].sort((a, b) => a - b)
  }

  /**
   * Increments all indices >= index. Used when a new item is inserted.
   * list_selection_model.cc:112
   */
  incrementFrom(index: number): void {
    const next = new Set<number>()
    for (const i of this.selectedIndices_) next.add(indexAfterInsertion(index, i))
    this.selectedIndices_ = next
    this.anchor_ = this.anchor_ === null ? null : indexAfterInsertion(index, this.anchor_)
    this.active_ = this.active_ === null ? null : indexAfterInsertion(index, this.active_)
  }

  /**
   * Shifts all indices > index down by 1; index itself is removed from the
   * selection. Used when an item is removed. list_selection_model.cc:122
   */
  decrementFrom(index: number): void {
    const next = new Set<number>()
    for (const i of this.selectedIndices_) {
      const v = indexAfterRemoval(index, i)
      if (v !== null) next.add(v)
    }
    this.selectedIndices_ = next
    this.anchor_ = this.anchor_ === null ? null : indexAfterRemoval(index, this.anchor_)
    this.active_ = this.active_ === null ? null : indexAfterRemoval(index, this.active_)
  }

  /** Sets the anchor, active and selection to index. */
  setSelectedIndex(index: number | null): void {
    this.anchor_ = index
    this.active_ = index
    this.selectedIndices_.clear()
    if (index !== null) this.selectedIndices_.add(index)
  }

  isSelected(index: number): boolean {
    return this.selectedIndices_.has(index)
  }

  /** Adds index to the selection without changing active or anchor. */
  addIndexToSelection(index: number): void {
    this.selectedIndices_.add(index)
  }

  /** Adds [indexStart, indexEnd] inclusive without changing active or anchor. */
  addIndexRangeToSelection(indexStart: number, indexEnd: number): void {
    if (indexStart > indexEnd) throw new RangeError('indexStart must be <= indexEnd')
    for (let i = indexStart; i <= indexEnd; i++) this.selectedIndices_.add(i)
  }

  /** Removes index from the selection without changing active or anchor. */
  removeIndexFromSelection(index: number): void {
    this.selectedIndices_.delete(index)
  }

  /**
   * Sets the selection to the range anchor..index. If there is no anchor,
   * behaves like setSelectedIndex. list_selection_model.cc:171
   */
  setSelectionFromAnchorTo(index: number): void {
    if (this.anchor_ === null) {
      this.setSelectedIndex(index)
      return
    }
    this.selectedIndices_.clear()
    const min = Math.min(index, this.anchor_)
    const max = Math.max(index, this.anchor_)
    for (let i = min; i <= max; i++) this.selectedIndices_.add(i)
    this.active_ = index
  }

  /**
   * Makes sure anchor..index are selected, adding to the existing selection.
   * list_selection_model.cc:186
   */
  addSelectionFromAnchorTo(index: number): void {
    if (this.anchor_ === null) {
      this.setSelectedIndex(index)
      return
    }
    const min = Math.min(index, this.anchor_)
    const max = Math.max(index, this.anchor_)
    for (let i = min; i <= max; i++) this.selectedIndices_.add(i)
    this.active_ = index
  }

  /**
   * Invoked when `length` items move from oldIndex to newIndex. If moving to
   * a greater index, newIndex is the index *after* removing the moved range.
   * list_selection_model.cc:199
   */
  move(oldIndex: number, newIndex: number, length: number): void {
    if (oldIndex === newIndex) throw new RangeError('oldIndex must differ from newIndex')
    if (length <= 0) throw new RangeError('length must be > 0')

    // Remap move-to-higher-index to the equivalent move-to-lower-index
    // operation ("ABCDEFG" -> "CDEFABG" is 'AB' up by 4, or 'CDEF' down by 2).
    if (newIndex > oldIndex) {
      this.move(oldIndex + length, oldIndex, newIndex - oldIndex)
      return
    }

    this.anchor_ = indexAfterMove(oldIndex, newIndex, length, this.anchor_)
    this.active_ = indexAfterMove(oldIndex, newIndex, length, this.active_)

    const next = new Set<number>()
    for (const i of this.selectedIndices_) {
      const v = indexAfterMove(oldIndex, newIndex, length, i)
      if (v !== null) next.add(v)
    }
    this.selectedIndices_ = next
  }

  /** Clears the selection, anchor and active. */
  clear(): void {
    this.anchor_ = null
    this.active_ = null
    this.selectedIndices_.clear()
  }

  clone(): ListSelectionModel {
    const copy = new ListSelectionModel()
    copy.selectedIndices_ = new Set(this.selectedIndices_)
    copy.active_ = this.active_
    copy.anchor_ = this.anchor_
    return copy
  }

  equals(other: ListSelectionModel): boolean {
    if (this.active_ !== other.active_ || this.anchor_ !== other.anchor_) return false
    if (this.selectedIndices_.size !== other.selectedIndices_.size) return false
    for (const i of this.selectedIndices_) {
      if (!other.selectedIndices_.has(i)) return false
    }
    return true
  }

  /** 'active=X anchor=X selection=X X X...' — matches the C++ ToString. */
  toString(): string {
    const opt = (v: number | null) => (v === null ? '<none>' : String(v))
    return `active=${opt(this.active_)} anchor=${opt(this.anchor_)} selection=${this.selectedIndices().join(' ')}`
  }
}
