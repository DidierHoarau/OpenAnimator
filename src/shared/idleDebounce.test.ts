import { describe, expect, it } from 'vitest'

import { AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_WAIT_MS, IdleDebouncer } from './idleDebounce'
import type { IdleDebounceDeps } from './idleDebounce'

/** Deterministic timer harness: manual clock plus one-shot timers. */
function fakeClock(): { deps: IdleDebounceDeps; advance(ms: number): void } {
  let now = 0
  let nextId = 1
  const scheduled = new Map<number, { at: number; task: () => void }>()
  return {
    deps: {
      setTimeout: (task, ms) => {
        const id = nextId++
        scheduled.set(id, { at: now + ms, task })
        return id
      },
      clearTimeout: (handle) => {
        scheduled.delete(handle as number)
      },
      now: () => now
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        let dueId = -1
        let dueAt = Infinity
        for (const [id, entry] of scheduled) {
          if (entry.at <= target && entry.at < dueAt) {
            dueId = id
            dueAt = entry.at
          }
        }
        if (dueId === -1) break
        const entry = scheduled.get(dueId)!
        scheduled.delete(dueId)
        now = entry.at
        entry.task()
      }
      now = target
    }
  }
}

describe('IdleDebouncer', () => {
  it('restarts the trailing timer on every schedule', () => {
    const clock = fakeClock()
    const runs: number[] = []
    const debouncer = new IdleDebouncer(2500, 20000, () => runs.push(clock.deps.now()), clock.deps)

    debouncer.schedule()
    expect(debouncer.pending).toBe(true)
    clock.advance(2000)
    expect(runs).toEqual([])

    // One second before the idle deadline a new change restarts the window.
    debouncer.schedule()
    clock.advance(2499)
    expect(runs).toEqual([])
    clock.advance(1)
    expect(runs).toEqual([4500])
    expect(debouncer.pending).toBe(false)
  })

  it('forces a run at the max-wait deadline under a continuous stream', () => {
    const clock = fakeClock()
    const runs: number[] = []
    const debouncer = new IdleDebouncer(2500, 20000, () => runs.push(clock.deps.now()), clock.deps)

    // A change every 2 s: the trailing timer alone would never fire.
    for (let elapsed = 0; elapsed < 18000; elapsed += 2000) {
      debouncer.schedule()
      clock.advance(2000)
      expect(runs).toEqual([])
    }
    // 20 s after the first pending change: the max wait forces the run.
    debouncer.schedule()
    clock.advance(1999)
    expect(runs).toEqual([])
    clock.advance(1)
    expect(runs).toEqual([20000])
    expect(debouncer.pending).toBe(false)
  })

  it('starts a fresh pending window after a run', () => {
    const clock = fakeClock()
    const runs: number[] = []
    const debouncer = new IdleDebouncer(2500, 20000, () => runs.push(clock.deps.now()), clock.deps)

    debouncer.schedule()
    clock.advance(2500)
    expect(runs).toEqual([2500])

    debouncer.schedule()
    clock.advance(2499)
    expect(runs).toEqual([2500])
    clock.advance(1)
    expect(runs).toEqual([2500, 5000])
  })

  it('flush runs pending work immediately and is a no-op when idle', () => {
    const clock = fakeClock()
    const runs: number[] = []
    const debouncer = new IdleDebouncer(2500, 20000, () => runs.push(clock.deps.now()), clock.deps)

    debouncer.flush()
    expect(runs).toEqual([])

    debouncer.schedule()
    clock.advance(1000)
    debouncer.flush()
    expect(runs).toEqual([1000])
    expect(debouncer.pending).toBe(false)

    // The flushed timer cannot fire a second time.
    clock.advance(10000)
    expect(runs).toEqual([1000])
  })

  it('cancel drops the pending run', () => {
    const clock = fakeClock()
    const runs: number[] = []
    const debouncer = new IdleDebouncer(2500, 20000, () => runs.push(clock.deps.now()), clock.deps)

    debouncer.schedule()
    debouncer.cancel()
    expect(debouncer.pending).toBe(false)
    clock.advance(30000)
    expect(runs).toEqual([])
  })

  it('exposes the autosave constants', () => {
    expect(AUTOSAVE_IDLE_MS).toBe(2500)
    expect(AUTOSAVE_MAX_WAIT_MS).toBe(20000)
  })
})
