import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TabStripModel } from '../src/core/tab-strip-model'
import { WebStorageBackend } from '../src/session/backends/web-storage'
import { FileStorageBackend } from '../src/session/node'
import { SessionService } from '../src/session/session-service'

interface PageData {
  url: string
}

const urls = (model: TabStripModel<PageData>) => model.getTabs().map((t) => t.data.url)

describe('WebStorageBackend', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('persists a session through localStorage across service instances', async () => {
    const s1 = new SessionService<PageData>({ storage: new WebStorageBackend({ key: 'app' }) })
    const m1 = new TabStripModel<PageData>()
    s1.attach(m1)
    m1.appendTab({ url: 'https://kept.test' })
    m1.appendTab({ url: 'https://also.test' })
    await s1.saveNow()
    s1.dispose()

    // "Reload": everything new except localStorage itself.
    const s2 = new SessionService<PageData>({ storage: new WebStorageBackend({ key: 'app' }) })
    const m2 = new TabStripModel<PageData>()
    const result = await s2.restoreInto(m2)
    expect(result.restored).toBe(true)
    expect(urls(m2)).toEqual(['https://kept.test', 'https://also.test'])
    s2.dispose()
  })

  it('isolates different key prefixes', async () => {
    const a = new WebStorageBackend({ key: 'a' })
    const b = new WebStorageBackend({ key: 'b' })
    a.appendCommands([{ id: 20, windowId: 'w' }], true)
    expect(b.readLastSessionCommands().commands).toEqual([])
    a.moveCurrentSessionToLastSession()
    expect(a.readLastSessionCommands().commands).toHaveLength(1)
    expect(b.readLastSessionCommands().commands).toEqual([])
  })

  it('reports corrupted slots without throwing', () => {
    localStorage.setItem('app/last', '{not json')
    const backend = new WebStorageBackend({ key: 'app' })
    expect(backend.readLastSessionCommands()).toEqual({ commands: [], errorReading: true })

    localStorage.setItem('app/last', JSON.stringify({ version: 999, commands: [] }))
    expect(backend.readLastSessionCommands().errorReading).toBe(true)
  })

  it('keeps the last session when no current session exists', () => {
    const backend = new WebStorageBackend({ key: 'app' })
    backend.appendCommands([{ id: 20, windowId: 'w' }], true)
    backend.moveCurrentSessionToLastSession()
    // Second rotation with an empty current slot must not clobber last.
    backend.moveCurrentSessionToLastSession()
    expect(backend.readLastSessionCommands().commands).toHaveLength(1)
  })

  it('supports sessionStorage via the storage option', () => {
    const backend = new WebStorageBackend({ key: 'app', storage: sessionStorage })
    backend.appendCommands([{ id: 20, windowId: 'w' }], true)
    expect(sessionStorage.getItem('app/current')).not.toBeNull()
    expect(localStorage.getItem('app/current')).toBeNull()
    sessionStorage.clear()
  })
})

describe('FileStorageBackend', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chromium-tabs-session-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists a session through the filesystem across "processes"', async () => {
    const s1 = new SessionService<PageData>({
      storage: new FileStorageBackend({ dir }),
      flushOnPageHide: false,
    })
    const m1 = new TabStripModel<PageData>()
    s1.attach(m1)
    m1.appendTab({ url: 'file://one' })
    m1.appendTab({ url: 'file://two' })
    m1.setTabPinned(1, true)
    await s1.saveNow()
    s1.dispose()

    const s2 = new SessionService<PageData>({
      storage: new FileStorageBackend({ dir }),
      flushOnPageHide: false,
    })
    const m2 = new TabStripModel<PageData>()
    const result = await s2.restoreInto(m2)
    expect(result.restored).toBe(true)
    expect(urls(m2)).toEqual(['file://two', 'file://one'])
    expect(m2.isTabPinned(0)).toBe(true)
    s2.dispose()
  })

  it('appends commands as JSONL and truncates on reset writes', () => {
    const backend = new FileStorageBackend({ dir, filePrefix: 'p' })
    backend.appendCommands([{ id: 20, windowId: 'a' }], true)
    backend.appendCommands([{ id: 20, windowId: 'b' }], false)
    const lines = readFileSync(join(dir, 'p-current.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)

    backend.appendCommands([{ id: 20, windowId: 'c' }], true)
    const truncated = readFileSync(join(dir, 'p-current.jsonl'), 'utf8').trim().split('\n')
    expect(truncated).toHaveLength(1)
  })

  it('tolerates a torn trailing line from a killed process', () => {
    const backend = new FileStorageBackend({ dir })
    backend.appendCommands(
      [
        { id: 0, windowId: 'w', tabId: 't' },
        { id: 30, tabId: 't', data: { url: 'safe' } },
      ],
      true,
    )
    backend.moveCurrentSessionToLastSession()
    // Simulate a write cut off mid-line.
    const lastPath = join(dir, 'session-last.jsonl')
    writeFileSync(lastPath, readFileSync(lastPath, 'utf8') + '{"id":30,"tabId"')

    const result = backend.readLastSessionCommands()
    expect(result.errorReading).toBe(true)
    expect(result.commands).toHaveLength(2)
  })

  it('rotation replaces the previous last session', () => {
    const backend = new FileStorageBackend({ dir })
    backend.appendCommands([{ id: 20, windowId: 'first' }], true)
    backend.moveCurrentSessionToLastSession()
    backend.appendCommands([{ id: 20, windowId: 'second' }], true)
    backend.moveCurrentSessionToLastSession()

    const commands = backend.readLastSessionCommands().commands
    expect(commands).toHaveLength(1)
    expect((commands[0] as { windowId: string }).windowId).toBe('second')
  })

  it('rotation with no current file keeps the last session', () => {
    const backend = new FileStorageBackend({ dir })
    backend.appendCommands([{ id: 20, windowId: 'keep' }], true)
    backend.moveCurrentSessionToLastSession()
    backend.moveCurrentSessionToLastSession()
    expect(backend.readLastSessionCommands().commands).toHaveLength(1)
  })
})
