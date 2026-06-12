import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabStripModel } from '../src/core/tab-strip-model'
import { InMemoryStorageBackend } from '../src/session/backends/in-memory'
import type { CommandStorageBackend } from '../src/session/command-storage-backend'
import { restoreSessionWindow } from '../src/session/session-restore'
import {
  SessionCommandId,
  restoreSessionFromCommands,
  type SessionCommand,
} from '../src/session/session-service-commands'
import {
  SessionService,
  type RestoreIntoOptions,
  type SessionServiceOptions,
} from '../src/session/session-service'
import { DEFAULT_WINDOW_ID, currentNavigationEntry } from '../src/session/session-types'

interface PageData {
  url: string
}

/** Records every backend write so tests can assert append vs truncate. */
class SpyBackend extends InMemoryStorageBackend {
  appendCalls: Array<{ count: number; truncate: boolean }> = []

  override appendCommands(commands: readonly SessionCommand[], truncate: boolean): void {
    this.appendCalls.push({ count: commands.length, truncate })
    super.appendCommands(commands, truncate)
  }
}

function newService(
  storage: CommandStorageBackend,
  overrides: Partial<SessionServiceOptions<PageData>> = {},
): SessionService<PageData> {
  return new SessionService<PageData>({ storage, ...overrides })
}

/** Simulates a page reload: fresh service over the same storage, restore, attach. */
async function refresh(storage: CommandStorageBackend, options?: RestoreIntoOptions<PageData>) {
  const service = newService(storage)
  const model = new TabStripModel<PageData>()
  const result = await service.restoreInto(model, options)
  return { service, model, result }
}

const urls = (model: TabStripModel<PageData>) => model.getTabs().map((t) => t.data.url)
const ids = (model: TabStripModel<PageData>) => model.getTabs().map((t) => t.id)

afterEach(() => {
  vi.useRealTimers()
})

describe('session round-trip', () => {
  it('restores tabs, order, data, pinned state, groups and active tab after a refresh', async () => {
    const storage = new InMemoryStorageBackend()
    const s1 = newService(storage)
    const m1 = new TabStripModel<PageData>()
    s1.attach(m1)

    const a = m1.appendTab({ url: 'https://a.test' })
    const b = m1.appendTab({ url: 'https://b.test' })
    const c = m1.appendTab({ url: 'https://c.test' })
    m1.appendTab({ url: 'https://d.test' })
    m1.setTabPinned(m1.indexOfTab(a), true)
    m1.addToNewGroup([m1.indexOfTab(b), m1.indexOfTab(c)], {
      title: 'Work',
      color: 'blue',
      isCollapsed: false,
    })
    m1.activateTabAt(m1.indexOfTab(c))
    await s1.saveNow()

    const { model: m2, result } = await refresh(storage)
    expect(result.restored).toBe(true)
    expect(result.tabsRestored).toBe(4)
    expect(ids(m2)).toEqual(ids(m1))
    expect(urls(m2)).toEqual(urls(m1))
    expect(m2.isTabPinned(0)).toBe(true)
    expect(m2.activeTab?.id).toBe(c.id)

    const groups = m2.getGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0]!.visualData).toEqual({ title: 'Work', color: 'blue', isCollapsed: false })
    expect(m2.getTabById(b.id)?.group).toBe(groups[0]!.id)
    expect(m2.getTabById(c.id)?.group).toBe(groups[0]!.id)
    expect(m2.getTabById(a.id)?.group).toBeNull()
  })

  it('restores nothing on first run but starts recording', async () => {
    const storage = new InMemoryStorageBackend()
    const { service, model, result } = await refresh(storage)
    expect(result.restored).toBe(false)
    expect(model.count).toBe(0)

    model.appendTab({ url: 'first' })
    await service.saveNow()
    const { model: m2, result: r2 } = await refresh(storage)
    expect(r2.restored).toBe(true)
    expect(urls(m2)).toEqual(['first'])
  })

  it('carries state across multiple sequential sessions', async () => {
    const storage = new InMemoryStorageBackend()
    const s1 = newService(storage)
    const m1 = new TabStripModel<PageData>()
    s1.attach(m1)
    m1.appendTab({ url: 'one' })
    await s1.saveNow()

    const second = await refresh(storage)
    second.model.appendTab({ url: 'two' })
    await second.service.saveNow()

    const third = await refresh(storage)
    expect(urls(third.model)).toEqual(['one', 'two'])
  })

  it('keeps the previous session when a run dies before its first save', async () => {
    const storage = new InMemoryStorageBackend()
    const s1 = newService(storage)
    const m1 = new TabStripModel<PageData>()
    s1.attach(m1)
    m1.appendTab({ url: 'survivor' })
    await s1.saveNow()

    // Second run: the constructor rotates current -> last, then the process
    // "crashes" before anything is written.
    newService(storage)

    const third = await refresh(storage)
    expect(third.result.restored).toBe(true)
    expect(urls(third.model)).toEqual(['survivor'])
  })
})

describe('incremental recording', () => {
  async function roundTrip(
    mutate: (model: TabStripModel<PageData>, service: SessionService<PageData>) => void | Promise<void>,
  ) {
    const storage = new InMemoryStorageBackend()
    const service = newService(storage)
    const model = new TabStripModel<PageData>()
    service.attach(model)
    model.appendTab({ url: 'a' })
    model.appendTab({ url: 'b' })
    model.appendTab({ url: 'c' })
    await service.saveNow()
    await mutate(model, service)
    await service.saveNow()
    const restored = await refresh(storage)
    return { model, restored: restored.model, result: restored.result }
  }

  it('records moves', async () => {
    const { model, restored } = await roundTrip((m) => {
      m.moveTabTo(0, 2)
    })
    expect(urls(model)).toEqual(['b', 'c', 'a'])
    expect(urls(restored)).toEqual(['b', 'c', 'a'])
    expect(restored.activeTab?.id).toBe(model.activeTab?.id)
  })

  it('records closes and keeps the right active tab when earlier tabs close', async () => {
    const { model, restored } = await roundTrip((m) => {
      m.activateTabAt(2)
      m.closeTabAt(0)
    })
    expect(urls(restored)).toEqual(['b', 'c'])
    expect(restored.activeTab?.data.url).toBe('c')
    expect(restored.activeTab?.id).toBe(model.activeTab?.id)
  })

  it('records pinning (which moves the tab to the front)', async () => {
    const { restored } = await roundTrip((m) => {
      m.setTabPinned(2, true)
    })
    expect(urls(restored)).toEqual(['c', 'a', 'b'])
    expect(restored.isTabPinned(0)).toBe(true)
    expect(restored.isTabPinned(1)).toBe(false)
  })

  it('records unpinning', async () => {
    const { restored } = await roundTrip((m) => {
      m.setTabPinned(2, true)
      m.setTabPinned(0, false)
    })
    expect(urls(restored)).toEqual(['c', 'a', 'b'])
    expect(restored.isTabPinned(0)).toBe(false)
  })

  it('records data replacement', async () => {
    const { restored } = await roundTrip((m) => {
      m.setTabData(1, { url: 'b2' })
    })
    expect(urls(restored)).toEqual(['a', 'b2', 'c'])
  })

  it('records in-place data mutation via notifyTabChanged', async () => {
    const { restored } = await roundTrip((m) => {
      m.getTabAt(1).data.url = 'b-mutated'
      m.notifyTabChanged(1)
    })
    expect(urls(restored)).toEqual(['a', 'b-mutated', 'c'])
  })

  it('records group creation, visual updates and dissolution', async () => {
    const storage = new InMemoryStorageBackend()
    const service = newService(storage)
    const model = new TabStripModel<PageData>()
    service.attach(model)
    model.appendTab({ url: 'a' })
    model.appendTab({ url: 'b' })
    model.appendTab({ url: 'c' })
    const group = model.addToNewGroup([0, 1], { title: 'G', color: 'red', isCollapsed: false })
    model.updateGroupVisuals(group, { isCollapsed: true })
    await service.saveNow()

    const mid = await refresh(storage)
    expect(mid.model.getGroups()[0]!.visualData).toEqual({ title: 'G', color: 'red', isCollapsed: true })

    mid.model.removeFromGroup([0, 1])
    await mid.service.saveNow()
    const end = await refresh(storage)
    expect(end.model.getGroups()).toHaveLength(0)
    expect(end.model.getTabs().every((t) => t.group === null)).toBe(true)
  })

  it('records group moves', async () => {
    const storage = new InMemoryStorageBackend()
    const service = newService(storage)
    const model = new TabStripModel<PageData>()
    service.attach(model)
    model.appendTab({ url: 'a' })
    model.appendTab({ url: 'b' })
    model.appendTab({ url: 'c' })
    model.addToNewGroup([1, 2], { title: 'G', color: 'cyan', isCollapsed: false })
    model.moveGroupTo(model.getTabAt(1).group!, 0)
    expect(urls(model)).toEqual(['b', 'c', 'a'])
    await service.saveNow()

    const { model: restored } = await refresh(storage)
    expect(urls(restored)).toEqual(['b', 'c', 'a'])
    expect(restored.getTabAt(0).group).not.toBeNull()
    expect(restored.getTabAt(2).group).toBeNull()
  })

  it('records reconcile-driven changes', async () => {
    const { restored } = await roundTrip((m) => {
      m.reconcile(
        [
          { id: 'x', data: { url: 'x' }, pinned: true },
          { id: m.getTabAt(2).id, data: { url: 'c-updated' } },
        ],
        { activeId: 'x' },
      )
    })
    expect(urls(restored)).toEqual(['x', 'c-updated'])
    expect(restored.isTabPinned(0)).toBe(true)
    expect(restored.activeTab?.id).toBe('x')
  })

  it('records closeAllTabs honestly: the next session restores nothing', async () => {
    const { result } = await roundTrip((m) => {
      m.closeAllTabs()
    })
    expect(result.restored).toBe(false)
  })

  it('stops recording after detach', async () => {
    const storage = new InMemoryStorageBackend()
    const service = newService(storage)
    const model = new TabStripModel<PageData>()
    service.attach(model)
    model.appendTab({ url: 'kept' })
    await service.saveNow()
    service.detach(DEFAULT_WINDOW_ID)
    model.appendTab({ url: 'not-recorded' })
    await service.saveNow()

    const { model: restored } = await refresh(storage)
    expect(urls(restored)).toEqual(['kept'])
  })
})

describe('save timing and buffering', () => {
  it('buffers commands and writes once after the save delay', async () => {
    vi.useFakeTimers()
    const storage = new SpyBackend()
    const service = newService(storage)
    const model = new TabStripModel<PageData>()
    service.attach(model)
    model.appendTab({ url: 'a' })

    expect(storage.appendCalls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2499)
    expect(storage.appendCalls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(storage.appendCalls).toHaveLength(1)
    expect(storage.appendCalls[0]!.truncate).toBe(true)
    service.dispose()
  })

  it('respects a custom saveDelayMs', async () => {
    vi.useFakeTimers()
    const storage = new SpyBackend()
    const service = newService(storage, { saveDelayMs: 100 })
    const model = new TabStripModel<PageData>()
    service.attach(model)
    await vi.advanceTimersByTimeAsync(100)
    expect(storage.appendCalls).toHaveLength(1)
    service.dispose()
  })

  it('coalesces repeated data updates for the same tab into one pending command', async () => {
    const storage = new InMemoryStorageBackend()
    const service = newService(storage)
    const model = new TabStripModel<PageData>()
    service.attach(model)
    model.appendTab({ url: 'v0' })
    for (let i = 1; i <= 10; i++) model.setTabData(0, { url: `v${i}` })
    await service.saveNow()

    const dataCommands = storage.currentSessionCommands!.filter(
      (c) => c.id === SessionCommandId.SET_TAB_DATA,
    )
    expect(dataCommands).toHaveLength(1)
    expect((dataCommands[0] as Extract<SessionCommand, { id: 30 }>).data).toEqual({ url: 'v10' })
  })

  it('flushes synchronously on pagehide', () => {
    const storage = new SpyBackend()
    const service = newService(storage)
    const model = new TabStripModel<PageData>()
    service.attach(model)
    model.appendTab({ url: 'a' })

    expect(storage.appendCalls).toHaveLength(0)
    window.dispatchEvent(new Event('pagehide'))
    expect(storage.appendCalls).toHaveLength(1)
    service.dispose()
  })

  it('does not register the pagehide listener when disabled', () => {
    const storage = new SpyBackend()
    const service = newService(storage, { flushOnPageHide: false })
    const model = new TabStripModel<PageData>()
    service.attach(model)
    model.appendTab({ url: 'a' })
    window.dispatchEvent(new Event('pagehide'))
    expect(storage.appendCalls).toHaveLength(0)
    service.dispose()
  })
})

describe('log compaction (kWritesPerReset)', () => {
  it('rewrites the log from live state once enough commands accumulate', async () => {
    const storage = new SpyBackend()
    const service = newService(storage, { writesPerReset: 5 })
    const model = new TabStripModel<PageData>()
    service.attach(model)
    await service.saveNow()

    for (let i = 0; i < 6; i++) model.appendTab({ url: `t${i}` })
    await service.saveNow()

    expect(storage.appendCalls.filter((c) => c.truncate).length).toBeGreaterThanOrEqual(2)
    const { model: restored } = await refresh(storage)
    expect(urls(restored)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5'])
  })

  it('never resets on a closing command', async () => {
    const storage = new SpyBackend()
    const service = newService(storage, { writesPerReset: 1 })
    const model = new TabStripModel<PageData>()
    model.appendTab({ url: 'a' })
    model.appendTab({ url: 'b' })
    model.activateTabAt(0)
    service.attach(model)
    await service.saveNow() // truncating initial snapshot

    // Closing the last, inactive tab emits only kCommandTabClosed: no index
    // shifts, no selection change. Even at writesPerReset=1 it must append.
    model.closeTabAt(1)
    await service.saveNow()
    expect(storage.appendCalls[1]!.truncate).toBe(false)

    // A non-closing command at the same threshold does trigger the rewrite.
    model.setTabData(0, { url: 'a2' })
    await service.saveNow()
    expect(storage.appendCalls[2]!.truncate).toBe(true)

    const { model: restored } = await refresh(storage)
    expect(urls(restored)).toEqual(['a2'])
  })
})

describe('fault tolerance', () => {
  it('stops replay at an unknown command but keeps prior state', () => {
    const valid: SessionCommand[] = [
      { id: 0, windowId: 'w', tabId: 't1' },
      { id: 30, tabId: 't1', data: { url: 'kept' } },
      { id: 2, tabId: 't1', index: 0 },
    ]
    const snapshot = restoreSessionFromCommands([
      ...valid,
      { id: 99 } as unknown as SessionCommand,
      { id: 16, tabId: 't1', closeTime: 0 }, // never reached
    ])
    expect(snapshot.errorReading).toBe(true)
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0]!.tabs[0]!.data).toEqual({ url: 'kept' })
  })

  it('stops replay at a malformed payload', () => {
    const snapshot = restoreSessionFromCommands([
      { id: 0, windowId: 'w', tabId: 't1' },
      { id: 30, tabId: 't1', data: { url: 'kept' } },
      { id: 12, tabId: 't1', pinned: 'yes' } as unknown as SessionCommand,
    ])
    expect(snapshot.errorReading).toBe(true)
    expect(snapshot.windows[0]!.tabs[0]!.pinned).toBe(false)
  })

  it('drops tabs that have neither data nor navigations', async () => {
    const storage = new InMemoryStorageBackend()
    const service = newService(storage, { serializeTabData: () => undefined })
    const model = new TabStripModel<PageData>()
    service.attach(model)
    model.appendTab({ url: 'invisible' })
    await service.saveNow()

    const { result } = await refresh(storage)
    expect(result.restored).toBe(false)
  })

  it('recovers from a backend write error with a full rebuild on the next save', async () => {
    class FlakyBackend extends InMemoryStorageBackend {
      failNext = true
      override appendCommands(commands: readonly SessionCommand[], truncate: boolean): void {
        if (this.failNext) {
          this.failNext = false
          throw new Error('disk full')
        }
        super.appendCommands(commands, truncate)
      }
    }
    const storage = new FlakyBackend()
    const onError = vi.fn()
    const service = newService(storage, { onError })
    const model = new TabStripModel<PageData>()
    service.attach(model)
    model.appendTab({ url: 'a' })
    await service.saveNow() // fails, commands lost
    await service.saveNow() // rebuild-on-next-save kicks in

    const { model: restored } = await refresh(storage)
    expect(urls(restored)).toEqual(['a'])
  })
})

describe('navigation tracking', () => {
  it('round-trips history including back navigation and forward-pruning', async () => {
    const storage = new InMemoryStorageBackend()
    const service = newService(storage)
    const model = new TabStripModel<PageData>()
    service.attach(model)
    const t = model.appendTab({ url: 'start' })

    service.navigateTab(t.id, { url: 'one' })
    service.navigateTab(t.id, { url: 'two' })
    service.navigateTab(t.id, { url: 'three' })
    service.setSelectedNavigationIndex(t.id, 1) // back to 'two'
    service.navigateTab(t.id, { url: 'four' }) // branches: 'three' is pruned
    await service.saveNow()

    const snapshot = await newService(storage).getLastSession()
    const tab = snapshot.windows[0]!.tabs[0]!
    expect(tab.navigations.map((n) => n.url)).toEqual(['one', 'two', 'four'])
    expect(tab.currentNavigationIndex).toBe(2)
    expect(currentNavigationEntry(tab)?.url).toBe('four')
  })

  it('survives a full log rewrite and trims to maxPersistedNavigations', async () => {
    const storage = new InMemoryStorageBackend()
    const service = newService(storage)
    const model = new TabStripModel<PageData>()
    service.attach(model)
    const t = model.appendTab({ url: 'start' })
    for (let i = 0; i < 10; i++) service.navigateTab(t.id, { url: `n${i}` })

    service.scheduleResetCommands()
    await service.saveNow()

    const snapshot = await newService(storage).getLastSession()
    const tab = snapshot.windows[0]!.tabs[0]!
    // 6 back entries plus the current one survive the rewrite.
    expect(tab.navigations.map((n) => n.url)).toEqual(['n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'])
    expect(currentNavigationEntry(tab)?.url).toBe('n9')
  })

  it('re-adopts restored histories so they survive the next rewrite', async () => {
    const storage = new InMemoryStorageBackend()
    const s1 = newService(storage)
    const m1 = new TabStripModel<PageData>()
    s1.attach(m1)
    const t = m1.appendTab({ url: 'start' })
    s1.navigateTab(t.id, { url: 'deep-link' })
    await s1.saveNow()

    const second = await refresh(storage)
    second.service.scheduleResetCommands()
    await second.service.saveNow()

    const snapshot = await newService(storage).getLastSession()
    const tab = snapshot.windows[0]!.tabs[0]!
    expect(tab.navigations.map((n) => n.url)).toEqual(['deep-link'])
  })

  it('ignores navigation calls for unknown tabs', async () => {
    const storage = new InMemoryStorageBackend()
    const service = newService(storage)
    const model = new TabStripModel<PageData>()
    service.attach(model)
    expect(() => service.navigateTab('nope', { url: 'x' })).not.toThrow()
    expect(() => service.setSelectedNavigationIndex('nope', 0)).not.toThrow()
  })

  it('restores tabs from navigations alone via createTabData', async () => {
    const storage = new InMemoryStorageBackend()
    const service = newService(storage, { serializeTabData: () => undefined })
    const model = new TabStripModel<PageData>()
    service.attach(model)
    const t = model.appendTab({ url: 'live-only' })
    service.navigateTab(t.id, { url: 'from-history' })
    await service.saveNow()

    const { model: restored } = await refresh(storage, {
      createTabData: (tab) => ({ url: currentNavigationEntry(tab)!.url }),
    })
    expect(urls(restored)).toEqual(['from-history'])
  })
})

describe('restore options', () => {
  async function savedSession() {
    const storage = new InMemoryStorageBackend()
    const service = newService(storage)
    const model = new TabStripModel<PageData>()
    service.attach(model)
    model.appendTab({ url: 'a' })
    model.appendTab({ url: 'b' })
    model.appendTab({ url: 'c' })
    model.activateTabAt(1)
    await service.saveNow()
    return { storage, model }
  }

  it('deferLoading restores background tabs discarded', async () => {
    const { storage } = await savedSession()
    const { model } = await refresh(storage, { deferLoading: true })
    expect(model.activeIndex).toBe(1)
    expect(model.isTabDiscarded(0)).toBe(true)
    expect(model.isTabDiscarded(1)).toBe(false)
    expect(model.isTabDiscarded(2)).toBe(true)
  })

  it('preserveTabIds: false generates fresh ids and reports the mapping', async () => {
    const { storage, model: m1 } = await savedSession()
    const { model, result } = await refresh(storage, { preserveTabIds: false })
    expect(ids(model)).not.toEqual(ids(m1))
    expect(result.tabIdMap.size).toBe(3)
    for (const [saved, live] of result.tabIdMap) {
      expect(m1.getTabById(saved)).not.toBeNull()
      expect(model.getTabById(live)).not.toBeNull()
    }
  })

  it('falls back to a generated id when a preserved id already exists', async () => {
    const { storage } = await savedSession()
    const service = newService(storage)
    const model = new TabStripModel<PageData>()
    const snapshot = await service.getLastSession()
    const takenId = snapshot.windows[0]!.tabs[0]!.tabId
    model.addTab({ url: 'occupier' }, { id: takenId })

    const result = restoreSessionWindow(model, snapshot.windows[0]!)
    expect(result.tabsRestored).toBe(3)
    expect(result.tabIdMap.get(takenId)).not.toBe(takenId)
    expect(model.count).toBe(4)
  })
})

describe('multiple windows', () => {
  it('persists several windows plus the active window and restores each', async () => {
    const storage = new InMemoryStorageBackend()
    const s1 = newService(storage)
    const mA = new TabStripModel<PageData>()
    const mB = new TabStripModel<PageData>()
    s1.attach(mA, { windowId: 'alpha' })
    s1.attach(mB, { windowId: 'beta' })
    mA.appendTab({ url: 'a1' })
    mB.appendTab({ url: 'b1' })
    mB.appendTab({ url: 'b2' })
    s1.setActiveWindow('beta')
    await s1.saveNow()

    const s2 = newService(storage)
    const snapshot = await s2.getLastSession()
    expect(snapshot.windows.map((w) => w.windowId)).toEqual(['alpha', 'beta'])
    expect(snapshot.activeWindowId).toBe('beta')

    const mB2 = new TabStripModel<PageData>()
    restoreSessionWindow(mB2, snapshot.windows[1]!)
    expect(urls(mB2)).toEqual(['b1', 'b2'])
  })

  it('markWindowClosed drops the window from the next restore', async () => {
    const storage = new InMemoryStorageBackend()
    const s1 = newService(storage)
    const mA = new TabStripModel<PageData>()
    const mB = new TabStripModel<PageData>()
    s1.attach(mA, { windowId: 'alpha' })
    s1.attach(mB, { windowId: 'beta' })
    mA.appendTab({ url: 'a1' })
    mB.appendTab({ url: 'b1' })
    s1.markWindowClosed('beta')
    await s1.saveNow()

    const snapshot = await newService(storage).getLastSession()
    expect(snapshot.windows.map((w) => w.windowId)).toEqual(['alpha'])
  })

  it('rejects double attachment', () => {
    const storage = new InMemoryStorageBackend()
    const service = newService(storage)
    const model = new TabStripModel<PageData>()
    service.attach(model, { windowId: 'w' })
    expect(() => service.attach(new TabStripModel<PageData>(), { windowId: 'w' })).toThrow()
    expect(() => service.attach(model, { windowId: 'other' })).toThrow()
  })
})

describe('extra data', () => {
  it('round-trips tab and window extra data, surviving rewrites', async () => {
    const storage = new InMemoryStorageBackend()
    const s1 = newService(storage)
    const m1 = new TabStripModel<PageData>()
    s1.attach(m1)
    const t = m1.appendTab({ url: 'a' })
    s1.setTabExtraData(t.id, 'color', 'red')
    s1.setWindowExtraData(DEFAULT_WINDOW_ID, 'zoom', '1.5')
    await s1.saveNow()

    const second = await refresh(storage)
    expect(second.result.snapshot.windows[0]!.tabs[0]!.extraData).toEqual({ color: 'red' })
    expect(second.result.snapshot.windows[0]!.extraData).toEqual({ zoom: '1.5' })

    // Force a rewrite in session 2, then check session 3 still sees it.
    second.service.scheduleResetCommands()
    await second.service.saveNow()
    const snapshot = await newService(storage).getLastSession()
    expect(snapshot.windows[0]!.tabs[0]!.extraData).toEqual({ color: 'red' })
    expect(snapshot.windows[0]!.extraData).toEqual({ zoom: '1.5' })
  })
})
