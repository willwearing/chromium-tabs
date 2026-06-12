/**
 * One session writer per profile. Ported from
 * chromium-reference/chrome/browser/process_singleton.h.
 *
 * Chrome never lets two processes share a profile directory: ProcessSingleton
 * is "named according to the user data directory, so we can be sure that no
 * more than one copy of the application can be running at once with a given
 * data directory" (h:45). A second launch gets PROCESS_NOTIFIED and stands
 * down; only the PROCESS_NONE winner runs a SessionService over the profile.
 *
 * Two browser tabs of the same app are the web's version of two processes
 * sharing a profile. The web cannot make the second tab exit, but it can make
 * it stand down: the loser becomes a "secondary" SessionService with saving
 * disabled (the SetSavingEnabled(false) state, session_service_base.cc:877)
 * that neither rotates nor writes the shared log.
 *
 * The claim is made once, at startup, exactly like Chrome's — there is no
 * mid-life takeover. When the owner dies its lock evaporates with the realm
 * (the Web Lock analog of the OS reclaiming Chrome's SingletonLock), and the
 * next realm to BOOT over that profile claims it and restores the session.
 */

/** 'owner' ~ PROCESS_NONE, 'secondary' ~ PROCESS_NOTIFIED (h:85). */
export type ProcessSingletonResult = 'owner' | 'secondary'

export interface ProcessSingleton {
  /**
   * Attempts to become the singleton for the profile. Resolves exactly once;
   * repeated calls return the same promise. Mirrors
   * NotifyOtherProcessOrCreate (h:119).
   */
  acquire(): Promise<ProcessSingletonResult>
  /** Releases the claim if held. Mirrors Cleanup (h:133). Idempotent. */
  release(): void
}

export interface WebLocksProcessSingletonOptions {
  /** Lock name. One storage area (profile) = one name. */
  name: string
  /** Injectable for tests / non-window realms. Defaults to navigator.locks. */
  locks?: LockManager
}

/**
 * First attempt immediately, then short re-checks. Chrome's analog is
 * kRetryAttempts/kTimeoutInSeconds (process_singleton_posix.cc:137-140).
 */
const CLAIM_ATTEMPT_DELAYS_MS = [0, 0, 50]

/**
 * ProcessSingleton over the Web Locks API. The owner holds an exclusive lock
 * named for the profile until release() or realm death; contenders ask with
 * ifAvailable and stand down instead of queueing, mirroring Chrome's
 * startup-time claim.
 */
export class WebLocksProcessSingleton implements ProcessSingleton {
  private readonly name_: string
  private readonly locks_: LockManager | undefined
  private acquirePromise_: Promise<ProcessSingletonResult> | null = null
  private releaseHold_: (() => void) | null = null
  private released_ = false

  constructor(options: WebLocksProcessSingletonOptions) {
    this.name_ = options.name
    this.locks_ =
      options.locks ?? (typeof navigator !== 'undefined' ? navigator.locks : undefined)
  }

  acquire(): Promise<ProcessSingletonResult> {
    if (!this.acquirePromise_) this.acquirePromise_ = this.acquireWithRetries_()
    return this.acquirePromise_
  }

  /**
   * Claim with bounded retries. Chrome's POSIX singleton retries its claim
   * the same way — kRetryAttempts with timeout/retry_attempts sleeps
   * (process_singleton_posix.cc:137-140, :794) — because a dying holder's
   * lock disappears asynchronously. Web Lock releases also propagate
   * asynchronously (the holder resolves its callback promise), so a realm
   * booting right after another one released (HMR, dispose-then-reconstruct)
   * needs a beat before the lock reads as free. A lock still held after the
   * final attempt belongs to a live realm: stand down.
   */
  private async acquireWithRetries_(): Promise<ProcessSingletonResult> {
    const locks = this.locks_
    if (!locks) {
      // No lock manager: behave as the sole instance, today's single-realm
      // behavior. (Chrome treats an unusable singleton as fatal — LOCK_ERROR
      // — but a library breaking persistence outright would be worse than
      // the vanishingly rare double-owner.)
      return this.released_ ? 'secondary' : 'owner'
    }
    for (const delayMs of CLAIM_ATTEMPT_DELAYS_MS) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (this.released_) return 'secondary'
      const result = await this.tryClaim_(locks)
      if (result === 'owner') return 'owner'
    }
    return 'secondary'
  }

  private tryClaim_(locks: LockManager): Promise<ProcessSingletonResult> {
    return new Promise<ProcessSingletonResult>((resolve) => {
      locks
        .request(this.name_, { ifAvailable: true }, (lock) => {
          if (lock === null) {
            resolve('secondary')
            return undefined
          }
          if (this.released_) {
            // Released before the grant arrived: let the lock go right away.
            resolve('secondary')
            return undefined
          }
          return new Promise<void>((releaseHold) => {
            this.releaseHold_ = releaseHold
            resolve('owner')
          })
        })
        .catch(() => {
          // Lock manager failure: same sole-instance fallback as above.
          resolve('owner')
        })
    })
  }

  release(): void {
    this.released_ = true
    if (this.releaseHold_) {
      this.releaseHold_()
      this.releaseHold_ = null
    }
  }
}

/**
 * The default wiring: Web Locks keyed by the backend's profile name when the
 * platform has them, otherwise sole ownership (SSR, Node, older browsers —
 * today's behavior).
 */
export function createDefaultProcessSingleton(
  profileLockName: string | undefined,
): ProcessSingleton | null {
  if (!profileLockName) return null
  if (typeof navigator === 'undefined' || !navigator.locks) return null
  return new WebLocksProcessSingleton({ name: profileLockName })
}
