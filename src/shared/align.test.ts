import { describe, expect, it } from 'vitest'

import { alignOffsets, distributeOffsets } from './align'

const A = { x: 0, y: 0, width: 100, height: 50 }
const B = { x: 200, y: 100, width: 60, height: 30 }
const C = { x: 400, y: 300, width: 40, height: 120 }

describe('alignOffsets', () => {
  it('returns nothing for an empty selection', () => {
    expect(alignOffsets([], 'left')).toEqual([])
  })

  it('aligns left/centerH/right against the union bounds', () => {
    const left = alignOffsets([A, B, C], 'left')
    expect(left).toEqual([
      { dx: 0, dy: 0 },
      { dx: -200, dy: 0 },
      { dx: -400, dy: 0 }
    ])
    const centered = alignOffsets([A, B, C], 'centerH')
    // Union: x 0–440, center 220. A center 50 → +170; B center 230 → -10; C center 420 → -200.
    expect(centered).toEqual([
      { dx: 170, dy: 0 },
      { dx: -10, dy: 0 },
      { dx: -200, dy: 0 }
    ])
    const right = alignOffsets([A, B, C], 'right')
    expect(right).toEqual([
      { dx: 340, dy: 0 },
      { dx: 180, dy: 0 },
      { dx: 0, dy: 0 }
    ])
  })

  it('aligns top/middle/bottom against the union bounds', () => {
    // Union: y 0–420, center 210.
    expect(alignOffsets([A, B, C], 'top')).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: -100 },
      { dx: 0, dy: -300 }
    ])
    expect(alignOffsets([A, B, C], 'middle')).toEqual([
      { dx: 0, dy: 185 },
      { dx: 0, dy: 95 },
      { dx: 0, dy: -150 }
    ])
    expect(alignOffsets([A, B, C], 'bottom')).toEqual([
      { dx: 0, dy: 370 },
      { dx: 0, dy: 290 },
      { dx: 0, dy: 0 }
    ])
  })

  it('keeps a single rect in place', () => {
    expect(alignOffsets([B], 'left')).toEqual([{ dx: 0, dy: 0 }])
    expect(alignOffsets([B], 'bottom')).toEqual([{ dx: 0, dy: 0 }])
  })
})

describe('distributeOffsets', () => {
  it('returns zero offsets for fewer than three rects', () => {
    expect(distributeOffsets([A, B], 'h')).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 }
    ])
  })

  it('spaces horizontal centers evenly with the outermost two fixed', () => {
    // Centers: A 50, B 230, C 420 → step (420-50)/2 = 185 → B should be at 235.
    const offsets = distributeOffsets([A, B, C], 'h')
    expect(offsets).toEqual([
      { dx: 0, dy: 0 },
      { dx: 5, dy: 0 },
      { dx: 0, dy: 0 }
    ])
  })

  it('spaces vertical centers evenly, sorting members first', () => {
    // Vertical centers: A 25, C 360, B 115 → order A(0), B(1), C(2) → step 167.5.
    const offsets = distributeOffsets([C, A, B], 'v')
    // C is last → fixed; A first → fixed; B target 192.5 → shift +77.5.
    expect(offsets).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
      { dx: 0, dy: 77.5 }
    ])
  })

  it('produces no offsets when the spread is zero', () => {
    const same = { x: 10, y: 10, width: 10, height: 10 }
    expect(distributeOffsets([same, same, same], 'h')).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 }
    ])
  })

  it('distributes exactly three rects into even gaps', () => {
    const first = { x: 0, y: 0, width: 20, height: 20 }
    const middle = { x: 30, y: 0, width: 20, height: 20 }
    const last = { x: 200, y: 0, width: 20, height: 20 }
    // Centers 10, 40, 210 → targets 10, 110, 210 → middle +70.
    expect(distributeOffsets([first, middle, last], 'h')).toEqual([
      { dx: 0, dy: 0 },
      { dx: 70, dy: 0 },
      { dx: 0, dy: 0 }
    ])
  })
})
