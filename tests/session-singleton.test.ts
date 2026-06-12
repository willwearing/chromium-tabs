import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabStripModel } from '../src/core/tab-strip-model'
import { InMemoryStorageBackend } from '../src/session/backends/in-memory'
import { WebStorageBackend } from '../src/session/backends/web-storage'
import {
  WebLocksProcessSingleton,
  createDefaultProcessSingleton,
} from '../src/session/process-singleton'
import { SessionCommandId, type SessionCommand } from '../src/session/session-service-commands'
import { SessionService } from '../src/session/session-service'

interface PageData {
  url: string
}

const urls = (model: TabStripModel<PageData>) => model.getTabs().map((t) => t.data.url)

/**
 * Minimal Web Locks stand-in (jsdom has none): exclusive locks, ifAvailable
 * only — the only mode the singleton uses. Held while the callback's
 * returned promise is pending, released when it settles, exactly per spec.
 */
class FakeLockManager {
  private readonly held = new Set<string>()

  async request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: { name: string; mode: string } | null) => unknown,
  ): Promise<unknown> {
    if (this.held.has(name)) {
      if (options.ifAvailable) return await callback(null)
      throw new Error('FakeLockManager supports ifAvailable requests only')
    }
    this.held.add(name)
    try {
      return await callback({ name, mode: 'exclusive' })
    } finally {
      this.held.delete(name)
    }
  }

  isHeld(name: string): boolean {
    return this.held.has(name)
  }
}

const asLockManager = (fake: FakeLockManager) => fake as unknown as LockManager

/** One simulated browser tab: its own service + model over shared storage/locks. */
function realm(storage: InMemoryStorageBackend, locks: FakeLockManager) {
  const service = new SessionService<PageData>({
    storage,
    processSingleton: new WebLocksProcessSingleton({ name: 'profile', locks: asLockManager(locks) }),
  })
  const model = new TabStripModel<PageData>()
  return { service, model }
}

const dataUrls = (commands: readonly SessionCommand[] | null) =>
  (commands ?? [])
    .filter((c): c is Extract<SessionCommand, { id: 30 }> => c.id === SessionCommandId.SET_TAB_DATA)
    .map((c) => (c.data as PageData).url)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('process singleton: one session writer per profile', () => {
  it('a second realm stands down: no rotation steal, no duplication', async () => {
    const storage = new InMemoryStorageBackend()
    const locks = new FakeLockManager()

    const a = realm(storage, locks)
    const ra = await a.service.restoreInto(a.model)
    expect(ra.ownership).toBe('owner')
    a.model.appendTab({ url: 'a-tab' })
    await a.service.saveNow()

    // Realm B boots over the same profile while A is live.
    const b = realm(storage, locks)
    const rb = await b.service.restoreInto(b.model)
    expect(rb.ownership).toBe('secondary')
    expect(rb.restored).toBe(false)
    expect(b.model.count).toBe(0)

    // Failure mode 1 fixed: B's boot did not rotate A's live log away.
    expect(dataUrls(storage.currentSessionCommands)).toContain('a-tab')

    // A keeps recording normally.
    a.model.appendTab({ url: 'a-tab-2' })
    await a.service.saveNow()

    // "Refresh" A: the realm dies, a fresh one boots and claims the profile.
    a.service.dispose()
    const a2 = realm(storage, locks)
    const ra2 = await a2.service.restoreInto(a2.model)
    expect(ra2.ownership).toBe('owner')
    expect(urls(a2.model)).toEqual(['a-tab', 'a-tab-2'])
  })

  it('a secondary never writes: concurrent last-writer-wins is impossible', async () => {
    const storage = new InMemoryStorageBackend()
    const locks = new FakeLockManager()

    const a = realm(storage, locks)
    await a.service.restoreInto(a.model)
    a.model.appendTab({ url: 'a-tab' })

    const b = realm(storage, locks)
    await b.service.restoreInto(b.model)
    b.model.appendTab({ url: 'b-tab' })
    b.service.navigateTab(b.model.getTabAt(0).id, { url: 'b-nav' })

    await a.service.saveNow()
    await b.service.saveNow()

    const persisted = dataUrls(storage.currentSessionCommands)
    expect(persisted).toContain('a-tab')
    expect(persisted).not.toContain('b-tab')
    // B's model still works locally — it just isn't persisted.
    expect(urls(b.model)).toEqual(['b-tab'])
  })

  it('an orphaned profile is adopted by the next realm to boot', async () => {
    const storage = new InMemoryStorageBackend()
    const locks = new FakeLockManager()

    const a = realm(storage, locks)
    await a.service.restoreInto(a.model)
    a.model.appendTab({ url: 'left-behind' })
    await a.service.saveNow()
    a.service.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(locks.isHeld('profile')).toBe(false)

    const c = realm(storage, locks)
    const rc = await c.service.restoreInto(c.model)
    expect(rc.ownership).toBe('owner')
    expect(urls(c.model)).toEqual(['left-behind'])
  })

  it('a rebooted secondary claims the profile once the owner is gone', async () => {
    const storage = new InMemoryStorageBackend()
    const locks = new FakeLockManager()

    const a = realm(storage, locks)
    await a.service.restoreInto(a.model)
    a.model.appendTab({ url: 'a-session' })
    await a.service.saveNow()

    const b = realm(storage, locks)
    await b.service.restoreInto(b.model)
    expect(b.service.ownership).toBe('secondary')

    // A closes for good; B is later refreshed (its realm reboots).
    a.service.dispose()
    b.service.dispose()
    const b2 = realm(storage, locks)
    const rb2 = await b2.service.restoreInto(b2.model)

    // Continue where you left off: the profile's session is A's last state.
    expect(rb2.ownership).toBe('owner')
    expect(urls(b2.model)).toEqual(['a-session'])
  })

  it('models attached before the claim resolves are captured by the post-grant snapshot', async () => {
    const storage = new InMemoryStorageBackend()
    const locks = new FakeLockManager()

    const a = realm(storage, locks)
    a.service.attach(a.model) // synchronously, while ownership is 'pending'
    a.model.appendTab({ url: 'early' })
    expect(a.service.ownership).toBe('pending')

    await a.service.saveNow() // waits out the claim
    expect(a.service.ownership).toBe('owner')
    await a.service.saveNow() // flushes the SetSavingEnabled(true) snapshot

    expect(dataUrls(storage.currentSessionCommands)).toContain('early')
  })

  it('dispose before the grant resolves still leaves the profile claimable', async () => {
    const storage = new InMemoryStorageBackend()
    const locks = new FakeLockManager()

    const a = realm(storage, locks)
    a.service.dispose() // immediately, before the lock callback has run
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(locks.isHeld('profile')).toBe(false)

    const c = realm(storage, locks)
    const rc = await c.service.restoreInto(c.model)
    expect(rc.ownership).toBe('owner')
  })
})

describe('WebLocksProcessSingleton', () => {
  it('grants ownership when free and stands contenders down', async () => {
    const locks = asLockManager(new FakeLockManager())
    const first = new WebLocksProcessSingleton({ name: 'p', locks })
    const second = new WebLocksProcessSingleton({ name: 'p', locks })
    await expect(first.acquire()).resolves.toBe('owner')
    await expect(second.acquire()).resolves.toBe('secondary')

    first.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const third = new WebLocksProcessSingleton({ name: 'p', locks })
    await expect(third.acquire()).resolves.toBe('owner')
  })

  it('acquire is idempotent', async () => {
    const singleton = new WebLocksProcessSingleton({ name: 'p', locks: asLockManager(new FakeLockManager()) })
    const p1 = singleton.acquire()
    expect(singleton.acquire()).toBe(p1)
    await expect(p1).resolves.toBe('owner')
  })

  it('falls back to sole ownership without a lock manager', async () => {
    // jsdom has no navigator.locks, so the default lookup finds nothing.
    const singleton = new WebLocksProcessSingleton({ name: 'p' })
    await expect(singleton.acquire()).resolves.toBe('owner')
  })

  it('falls back to sole ownership when the lock manager fails', async () => {
    const broken = { request: () => Promise.reject(new Error('nope')) } as unknown as LockManager
    const singleton = new WebLocksProcessSingleton({ name: 'p', locks: broken })
    await expect(singleton.acquire()).resolves.toBe('owner')
  })
})

describe('default wiring', () => {
  it('returns null without a profile name or without Web Locks', () => {
    expect(createDefaultProcessSingleton(undefined)).toBeNull()
    // jsdom: navigator exists but navigator.locks does not.
    expect(createDefaultProcessSingleton('some-profile')).toBeNull()
  })

  it('coordinates two default-wired services over the same WebStorageBackend key', async () => {
    const locks = new FakeLockManager()
    vi.stubGlobal('navigator', { locks: asLockManager(locks) })
    localStorage.clear()

    const sA = new SessionService<PageData>({ storage: new WebStorageBackend({ key: 'app' }) })
    const mA = new TabStripModel<PageData>()
    const rA = await sA.restoreInto(mA)
    expect(rA.ownership).toBe('owner')

    const sB = new SessionService<PageData>({ storage: new WebStorageBackend({ key: 'app' }) })
    const mB = new TabStripModel<PageData>()
    const rB = await sB.restoreInto(mB)
    expect(rB.ownership).toBe('secondary')

    // A different key is a different profile: its own singleton, own owner.
    const sC = new SessionService<PageData>({ storage: new WebStorageBackend({ key: 'other-app' }) })
    const mC = new TabStripModel<PageData>()
    const rC = await sC.restoreInto(mC)
    expect(rC.ownership).toBe('owner')

    sA.dispose()
    sB.dispose()
    sC.dispose()
  })
})
