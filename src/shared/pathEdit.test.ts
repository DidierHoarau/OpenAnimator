import { describe, expect, it } from 'vitest'

import type { PathNode } from './model'
import {
  applyAnchorEdit,
  insertAnchor,
  localToStagePoint,
  nearestSubpathSegment,
  parseSubpaths,
  pathPlacement,
  removeAnchor,
  segmentPointAt,
  serializeSubpaths,
  setSubpathClosed,
  stageAnchorPoints,
  stageDeltaToLocal,
  toggleSmooth,
  type Subpath
} from './pathEdit'

function pathNode(overrides: Partial<PathNode> = {}): PathNode {
  return {
    type: 'path',
    id: 'p1',
    center: { x: 0, y: 0 },
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    d: 'M-50 -50L50 -50L50 50L-50 50L-50 -50Z',
    ...overrides
  }
}

function subpath(anchors: Subpath['anchors'], closed = false): Subpath {
  return { anchors, closed }
}

describe('parseSubpaths / serializeSubpaths', () => {
  it('round-trips a canonical open path', () => {
    const d = 'M0 0L10 0L10 10'
    const subpaths = parseSubpaths(d)
    expect(subpaths).not.toBeNull()
    expect(serializeSubpaths(subpaths!)).toBe(d)
  })

  it('canonicalizes a bare Z by adding the explicit closing segment', () => {
    const subpaths = parseSubpaths('M0 0L10 0L10 10Z')
    expect(subpaths).toEqual([
      { anchors: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true }
    ])
    expect(serializeSubpaths(subpaths!)).toBe('M0 0L10 0L10 10L0 0Z')
  })

  it('keeps subpaths separate and joins them with a space', () => {
    const subpaths = parseSubpaths('M0 0L10 0 M20 0L30 0')
    expect(subpaths).toHaveLength(2)
    expect(serializeSubpaths(subpaths!)).toBe('M0 0L10 0 M20 0L30 0')
  })

  it('returns null for unparseable data and parses handles into offsets', () => {
    expect(parseSubpaths('not a path')).toBeNull()
    const subpaths = parseSubpaths('M0 0C5 0 5 2.5 5 5C5 7.5 5 7.5 10 10')
    expect(subpaths).toEqual([
      {
        anchors: [
          { x: 0, y: 0, out: { x: 5, y: 0 } },
          { x: 5, y: 5, in: { x: 0, y: -2.5 }, out: { x: 0, y: 2.5 } },
          { x: 10, y: 10, in: { x: -5, y: -2.5 } }
        ],
        closed: false
      }
    ])
  })

  it('drops zero-length handles fabricated by flat C segments', () => {
    // The trailing control point sits on the endpoint: a corner, not a
    // smooth anchor — leaving the zero handle would keep re-emitting `C`.
    const subpaths = parseSubpaths('M-50 0C-16.67 0 50 0 50 0')!
    expect(subpaths[0].anchors[0].out).toEqual({ x: 33.33, y: 0 })
    expect(subpaths[0].anchors[1].in).toBeUndefined()
    expect(serializeSubpaths(subpaths)).toBe('M-50 0C-16.67 0 50 0 50 0')
  })
})

describe('insertAnchor', () => {
  it('inserts an interpolated anchor into a straight segment', () => {
    const subpaths = [subpath([{ x: 0, y: 0 }, { x: 10, y: 0 }])]
    expect(insertAnchor(subpaths, 0, 0, 0.5)).toBe(true)
    expect(subpaths[0].anchors).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }])
    expect(serializeSubpaths(subpaths)).toBe('M0 0L5 0L10 0')
  })

  it('splits a cubic with de Casteljau so both halves reproduce the original', () => {
    const original = [subpath([{ x: 0, y: 0, out: { x: 10, y: 0 } }, { x: 10, y: 10, in: { x: -10, y: 0 } }])]
    const subpaths = [subpath([{ x: 0, y: 0, out: { x: 10, y: 0 } }, { x: 10, y: 10, in: { x: -10, y: 0 } }])]
    expect(insertAnchor(subpaths, 0, 0, 0.5)).toBe(true)
    expect(subpaths[0].anchors).toEqual([
      { x: 0, y: 0, out: { x: 5, y: 0 } },
      { x: 5, y: 5, in: { x: 0, y: -2.5 }, out: { x: 0, y: 2.5 } },
      { x: 10, y: 10, in: { x: -5, y: 0 } }
    ])
    expect(serializeSubpaths(subpaths)).toBe('M0 0C5 0 5 2.5 5 5C5 7.5 5 10 10 10')
    for (const u of [0.25, 0.5, 0.75]) {
      const left = segmentPointAt(subpaths[0], 0, u)!
      const right = segmentPointAt(subpaths[0], 1, u)!
      const before = segmentPointAt(original[0], 0, u / 2)!
      const after = segmentPointAt(original[0], 0, (1 + u) / 2)!
      expect(left.x).toBeCloseTo(before.x, 6)
      expect(left.y).toBeCloseTo(before.y, 6)
      expect(right.x).toBeCloseTo(after.x, 6)
      expect(right.y).toBeCloseTo(after.y, 6)
    }
  })

  it('inserts into the wrap segment of a closed subpath at the end', () => {
    const subpaths = parseSubpaths('M-10 -10L10 -10L10 10L-10 10L-10 -10Z')!
    expect(insertAnchor(subpaths, 0, 3, 0.5)).toBe(true)
    expect(subpaths[0].anchors).toEqual([
      { x: -10, y: -10 },
      { x: 10, y: -10 },
      { x: 10, y: 10 },
      { x: -10, y: 10 },
      { x: -10, y: 0 }
    ])
    expect(serializeSubpaths(subpaths)).toBe('M-10 -10L10 -10L10 10L-10 10L-10 0L-10 -10Z')
  })

  it('rejects out-of-range segments and boundary parameters', () => {
    const subpaths = [subpath([{ x: 0, y: 0 }, { x: 10, y: 0 }])]
    expect(insertAnchor(subpaths, 0, 0, 0)).toBe(false)
    expect(insertAnchor(subpaths, 0, 0, 1)).toBe(false)
    expect(insertAnchor(subpaths, 0, 1, 0.5)).toBe(false)
    expect(insertAnchor(subpaths, 1, 0, 0.5)).toBe(false)
    expect(subpaths[0].anchors).toHaveLength(2)
  })
})

describe('removeAnchor', () => {
  it('removes an interior anchor', () => {
    const subpaths = [subpath([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }])]
    expect(removeAnchor(subpaths, 0, 1)).toBe(true)
    expect(serializeSubpaths(subpaths)).toBe('M0 0L10 0')
  })

  it('refuses to shrink a subpath below two anchors', () => {
    const subpaths = [subpath([{ x: 0, y: 0 }, { x: 10, y: 0 }])]
    expect(removeAnchor(subpaths, 0, 0)).toBe(false)
    expect(removeAnchor(subpaths, 0, 2)).toBe(false)
    expect(removeAnchor(subpaths, 1, 0)).toBe(false)
    expect(subpaths[0].anchors).toHaveLength(2)
  })
})

describe('toggleSmooth', () => {
  it('toggles an interior anchor between corner and smooth and back', () => {
    const subpaths = [subpath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 5 }])]
    const snapshot = structuredClone(subpaths)
    expect(toggleSmooth(subpaths, 0, 1)).toBe(true)
    expect(subpaths[0].anchors[1].out!.x).toBeCloseTo(20 / 3, 9)
    expect(subpaths[0].anchors[1].out!.y).toBeCloseTo(5 / 3, 9)
    expect(subpaths[0].anchors[1].in!.x).toBeCloseTo(-20 / 3, 9)
    expect(subpaths[0].anchors[1].in!.y).toBeCloseTo(-5 / 3, 9)
    expect(toggleSmooth(subpaths, 0, 1)).toBe(true)
    expect(subpaths).toEqual(snapshot)
  })

  it('smooths open endpoints along their single neighbor', () => {
    const subpaths = [subpath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 5 }])]
    expect(toggleSmooth(subpaths, 0, 0)).toBe(true)
    expect(subpaths[0].anchors[0].out!.x).toBeCloseTo(10 / 3, 9)
    expect(subpaths[0].anchors[0].out!.y).toBeCloseTo(0, 9)
    expect(toggleSmooth(subpaths, 0, 2)).toBe(true)
    expect(subpaths[0].anchors[2].in!.x).toBeCloseTo(-10 / 3, 9)
    expect(subpaths[0].anchors[2].in!.y).toBeCloseTo(-5 / 3, 9)
  })

  it('wraps neighbors on closed subpaths', () => {
    const subpaths = [subpath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }], true)]
    expect(toggleSmooth(subpaths, 0, 0)).toBe(true)
    expect(subpaths[0].anchors[0].out!.x).toBeCloseTo(5 / 3, 9)
    expect(subpaths[0].anchors[0].out!.y).toBeCloseTo(-10 / 3, 9)
    expect(subpaths[0].anchors[0].in!.x).toBeCloseTo(-5 / 3, 9)
  })

  it('refuses a lone anchor and clears coincident tangents', () => {
    const single = [subpath([{ x: 1, y: 1 }])]
    expect(toggleSmooth(single, 0, 0)).toBe(false)
    const coincident = [subpath([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 0 }])]
    expect(toggleSmooth(coincident, 0, 1)).toBe(true)
    expect(coincident[0].anchors[1].in).toBeUndefined()
    expect(coincident[0].anchors[1].out).toBeUndefined()
  })
})

describe('setSubpathClosed', () => {
  it('opens and closes subpaths with enough anchors', () => {
    const subpaths = parseSubpaths('M0 0L10 0L10 10')!
    expect(setSubpathClosed(subpaths, 0, true)).toBe(true)
    expect(serializeSubpaths(subpaths)).toBe('M0 0L10 0L10 10L0 0Z')
    expect(setSubpathClosed(subpaths, 0, false)).toBe(true)
    expect(serializeSubpaths(subpaths)).toBe('M0 0L10 0L10 10')
    expect(setSubpathClosed(subpaths, 1, true)).toBe(false)
  })

  it('refuses to close a two-anchor subpath', () => {
    const subpaths = [subpath([{ x: 0, y: 0 }, { x: 10, y: 0 }])]
    expect(setSubpathClosed(subpaths, 0, true)).toBe(false)
  })
})

describe('applyAnchorEdit', () => {
  it('returns the node unchanged for empty or single-point geometry', () => {
    const node = pathNode()
    expect(applyAnchorEdit(node, [])).toBe(node)
    expect(applyAnchorEdit(node, [subpath([{ x: 1, y: 1 }])])).toBe(node)
  })

  it('is an identity for an unedited canonical path', () => {
    const node = pathNode()
    const updated = applyAnchorEdit(node, parseSubpaths(node.d)!)
    expect(updated).toEqual(node)
  })

  it('keeps the stage map under rotation and non-uniform scale', () => {
    const node = pathNode({
      d: 'M-50 -25L50 25',
      center: { x: 100, y: 200 },
      rotation: 90,
      width: 100,
      height: 100
    })
    const placement = pathPlacement(node)
    expect(placement.scaleX).toBeCloseTo(1, 9)
    expect(placement.scaleY).toBeCloseTo(2, 9)
    const anchor1Before = localToStagePoint(placement, { x: 50, y: 25 })

    const subpaths = parseSubpaths(node.d)!
    subpaths[0].anchors[0] = { x: -50, y: -15 }
    const updated = applyAnchorEdit(node, subpaths)
    expect(updated.d).toBe('M-50 -20L50 20')
    expect(updated.width).toBeCloseTo(100, 6)
    expect(updated.height).toBeCloseTo(80, 6)
    expect(updated.center.x).toBeCloseTo(90, 6)
    expect(updated.center.y).toBeCloseTo(200, 6)

    const nextPlacement = pathPlacement(updated)
    const anchor1After = localToStagePoint(nextPlacement, { x: 50, y: 20 })
    expect(anchor1After.x).toBeCloseTo(anchor1Before.x, 6)
    expect(anchor1After.y).toBeCloseTo(anchor1Before.y, 6)

    // The dragged anchor ends where the stage-space drag put it: delta local
    // y +10 becomes a stage delta of R(90°)·(0, sy·10) = (-20, 0).
    const movedAfter = localToStagePoint(nextPlacement, { x: -50, y: -20 })
    expect(movedAfter.x).toBeCloseTo(150 - 20, 6)
    expect(movedAfter.y).toBeCloseTo(150, 6)
  })

  it('edits one subpath without moving the others', () => {
    const node = pathNode({
      d: 'M-50 -50L-10 -50L-10 -10L-50 -10L-50 -50Z M10 10L50 10L50 50L10 50L10 10Z'
    })
    const subpaths = parseSubpaths(node.d)!
    subpaths[0].anchors[0] = { x: -50, y: -60 }
    const updated = applyAnchorEdit(node, subpaths)
    expect(updated.d).toBe('M-50 -55L-10 -45L-10 -5L-50 -5L-50 -55ZM10 15L50 15L50 55L10 55L10 15Z')
    expect(updated.height).toBeCloseTo(110, 6)
    expect(updated.center.y).toBeCloseTo(-5, 6)
    const placement = pathPlacement(updated)
    const other = localToStagePoint(placement, { x: 50, y: 15 })
    expect(other.x).toBeCloseTo(50, 6)
    expect(other.y).toBeCloseTo(10, 6)
    const moved = localToStagePoint(placement, { x: -50, y: -55 })
    expect(moved.x).toBeCloseTo(-50, 6)
    expect(moved.y).toBeCloseTo(-60, 6)
  })

  it('handles a degenerate old axis through the natural-size fallback', () => {
    const node = pathNode({ d: 'M0 -50L0 50', width: 30, height: 100 })
    const subpaths = parseSubpaths(node.d)!
    subpaths[0].anchors[0] = { x: 10, y: -50 }
    const updated = applyAnchorEdit(node, subpaths)
    expect(updated.d).toBe('M5 -50L-5 50')
    expect(updated.width).toBeCloseTo(10, 6)
    expect(updated.height).toBeCloseTo(100, 6)
    expect(updated.center).toEqual({ x: 5, y: 0 })
    const placement = pathPlacement(updated)
    const other = localToStagePoint(placement, { x: -5, y: 50 })
    expect(other.x).toBeCloseTo(0, 6)
    expect(other.y).toBeCloseTo(50, 6)
    const moved = localToStagePoint(placement, { x: 5, y: -50 })
    expect(moved.x).toBeCloseTo(10, 6)
    expect(moved.y).toBeCloseTo(-50, 6)
  })
})

describe('stage helpers', () => {
  it('maps anchors and handle tips through the placement', () => {
    const node = pathNode({ center: { x: 100, y: 100 } })
    const subpaths = [
      subpath([
        { x: -50, y: -50, out: { x: 10, y: 0 } },
        { x: 50, y: -50 },
        { x: 50, y: 50 },
        { x: -50, y: 50 }
      ])
    ]
    const points = stageAnchorPoints(pathPlacement(node), subpaths)
    expect(points).toHaveLength(4)
    expect(points[0].point).toEqual({ x: 50, y: 50 })
    expect(points[0].out).toEqual({ x: 60, y: 50 })
    expect(points[0].in).toBeUndefined()
    expect(points[2].point).toEqual({ x: 150, y: 150 })
  })

  it('finds the nearest segment with an interior parameter', () => {
    const subpaths = parseSubpaths('M-50 -50L50 -50L50 50L-50 50L-50 -50Z')!
    const hit = nearestSubpathSegment(subpaths, { x: 0, y: -50 })
    expect(hit).toEqual({ subpathIndex: 0, segmentIndex: 0, t: 0.5 })
    expect(nearestSubpathSegment([], { x: 0, y: 0 })).toBeNull()
    expect(nearestSubpathSegment([subpath([{ x: 1, y: 1 }])], { x: 0, y: 0 })).toBeNull()
  })

  it('inverts the placement for pointer deltas', () => {
    const node = pathNode({ rotation: 90, center: { x: 100, y: 200 }, d: 'M-50 -25L50 25' })
    const local = stageDeltaToLocal(pathPlacement(node), { x: -20, y: 0 })
    expect(local.x).toBeCloseTo(0, 9)
    expect(local.y).toBeCloseTo(10, 9)
  })
})
