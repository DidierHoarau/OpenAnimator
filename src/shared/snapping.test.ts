import { describe, expect, it } from 'vitest'

import { snapPoint, snapValue, snappedDelta } from './snapping'

describe('snapValue', () => {
  it('rounds to the nearest multiple', () => {
    expect(snapValue(0, 20)).toBe(0)
    expect(snapValue(9, 20)).toBe(0)
    expect(snapValue(11, 20)).toBe(20)
    expect(snapValue(31, 20)).toBe(40)
    expect(snapValue(123.4, 10)).toBe(120)
  })

  it('rounds negatives symmetrically', () => {
    expect(snapValue(-9, 20)).toBe(-0)
    expect(snapValue(-11, 20)).toBe(-20)
    expect(snapValue(-31.5, 10)).toBe(-30)
  })

  it('passes through with a disabled step', () => {
    expect(snapValue(17, 0)).toBe(17)
    expect(snapValue(17, -5)).toBe(17)
    expect(snapValue(17, NaN)).toBe(17)
    expect(snapValue(NaN, 20)).toBeNaN()
  })
})

describe('snapPoint', () => {
  it('snaps both axes independently', () => {
    expect(snapPoint({ x: 11, y: 29 }, 20)).toEqual({ x: 20, y: 20 })
    expect(snapPoint({ x: -11, y: 41 }, 20)).toEqual({ x: -20, y: 40 })
  })

  it('leaves points untouched with a disabled step', () => {
    const point = { x: 3.7, y: -2.2 }
    expect(snapPoint(point, 0)).toEqual(point)
  })
})

describe('snappedDelta', () => {
  it('adjusts a drag delta so the resulting position lands on the grid', () => {
    // Origin (105, 100) + delta (12, 7) → (117, 107) → snapped (120, 100).
    expect(snappedDelta({ x: 105, y: 100 }, { x: 12, y: 7 }, 20)).toEqual({ x: 15, y: 0 })
  })

  it('keeps the origin itself when it is on the grid', () => {
    expect(snappedDelta({ x: 100, y: 100 }, { x: 9, y: 11 }, 20)).toEqual({ x: 0, y: 20 })
  })

  it('works with negative origins and deltas', () => {
    expect(snappedDelta({ x: -95, y: -95 }, { x: -12, y: -13 }, 20)).toEqual({ x: -5, y: -5 })
  })

  it('is a no-op with a disabled step', () => {
    expect(snappedDelta({ x: 105, y: 100 }, { x: 12, y: 7 }, 0)).toEqual({ x: 12, y: 7 })
  })
})
