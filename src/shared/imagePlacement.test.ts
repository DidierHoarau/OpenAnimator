import { describe, expect, it } from 'vitest'

import { fitImagePlacement } from './imagePlacement'

describe('fitImagePlacement', () => {
  it('keeps the natural size and centers on the stage when it fits', () => {
    const placement = fitImagePlacement({ width: 300, height: 200 }, { width: 960, height: 540 })
    expect(placement).toEqual({
      width: 300,
      height: 200,
      center: { x: 480, y: 270 }
    })
  })

  it('caps images larger than the stage, preserving the aspect ratio', () => {
    const placement = fitImagePlacement({ width: 1920, height: 1080 }, { width: 960, height: 540 })
    expect(placement.width).toBe(960)
    expect(placement.height).toBe(540)
  })

  it('caps only the overflowing dimension', () => {
    const placement = fitImagePlacement({ width: 2000, height: 100 }, { width: 960, height: 540 })
    expect(placement.width).toBe(960)
    expect(placement.height).toBe(48)
  })

  it('uses the drop point as the center when given', () => {
    const placement = fitImagePlacement(
      { width: 100, height: 50 },
      { width: 960, height: 540 },
      { x: 120, y: 80 }
    )
    expect(placement.center).toEqual({ x: 120, y: 80 })
    expect(placement.width).toBe(100)
    expect(placement.height).toBe(50)
  })

  it('handles degenerate natural sizes without dividing by zero', () => {
    const placement = fitImagePlacement({ width: 0, height: 0 }, { width: 960, height: 540 })
    expect(placement.width).toBe(0)
    expect(placement.height).toBe(0)
    expect(placement.center).toEqual({ x: 480, y: 270 })
  })
})
