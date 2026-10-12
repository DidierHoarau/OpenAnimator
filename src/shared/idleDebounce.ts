/**
 * Idle debouncer with a hard max-wait: the trailing timer restarts on every
 * `schedule()` — work runs only after `idleMs` without a change — but a
 * pending burst can never postpone the run past `maxWaitMs` counted from the
 * first pending schedule. Used by the autosave path, where a continuous
 * stream of edits must not starve the recovery snapshot.
 */

/** Autosave: trailing idle window before the snapshot is written. */
export const AUTOSAVE_IDLE_MS = 2500
/** Autosave: upper bound on how long an unsaved change can be pending. */
export const AUTOSAVE_MAX_WAIT_MS = 20000

/** Injectable timer surface, environment-agnostic (browser number handles,
 * Node Timeout objects, test fakes). */
export interface IdleDebounceDeps {
  setTimeout(handler: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

function defaultDeps(): IdleDebounceDeps {
  return {
    setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as never),
    now: () => Date.now()
  }
}

export class IdleDebouncer {
  private readonly idleMs: number
  private readonly maxWaitMs: number
  private readonly run: () => void
  private readonly deps: IdleDebounceDeps
  private handle: unknown = null
  /** When the pending burst started; null when nothing is pending. */
  private firstPendingAt: number | null = null

  constructor(
    idleMs: number,
    maxWaitMs: number,
    run: () => void,
    deps: IdleDebounceDeps = defaultDeps()
  ) {
    this.idleMs = idleMs
    this.maxWaitMs = maxWaitMs
    this.run = run
    this.deps = deps
  }

  /** True while a run is scheduled and not yet fired, flushed or cancelled. */
  get pending(): boolean {
    return this.firstPendingAt !== null
  }

  /** (Re)starts the trailing idle timer, capped by the max-wait deadline. */
  schedule(): void {
    const now = this.deps.now()
    if (this.firstPendingAt === null) this.firstPendingAt = now
    const deadline = this.firstPendingAt + this.maxWaitMs
    const delay = Math.max(0, Math.min(this.idleMs, deadline - now))
    if (this.handle !== null) {
      this.deps.clearTimeout(this.handle)
      this.handle = null
    }
    this.handle = this.deps.setTimeout(() => this.fire(), delay)
  }

  /** Runs the pending work immediately; no-op when nothing is pending. */
  flush(): void {
    if (this.firstPendingAt === null) return
    this.clearTimer()
    this.fire()
  }

  /** Drops the pending work without running it. */
  cancel(): void {
    this.clearTimer()
    this.firstPendingAt = null
  }

  private clearTimer(): void {
    if (this.handle !== null) {
      this.deps.clearTimeout(this.handle)
      this.handle = null
    }
  }

  private fire(): void {
    this.handle = null
    this.firstPendingAt = null
    this.run()
  }
}
