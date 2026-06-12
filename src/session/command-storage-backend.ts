/**
 * Storage backend interface. Ported from
 * chromium-reference/components/sessions/core/command_storage_backend.h.
 *
 * Chrome's backend owns timestamped SNSS files under Sessions/ and tracks
 * which one is the "last session" (the previous run) versus the "current
 * session" (this run). This port reduces that to two slots — `current` and
 * `last` — over any storage primitive. Implementations may be synchronous
 * (web storage) or asynchronous (IndexedDB, files); CommandStorageManager
 * awaits either.
 */

import type { SessionCommand } from './session-service-commands'

/** Mirrors CommandStorageBackend::ReadCommandsResult (h:81). */
export interface ReadCommandsResult {
  commands: SessionCommand[]
  /**
   * True when the stored data was missing pieces, unparsable, or otherwise
   * suspect. Whatever could be read is still in `commands`.
   */
  errorReading: boolean
}

export interface CommandStorageBackend {
  /**
   * Identifies this storage area for cross-realm singleton coordination —
   * the analog of Chrome naming its ProcessSingleton after the user data
   * directory (process_singleton.h:45). Backends that can be reached from
   * several realms at once (web storage) must provide it; backends that
   * cannot (in-memory) leave it undefined and the service acts as sole
   * owner.
   */
  readonly profileLockName?: string

  /**
   * Persists commands to the current session. With `truncate` the current
   * session is replaced wholesale (the pending commands are a complete
   * snapshot); otherwise they are appended. Mirrors
   * CommandStorageBackend::AppendCommands (h:120).
   */
  appendCommands(commands: readonly SessionCommand[], truncate: boolean): void | Promise<void>

  /** Reads the previous session's log. Mirrors GetLastSessionCommands. */
  readLastSessionCommands(): ReadCommandsResult | Promise<ReadCommandsResult>

  /**
   * Promotes the current session to "last" and starts an empty current
   * session. When no current session exists (the previous run died before
   * its first save), the existing last session is left untouched so it can
   * still be restored. Mirrors MoveCurrentSessionToLastSession (h:131).
   */
  moveCurrentSessionToLastSession(): void | Promise<void>
}
