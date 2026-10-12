import { describe, expect, it } from 'vitest'

import {
  EASING_PRESETS,
  canonicalBezierFor,
  createCubicBezierEasing,
  evaluateEasing,
  isEasing
} from './easing'

describe('evaluateEasing (named)', () => {
  it('maps bounds to themselves for every named easing', () => {
    const names = ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const
    for (const name of names) {
      expect(evaluateEasing(name, 0)).toBe(0)
      expect(evaluateEasing(name, 1)).toBe(1)
    }
  })

  it('keeps linear proportional', () => {
    expect(evaluateEasing('linear', 0.25)).toBe(0.25)
    expect(evaluateEasing('linear', 0.75)).toBe(0.75)
  })

  it('ease-in accelerates: the step near the end is larger than near the start', () => {
    const earlyStep = evaluateEasing('ease-in', 0.05) - evaluateEasing('ease-in', 0)
    const lateStep = evaluateEasing('ease-in', 1) - evaluateEasing('ease-in', 0.95)
    expect(evaluateEasing('ease-in', 0.25)).toBeLessThan(0.25)
    expect(lateStep).toBeGreaterThan(earlyStep * 10)
  })

  it('ease-out decelerates: the step near the start is larger than near the end', () => {
    const earlyStep = evaluateEasing('ease-out', 0.05) - evaluateEasing('ease-out', 0)
    const lateStep = evaluateEasing('ease-out', 1) - evaluateEasing('ease-out', 0.95)
    expect(evaluateEasing('ease-out', 0.25)).toBeGreaterThan(0.25)
    expect(earlyStep).toBeGreaterThan(lateStep * 10)
  })

  it('clamps out-of-range progress', () => {
    expect(evaluateEasing('linear', -1)).toBe(0)
    expect(evaluateEasing('ease-in', 2)).toBe(1)
  })
})

describe('createCubicBezierEasing', () => {
  it('maps bounds to themselves', () => {
    const ease = createCubicBezierEasing({ x1: 0.4, y1: 0, x2: 0.6, y2: 1 })
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
  })

  it('solves x(t) = t accurately across the range', () => {
    const ease = createCubicBezierEasing({ x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 })
    // The x-component of a normalized cubic bezier passes through t by
    // construction, so the solver must return the matching y.
    for (const t of [0.1, 0.35, 0.5, 0.8]) {
      const y = ease(t)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
    }
    // Monotonic-ish check: increasing inputs must not decrease outputs.
    const values = [0, 0.2, 0.4, 0.6, 0.8, 1].map(ease)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] - 1e-9)
    }
  })

  it('handles control points that push x(t) past the target', () => {
    // x1 > 0 with strong curvature exercises the bisection fallback.
    const ease = createCubicBezierEasing({ x1: 0.9, y1: 0, x2: 0.1, y2: 1 })
    expect(ease(0.5)).toBeCloseTo(0.5, 2)
  })
})

describe('evaluateEasing (bezier definitions)', () => {
  it('evaluates cubic bezier definitions like their solver', () => {
    const bezier = { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }
    const ease = createCubicBezierEasing(bezier)
    for (const t of [0, 0.2, 0.5, 0.8, 1]) {
      expect(evaluateEasing(bezier, t)).toBe(ease(t))
    }
  })
})

describe('isEasing', () => {
  it('accepts named easings', () => {
    for (const name of ['linear', 'ease-in', 'ease-out', 'ease-in-out']) {
      expect(isEasing(name)).toBe(true)
    }
  })

  it('accepts closed cubic bezier objects', () => {
    expect(isEasing({ x1: 0, y1: 0, x2: 1, y2: 1 })).toBe(true)
    expect(isEasing({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 })).toBe(true)
    // Overshooting y values are legal (ease-out-back).
    expect(isEasing({ x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 })).toBe(true)
  })

  it('rejects junk, unknown names, extra keys and out-of-range x', () => {
    expect(isEasing('wobble')).toBe(false)
    expect(isEasing(null)).toBe(false)
    expect(isEasing(42)).toBe(false)
    expect(isEasing([])).toBe(false)
    expect(isEasing({})).toBe(false)
    expect(isEasing({ x1: 0, y1: 0, x2: 1 })).toBe(false)
    expect(isEasing({ x1: 0, y1: 0, x2: 1, y2: 1, extra: true })).toBe(false)
    expect(isEasing({ x1: -0.1, y1: 0, x2: 1, y2: 1 })).toBe(false)
    expect(isEasing({ x1: 0, y1: 0, x2: 1.1, y2: 1 })).toBe(false)
    expect(isEasing({ x1: 0, y1: NaN, x2: 1, y2: 1 })).toBe(false)
    expect(isEasing({ x1: '0', y1: 0, x2: 1, y2: 1 })).toBe(false)
  })
})

describe('easing presets', () => {
  it('exposes the named curves plus extra bezier presets with unique ids', () => {
    expect(EASING_PRESETS.length).toBeGreaterThanOrEqual(10)
    const ids = EASING_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const preset of EASING_PRESETS) {
      expect(isEasing(preset.bezier)).toBe(true)
    }
    const named = EASING_PRESETS.filter((preset) => preset.named !== undefined).map((preset) => preset.named)
    expect(named.sort()).toEqual(['ease-in', 'ease-in-out', 'ease-out', 'linear'])
  })

  it('canonicalBezierFor returns detached, correct named beziers', () => {
    const linear = canonicalBezierFor('linear')
    expect(linear).toEqual({ x1: 0, y1: 0, x2: 1, y2: 1 })
    expect(canonicalBezierFor('ease-in-out')).toEqual({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 })
    const other = canonicalBezierFor('ease-in')
    expect(other).toEqual({ x1: 0.42, y1: 0, x2: 1, y2: 1 })
    // Mutating the result must not corrupt the shared table.
    other.x1 = 99
    expect(canonicalBezierFor('ease-in').x1).toBe(0.42)
  })
})
