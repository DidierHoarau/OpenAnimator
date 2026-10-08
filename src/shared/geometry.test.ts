import { describe, expect, it } from 'vitest'

import { clamp01, distance, easeInOutCubic, lerp, pointInRect } from './geometry'

describe('lerp', () => {
  it('interpolates between two values', () => {
    expect(lerp(0, 10, 0.5)).toBe(5)
    expect(lerp(-4, 4, 0.25)).toBe(-2)
  })

  it('returns the bounds at t=0 and t=1', () => {
    expect(lerp(2, 8, 0)).toBe(2)
    expect(lerp(2, 8, 1)).toBe(8)
  })
})

describe('clamp01', () => {
  it('keeps in-range values unchanged', () => {
    expect(clamp01(0.25)).toBe(0.25)
    expect(clamp01(0)).toBe(0)
    expect(clamp01(1)).toBe(1)
  })

  it('clamps out-of-range values', () => {
    expect(clamp01(-0.5)).toBe(0)
    expect(clamp01(1.5)).toBe(1)
  })
})

describe('easeInOutCubic', () => {
  it('maps the bounds to themselves', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
  })

  it('is symmetric around 0.5', () => {
    expect(easeInOutCubic(0.5)).toBe(0.5)
    expect(easeInOutCubic(0.25)).toBeCloseTo(1 - easeInOutCubic(0.75), 12)
  })
})

describe('distance', () => {
  it('computes the euclidean distance', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(distance({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe(0)
  })
})

describe('pointInRect', () => {
  const center = { x: 10, y: 10 }

  it('accepts points inside the rectangle', () => {
    expect(pointInRect({ x: 10, y: 10 }, center, 4, 4)).toBe(true)
    expect(pointInRect({ x: 12, y: 8 }, center, 4, 4)).toBe(true)
  })

  it('rejects points outside the rectangle', () => {
    expect(pointInRect({ x: 13, y: 10 }, center, 4, 4)).toBe(false)
    expect(pointInRect({ x: 10, y: 13 }, center, 4, 4)).toBe(false)
  })
})
