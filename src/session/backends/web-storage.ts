/**
 * Web Storage backend: persists the command log to localStorage (default) or
 * sessionStorage. Both slots hold a JSON envelope `{version, commands}`; a
 * write replaces the whole value, so unlike Chrome's incremental file we
 * never need the trailing validity marker (command_storage_backend.cc writes
 * kInitialStateMarkerCommandId to detect torn writes) — setItem is atomic.
 *
 * Synchronous on purpose: a pagehide flush only works reliably when the
 * write completes before the handler returns.
 */

import type { CommandStorageBackend, ReadCommandsResult } from '../command-storage-backend'
import type { SessionCommand } from '../session-service-commands'

const ENVELOPE_VERSION = 1

export interface WebStorageBackendOptions {
  /** Key prefix; slots live at `<key>/current` and `<key>/last`. */
  key?: string
  /** Storage area to use. Defaults to window.localStorage. */
  storage?: Storage
}

interface Envelope {
  version: number
  commands: SessionCommand[]
}

export class WebStorageBackend implements CommandStorageBackend {
  /** Two realms over the same key contend for the same profile singleton. */
  readonly profileLockName: string

  private readonly storage_: Storage
  private readonly currentKey_: string
  private readonly lastKey_: string
  /** Parsed mirror of the current slot, so appends don't re-parse. */
  private currentCache_: SessionCommand[] | null = null

  constructor(options: WebStorageBackendOptions = {}) {
    const key = options.key ?? 'chromium-tabs/session'
    const storage = options.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
    if (!storage) {
      throw new Error('WebStorageBackend: no Storage available; pass options.storage')
    }
    this.storage_ = storage
    this.profileLockName = `chromium-tabs-profile/${key}`
    this.currentKey_ = `${key}/current`
    this.lastKey_ = `${key}/last`
  }

  appendCommands(commands: readonly SessionCommand[], truncate: boolean): void {
    const existing = truncate ? [] : (this.currentCache_ ?? this.readSlot_(this.currentKey_).commands)
    existing.push(...commands)
    this.currentCache_ = existing
    this.storage_.setItem(
      this.currentKey_,
      JSON.stringify({ version: ENVELOPE_VERSION, commands: existing } satisfies Envelope),
    )
  }

  readLastSessionCommands(): ReadCommandsResult {
    return this.readSlot_(this.lastKey_)
  }

  moveCurrentSessionToLastSession(): void {
    const current = this.storage_.getItem(this.currentKey_)
    if (current !== null) {
      this.storage_.setItem(this.lastKey_, current)
      this.storage_.removeItem(this.currentKey_)
    }
    this.currentCache_ = null
  }

  private readSlot_(key: string): ReadCommandsResult {
    const raw = this.storage_.getItem(key)
    if (raw === null) return { commands: [], errorReading: false }
    try {
      const parsed = JSON.parse(raw) as Partial<Envelope> | null
      if (
        parsed === null ||
        parsed.version !== ENVELOPE_VERSION ||
        !Array.isArray(parsed.commands)
      ) {
        return { commands: [], errorReading: true }
      }
      return { commands: parsed.commands, errorReading: false }
    } catch {
      return { commands: [], errorReading: true }
    }
  }
}
