/**
 * Coalesces render requests: a burst of notifications (pointer moves, typing,
 * playback ticks) collapses into one scheduled run with the latest task
 * winning, so at most one render per frame happens no matter how many changes
 * arrived. Renders land through requestAnimationFrame right before the next
 * paint; the deps are injectable so tests run synchronously and DOM-free.
 */

export interface SchedulerHandleDeps {
  /** Schedules `task` and returns a handle that `cancel` understands. */
  request(task: () => void): number
  cancel(handle: number): void
}

function resolveDeps(deps: Partial<SchedulerHandleDeps> | undefined): SchedulerHandleDeps {
  const raf =
    typeof globalThis.requestAnimationFrame === 'function' &&
    typeof globalThis.cancelAnimationFrame === 'function'
      ? {
          request: (task: () => void) => globalThis.requestAnimationFrame(task),
          cancel: (handle: number) => globalThis.cancelAnimationFrame(handle)
        }
      : {
          request: (task: () => void) => globalThis.setTimeout(task, 16) as unknown as number,
          cancel: (handle: number) => globalThis.clearTimeout(handle)
        }
  return {
    request: deps?.request ?? raf.request,
    cancel: deps?.cancel ?? raf.cancel
  }
}

export class RenderScheduler {
  private readonly deps: SchedulerHandleDeps
  private handle: number | null = null
  private task: (() => void) | null = null

  constructor(deps?: Partial<SchedulerHandleDeps>) {
    this.deps = resolveDeps(deps)
  }

  /** True while a run is scheduled and has not executed yet. */
  get pending(): boolean {
    return this.task !== null
  }

  /** Requests a run: replaces any pending task and schedules only when none
   * is pending, so N requests in one frame produce exactly one run. */
  request(task: () => void): void {
    const scheduled = this.task !== null
    this.task = task
    if (scheduled) return
    // Note: a synchronous `request` dep runs the task before returning, so
    // pendingness is tracked by `task`, not by the handle.
    this.handle = this.deps.request(() => {
      this.handle = null
      this.runPending()
    })
  }

  /** Runs the pending task synchronously (tests, gesture end); a no-op
   * without one. Errors propagate to the caller. */
  flush(): void {
    if (this.handle !== null) {
      this.deps.cancel(this.handle)
      this.handle = null
    }
    this.runPending()
  }

  /** Drops the pending task without running it. */
  cancel(): void {
    if (this.handle !== null) {
      this.deps.cancel(this.handle)
      this.handle = null
    }
    this.task = null
  }

  private runPending(): void {
    const task = this.task
    this.task = null
    task?.()
  }
}
