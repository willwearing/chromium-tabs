/**
 * Buffers commands and flushes them to a storage backend on a delay.
 * Ported from chromium-reference/components/sessions/core/command_storage_manager.cc.
 *
 * Chrome posts backend writes to a sequenced task runner; this port chains
 * them on a promise queue so writes land in order even when the backend is
 * asynchronous. Saves snapshot the pending buffer synchronously, exactly
 * like Chrome moving pending_commands_ into the posted task (cc:251).
 */

import type { CommandStorageBackend } from './command-storage-backend'
import type { SessionCommand } from './session-service-commands'

/** Delay before pending commands are written. Mirrors kSaveDelay (cc:36). */
export const SAVE_DELAY_MS = 2500

/** Mirrors CommandStorageManagerDelegate (command_storage_manager_delegate.h). */
export interface CommandStorageManagerDelegate {
  /** Called before each save; a chance to append more commands (cc:255). */
  onWillSaveCommands?(): void
  /** A backend write failed; schedule a full rebuild (delegate.h:29). */
  onErrorWritingSessionCommands?(): void
}

export interface CommandStorageManagerOptions {
  backend: CommandStorageBackend
  delegate?: CommandStorageManagerDelegate
  saveDelayMs?: number
  /**
   * Awaited before the first backend write — the SessionService uses this to
   * make sure the previous session has been rotated to the "last" slot
   * before this session's first (truncating) write can clobber it.
   */
  ready?: Promise<unknown>
}

export class CommandStorageManager {
  private readonly backend_: CommandStorageBackend
  private readonly delegate_: CommandStorageManagerDelegate
  private readonly saveDelayMs_: number

  private pendingCommands_: SessionCommand[] = []
  /** Starts true: the first save is always a complete rewrite (cc:117). */
  private pendingReset_ = true
  private commandsSinceReset_ = 0
  private saveTimer_: ReturnType<typeof setTimeout> | null = null
  /** Sequenced "task runner" for backend writes. */
  private queue_: Promise<void> = Promise.resolve()
  /** Backend operations started but not yet settled. */
  private inflight_ = 0

  constructor(options: CommandStorageManagerOptions) {
    this.backend_ = options.backend
    this.delegate_ = options.delegate ?? {}
    this.saveDelayMs_ = options.saveDelayMs ?? SAVE_DELAY_MS
    if (options.ready) {
      // The gate counts as an in-flight operation so nothing overtakes it.
      this.inflight_++
      this.queue_ = options.ready.then(
        () => {
          this.inflight_--
        },
        () => {
          this.inflight_--
        },
      )
    }
  }

  /**
   * Runs a backend operation. When nothing is in flight it runs inline — a
   * synchronous backend then completes before this returns, which is what
   * makes a pagehide flush reliable (the web stand-in for Chrome's
   * BLOCK_SHUTDOWN task traits). Otherwise it is sequenced behind the queue.
   */
  private enqueue_(operation: () => void | Promise<void>): Promise<void> {
    const wasIdle = this.inflight_ === 0
    this.inflight_++
    if (wasIdle) {
      let result: void | Promise<void>
      try {
        result = operation()
      } catch {
        this.inflight_--
        this.delegate_.onErrorWritingSessionCommands?.()
        return this.queue_
      }
      if (result && typeof result.then === 'function') {
        this.queue_ = result.then(
          () => {
            this.inflight_--
          },
          () => {
            this.inflight_--
            this.delegate_.onErrorWritingSessionCommands?.()
          },
        )
      } else {
        this.inflight_--
      }
      return this.queue_
    }
    this.queue_ = this.queue_
      .then(() => operation())
      .then(
        () => {
          this.inflight_--
        },
        () => {
          this.inflight_--
          this.delegate_.onErrorWritingSessionCommands?.()
        },
      )
    return this.queue_
  }

  get pendingReset(): boolean {
    return this.pendingReset_
  }

  /** Mirrors set_pending_reset (command_storage_manager.h:77). */
  setPendingReset(value: boolean): void {
    this.pendingReset_ = value
  }

  get commandsSinceReset(): number {
    return this.commandsSinceReset_
  }

  /** Buffers a command and starts the save timer. Mirrors cc:192. */
  scheduleCommand(command: SessionCommand): void {
    this.commandsSinceReset_++
    this.pendingCommands_.push(command)
    this.startSaveTimer()
  }

  /** Buffers rebuild commands without starting the timer. Mirrors cc:207. */
  appendRebuildCommands(commands: readonly SessionCommand[]): void {
    this.commandsSinceReset_ += commands.length
    this.pendingCommands_.push(...commands)
  }

  appendRebuildCommand(command: SessionCommand): void {
    this.appendRebuildCommands([command])
  }

  /** Removes a not-yet-saved command. Mirrors EraseCommand (cc:216). */
  eraseCommand(command: SessionCommand): void {
    const i = this.pendingCommands_.indexOf(command)
    if (i === -1) throw new Error('eraseCommand: command is not pending')
    this.pendingCommands_.splice(i, 1)
    this.commandsSinceReset_--
  }

  /** Replaces a not-yet-saved command in place. Mirrors SwapCommand (cc:225). */
  swapCommand(oldCommand: SessionCommand, newCommand: SessionCommand): void {
    const i = this.pendingCommands_.indexOf(oldCommand)
    if (i === -1) throw new Error('swapCommand: command is not pending')
    this.pendingCommands_[i] = newCommand
  }

  /** Mirrors ClearPendingCommands (cc:233) — note it does not zero the reset counter. */
  clearPendingCommands(): void {
    this.commandsSinceReset_ -= this.pendingCommands_.length
    this.pendingCommands_ = []
  }

  /** Read-only view for ReplacePendingCommand-style optimizations. */
  get pendingCommands(): readonly SessionCommand[] {
    return this.pendingCommands_
  }

  /** True between startSaveTimer() and the save it scheduled. Mirrors cc:316. */
  get hasPendingSave(): boolean {
    return this.saveTimer_ !== null
  }

  /** Schedules a save in saveDelayMs unless one is already pending. Mirrors cc:239. */
  startSaveTimer(): void {
    if (this.saveTimer_ !== null) return
    this.saveTimer_ = setTimeout(() => {
      this.saveTimer_ = null
      this.save()
    }, this.saveDelayMs_)
  }

  /**
   * Flushes pending commands to the backend. Mirrors Save (cc:251): the
   * buffer and reset flag are snapshotted synchronously; the write itself is
   * sequenced behind earlier writes. Returns once this write has settled.
   */
  save(): Promise<void> {
    if (this.saveTimer_ !== null) {
      clearTimeout(this.saveTimer_)
      this.saveTimer_ = null
    }

    this.delegate_.onWillSaveCommands?.()

    if (this.pendingCommands_.length === 0) return this.queue_

    const commands = this.pendingCommands_
    const truncate = this.pendingReset_
    this.pendingCommands_ = []
    if (this.pendingReset_) {
      this.commandsSinceReset_ = 0
      this.pendingReset_ = false
    }

    // Errors land in onErrorWritingSessionCommands (mirrors
    // OnErrorWritingToFile): surviving state is recovered by a full rebuild
    // on the next save, so the lost commands don't matter.
    return this.enqueue_(() => this.backend_.appendCommands(commands, truncate))
  }

  /** Cancels any timer and flushes immediately. */
  saveNow(): Promise<void> {
    return this.save()
  }

  /**
   * Promotes the current session to "last". Pending commands are flushed
   * first, mirroring MoveCurrentSessionToLastSession (cc:320). The caller is
   * expected to follow up with setPendingReset(true) plus a full re-emit of
   * live state, since the current session is now empty.
   */
  moveCurrentSessionToLastSession(): Promise<void> {
    this.save()
    return this.enqueue_(() => this.backend_.moveCurrentSessionToLastSession())
  }

  /** Stops the save timer without flushing. */
  dispose(): void {
    if (this.saveTimer_ !== null) {
      clearTimeout(this.saveTimer_)
      this.saveTimer_ = null
    }
  }
}
