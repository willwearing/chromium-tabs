/**
 * File-system backend for Node, Bun, and Electron — the "process restart"
 * counterpart to WebStorageBackend. Closest in spirit to Chrome's
 * CommandStorageBackend: the current session is an append-only file of
 * newline-delimited JSON commands, rotated to the last-session file when a
 * new session starts.
 *
 * A process killed mid-append leaves at most one torn trailing line;
 * readLastSessionCommands stops there and reports errorReading, mirroring
 * Chrome's partial-read tolerance (command_storage_backend.cc).
 *
 * Import from 'chromium-tabs/session/node' so browser bundles never see
 * node:fs.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { CommandStorageBackend, ReadCommandsResult } from './command-storage-backend'
import type { SessionCommand } from './session-service-commands'

export interface FileStorageBackendOptions {
  /** Directory for the session files (created on demand). */
  dir: string
  /** File name prefix; files are `<prefix>-current.jsonl` and `<prefix>-last.jsonl`. */
  filePrefix?: string
}

export class FileStorageBackend implements CommandStorageBackend {
  private readonly currentPath_: string
  private readonly lastPath_: string

  constructor(options: FileStorageBackendOptions) {
    const prefix = options.filePrefix ?? 'session'
    this.currentPath_ = join(options.dir, `${prefix}-current.jsonl`)
    this.lastPath_ = join(options.dir, `${prefix}-last.jsonl`)
  }

  appendCommands(commands: readonly SessionCommand[], truncate: boolean): void {
    const lines = commands.map((c) => JSON.stringify(c)).join('\n') + (commands.length > 0 ? '\n' : '')
    mkdirSync(dirname(this.currentPath_), { recursive: true })
    if (truncate) {
      writeFileSync(this.currentPath_, lines)
    } else if (existsSync(this.currentPath_)) {
      appendFileSync(this.currentPath_, lines)
    } else {
      writeFileSync(this.currentPath_, lines)
    }
  }

  readLastSessionCommands(): ReadCommandsResult {
    if (!existsSync(this.lastPath_)) return { commands: [], errorReading: false }
    let raw: string
    try {
      raw = readFileSync(this.lastPath_, 'utf8')
    } catch {
      return { commands: [], errorReading: true }
    }
    const commands: SessionCommand[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        commands.push(JSON.parse(line) as SessionCommand)
      } catch {
        // Torn write at process death: keep what we have.
        return { commands, errorReading: true }
      }
    }
    return { commands, errorReading: false }
  }

  moveCurrentSessionToLastSession(): void {
    if (!existsSync(this.currentPath_)) return
    if (existsSync(this.lastPath_)) rmSync(this.lastPath_)
    renameSync(this.currentPath_, this.lastPath_)
  }
}
