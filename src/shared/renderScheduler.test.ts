import { afterEach, describe, expect, it, vi } from 'vitest'

import { RenderScheduler } from './renderScheduler'
import type { SchedulerHandleDeps } from './renderScheduler'

/** Manual clock/handle deps: nothing runs until the test fires a handle. */
function manualDeps(): SchedulerHandleDeps & { fire(handle: number): void; handles: number[]; canceled: number[] } {
  let nextHandle = 1
  const scheduled = new Map<number, () => void>()
  const handles: number[] = []
  const canceled: number[] = []
  return {
    handles,
    canceled,
    request(task: () => void): number {
      const handle = nextHandle++
      scheduled.set(handle, task)
      handles.push(handle)
      return handle
    },
    cancel(handle: number): void {
      canceled.push(handle)
      scheduled.delete(handle)
    },
    fire(handle: number): void {
      const task = scheduled.get(handle)
      if (!task) throw new Error(`handle ${handle} is not scheduled`)
      scheduled.delete(handle)
      task()
    }
  }
}

describe('RenderScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces many requests into one scheduled run with the latest task', () => {
    const deps = manualDeps()
    const scheduler = new RenderScheduler(deps)
    const runs: string[] = []

    scheduler.request(() => runs.push('first'))
    scheduler.request(() => runs.push('second'))
    scheduler.request(() => runs.push('third'))

    // One handle for the whole burst; nothing ran yet.
    expect(deps.handles).toHaveLength(1)
    expect(runs).toEqual([])
    expect(scheduler.pending).toBe(true)

    deps.fire(deps.handles[0])
    expect(runs).toEqual(['third'])
    expect(scheduler.pending).toBe(false)

    // A new request schedules a fresh handle.
    scheduler.request(() => runs.push('fourth'))
    expect(deps.handles).toHaveLength(2)
    deps.fire(deps.handles[1])
    expect(runs).toEqual(['third', 'fourth'])
  })

  it('flush runs the pending task synchronously and clears it', () => {
    const deps = manualDeps()
    const scheduler = new RenderScheduler(deps)
    const runs: string[] = []

    scheduler.request(() => runs.push('pending'))
    scheduler.flush()
    expect(runs).toEqual(['pending'])
    expect(scheduler.pending).toBe(false)
    // The canceled handle no longer runs anything if it fires.
    expect(deps.canceled).toEqual([deps.handles[0]])

    // Flushing without a pending task is a no-op.
    scheduler.flush()
    expect(runs).toEqual(['pending'])
  })

  it('flush propagates task errors to the caller', () => {
    const scheduler = new RenderScheduler(manualDeps())
    scheduler.request(() => {
      throw new Error('boom')
    })
    expect(() => scheduler.flush()).toThrow('boom')
    // The failing task was consumed; the scheduler is idle again.
    expect(scheduler.pending).toBe(false)
  })

  it('cancel drops the pending task without running it', () => {
    const deps = manualDeps()
    const scheduler = new RenderScheduler(deps)
    const runs: string[] = []

    scheduler.request(() => runs.push('dropped'))
    scheduler.cancel()
    expect(scheduler.pending).toBe(false)
    expect(runs).toEqual([])
    expect(deps.canceled).toEqual([deps.handles[0]])
    expect(() => deps.fire(deps.handles[0])).toThrow(/not scheduled/)
  })

  it('falls back to a timer when no rAF exists', () => {
    vi.useFakeTimers()
    const scheduler = new RenderScheduler()
    const runs: string[] = []

    scheduler.request(() => runs.push('timed'))
    expect(scheduler.pending).toBe(true)
    expect(runs).toEqual([])
    vi.advanceTimersByTime(16)
    expect(runs).toEqual(['timed'])
    expect(scheduler.pending).toBe(false)
  })

  it('uses requestAnimationFrame when the global exists', () => {
    const rafTasks: Array<() => void> = []
    vi.stubGlobal('requestAnimationFrame', (task: () => void) => {
      rafTasks.push(task)
      return 7
    })
    const cancelSpy = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancelSpy)
    try {
      const scheduler = new RenderScheduler()
      const runs: string[] = []
      scheduler.request(() => runs.push('painted'))
      expect(rafTasks).toHaveLength(1)
      rafTasks[0]()
      expect(runs).toEqual(['painted'])

      scheduler.request(() => runs.push('canceled'))
      scheduler.cancel()
      expect(cancelSpy).toHaveBeenCalledWith(7)
      expect(runs).toEqual(['painted'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
