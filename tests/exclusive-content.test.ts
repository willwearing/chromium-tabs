import { describe, expect, it } from 'vitest'
import { TabLifecycleManager } from '../src/core/tab-lifecycle-manager'
import { TabStripModel } from '../src/core/tab-strip-model'

type Page = { scene: string }

/** Enforcement runs on a microtask after model changes; flush two deep. */
const flush = () =>
  new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(() => resolve())))

function setup(scenes: string[], options: { keyFor?: (p: Page) => string | null } = {}) {
  const model = new TabStripModel<Page>()
  for (const scene of scenes) model.appendTab({ scene }, false)
  model.activateTabAt(0)
  const manager = new TabLifecycleManager(model, {
    maxLoadedTabs: null,
    exclusiveContentKey: (tab) => (options.keyFor ? options.keyFor(tab.data) : tab.data.scene),
  })
  const stop = manager.start()
  return { model, manager, stop }
}

describe('TabLifecycleManager exclusiveContentKey (one loaded tab per content key)', () => {
  it('discards the background duplicate, keeping the active tab loaded', async () => {
    const { model } = setup(['insight', 'insight'])
    await flush()
    expect(model.getTabAt(0).discarded).toBe(false)
    expect(model.getTabAt(1).discarded).toBe(true)
  })

  it('leaves distinct keys and null keys alone', async () => {
    const { model } = setup(['insight', 'dashboard', 'isolated', 'isolated'], {
      keyFor: (p) => (p.scene === 'isolated' ? null : p.scene),
    })
    await flush()
    expect(model.getTabs().map((t) => t.discarded)).toEqual([false, false, false, false])
  })

  it('discards a background tab the moment another tab navigates into its key', async () => {
    const { model } = setup(['insight', 'dashboard'])
    await flush()
    expect(model.getTabAt(0).discarded).toBe(false)
    expect(model.getTabAt(1).discarded).toBe(false)

    model.activateTabAt(1)
    model.setTabData(1, { scene: 'insight' }) // tab 2 navigates to the scene tab 1 holds
    await flush()
    expect(model.getTabAt(0).discarded).toBe(true) // background duplicate dropped
    expect(model.getTabAt(1).discarded).toBe(false) // active keeps its content
  })

  it('reload-on-focus ping-pong: activating the discarded duplicate restores it and discards the other', async () => {
    const { model } = setup(['insight', 'insight'])
    await flush()
    expect(model.getTabAt(1).discarded).toBe(true)

    model.activateTabAt(1) // restore-on-focus
    await flush()
    expect(model.getTabAt(1).discarded).toBe(false)
    expect(model.getTabAt(0).discarded).toBe(true)
  })

  it('overrides pinned and recently-active protections (correctness beats memory policy)', async () => {
    const model = new TabStripModel<Page>()
    model.appendTab({ scene: 'insight' }, false)
    model.appendTab({ scene: 'insight' }, false)
    model.setTabPinned(1, true) // pinned moves to index 0
    model.activateTabAt(1)
    const manager = new TabLifecycleManager(model, {
      maxLoadedTabs: null,
      protectPinnedTabs: true,
      canDiscardTab: () => false,
      exclusiveContentKey: (tab) => tab.data.scene,
    })
    manager.start()
    await flush()
    const pinned = model.getTabAt(0)
    expect(pinned.pinned).toBe(true)
    expect(pinned.discarded).toBe(true)
    expect(model.getTabAt(1).discarded).toBe(false)
  })

  it('with no active tab in the group, keeps the most recently active duplicate', async () => {
    const { model } = setup(['home', 'insight', 'insight'])
    model.getTabAt(1).lastActiveAt = 1000
    model.getTabAt(2).lastActiveAt = 2000
    await flush()
    expect(model.getTabAt(0).discarded).toBe(false)
    expect(model.getTabAt(1).discarded).toBe(true)
    expect(model.getTabAt(2).discarded).toBe(false)
  })
})
