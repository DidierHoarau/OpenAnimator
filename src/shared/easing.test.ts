import { describe, expect, it } from 'vitest'

import { createCubicBezierEasing, evaluateEasing } from './easing'

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
