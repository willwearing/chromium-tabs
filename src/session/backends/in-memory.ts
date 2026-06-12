/**
 * In-memory backend: no persistence beyond the object's lifetime. Useful for
 * tests, server-side rendering, and as the reference implementation of the
 * two-slot current/last contract.
 */

import type { CommandStorageBackend, ReadCommandsResult } from '../command-storage-backend'
import type { SessionCommand } from '../session-service-commands'

export class InMemoryStorageBackend implements CommandStorageBackend {
  private current_: SessionCommand[] | null = null
  private last_: SessionCommand[] | null = null

  appendCommands(commands: readonly SessionCommand[], truncate: boolean): void {
    if (truncate || this.current_ === null) this.current_ = []
    this.current_.push(...commands.map((c) => ({ ...c })))
  }

  readLastSessionCommands(): ReadCommandsResult {
    return { commands: (this.last_ ?? []).map((c) => ({ ...c })), errorReading: false }
  }

  moveCurrentSessionToLastSession(): void {
    if (this.current_ !== null) {
      this.last_ = this.current_
      this.current_ = null
    }
  }

  /** Test hook: the commands persisted for the current session, if any. */
  get currentSessionCommands(): readonly SessionCommand[] | null {
    return this.current_
  }

  /** Test hook: the commands persisted for the last session, if any. */
  get lastSessionCommands(): readonly SessionCommand[] | null {
    return this.last_
  }
}
