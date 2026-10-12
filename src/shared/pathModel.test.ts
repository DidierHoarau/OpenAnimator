import { describe, expect, it } from 'vitest'
import {
  buildPathData,
  normalizePathData,
  parsePathCommands,
  pathDataBounds,
  pathDataToAnchors,
  pathDataToSubpathAnchors,
  pathNaturalSize
} from './pathModel'
import type { PathNode } from './model'

describe('parsePathCommands', () => {
  it('parses absolute M/L/C/Q/Z', () => {
    expect(parsePathCommands('M0 0 L10 0 C1 2 3 4 10 10 Q5 6 8 8 Z')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 0 },
      { type: 'C', x1: 1, y1: 2, x2: 3, y2: 4, x: 10, y: 10 },
      { type: 'Q', x1: 5, y1: 6, x: 8, y: 8 },
      { type: 'Z' }
    ])
  })

  it('resolves relative commands and implicit linetos after M', () => {
    expect(parsePathCommands('m10 10 20 0 l5 5 c1 1 2 2 3 3')).toEqual([
      { type: 'M', x: 10, y: 10 },
      { type: 'L', x: 30, y: 10 },
      { type: 'L', x: 35, y: 15 },
      // The relative cubic continues from the cursor (35, 15).
      { type: 'C', x1: 36, y1: 16, x2: 37, y2: 17, x: 38, y: 18 }
    ])
  })

  it('converts H/V to linetos and reflects S/T controls', () => {
    const parsed = parsePathCommands('M0 0 H10 V10 S20 20 30 30 Q10 0 20 20 T40 40')
    expect(parsed).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 0 },
      { type: 'L', x: 10, y: 10 },
      { type: 'C', x1: 10, y1: 10, x2: 20, y2: 20, x: 30, y: 30 },
      { type: 'Q', x1: 10, y1: 0, x: 20, y: 20 },
      { type: 'Q', x1: 30, y1: 40, x: 40, y: 40 }
    ])
  })

  it('rejects arcs, mismatched numbers and garbage', () => {
    expect(parsePathCommands('M0 0 A5 5 0 0 1 10 10')).toBeNull()
    expect(parsePathCommands('M0 0 C1 2 3 4')).toBeNull()
    expect(parsePathCommands('M0 0 Labc')).toBeNull()
    expect(parsePathCommands('')).toBeNull()
  })
})

describe('buildPathData', () => {
  it('builds straight polylines and closes with Z', () => {
    const anchors = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 }
    ]
    expect(buildPathData(anchors, false)).toBe('M0 0L10 0L10 10')
    expect(buildPathData(anchors, true)).toBe('M0 0L10 0L10 10L0 0Z')
  })

  it('emits cubic segments when handles are present', () => {
    const d = buildPathData(
      [
        { x: 0, y: 0, out: { x: 5, y: 0 } },
        { x: 10, y: 10, in: { x: -5, y: 0 } }
      ],
      false
    )
    expect(d).toBe('M0 0C5 0 5 10 10 10')
  })

  it('returns empty data without anchors and skips closing degenerate paths', () => {
    expect(buildPathData([], true)).toBe('')
    expect(buildPathData([{ x: 1, y: 2 }], true)).toBe('M1 2')
  })
})

describe('pathDataToAnchors round-trip', () => {
  it('recovers straight anchors', () => {
    expect(pathDataToAnchors('M0 0L10 0L10 10')).toEqual({
      anchors: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 }
      ],
      closed: false
    })
  })

  it('recovers handles from cubic and quadratic segments', () => {
    const curved = pathDataToAnchors('M0 0C5 0 5 10 10 10')
    expect(curved?.anchors[0].out).toEqual({ x: 5, y: 0 })
    expect(curved?.anchors[1]).toEqual({ x: 10, y: 10, in: { x: -5, y: 0 } })

    const quad = pathDataToAnchors('M0 0Q5 0 10 10')
    // Quadratic controls convert to exact cubic equivalents (2/3 toward q).
    expect(quad?.anchors[0].out?.x).toBeCloseTo(10 / 3)
    expect(quad?.anchors[0].out?.y).toBe(0)
    expect(quad?.anchors[1].in?.x).toBeCloseTo(-10 / 3)
    expect(quad?.anchors[1].in?.y).toBeCloseTo(-20 / 3)
  })

  it('marks closed subpaths and rejects multi-subpath data', () => {
    expect(pathDataToAnchors('M0 0L10 0L10 10Z')?.closed).toBe(true)
    expect(pathDataToAnchors('M0 0L10 0ZM20 20L30 30')).toBeNull()
    expect(pathDataToAnchors('M0 0L10 0ZL20 20')).toBeNull()
    expect(pathDataToAnchors('')).toBeNull()
  })

  it('rebuilds identical geometry after a round-trip', () => {
    const d = 'M0 0C5 0 5 10 10 10L20 10Z'
    const parsed = pathDataToAnchors(d)
    expect(parsed).not.toBeNull()
    const rebuilt = buildPathData(parsed!.anchors, parsed!.closed)
    expect(pathDataBounds(rebuilt)).toEqual(pathDataBounds(d))
  })
})

describe('pathDataBounds', () => {
  it('covers on-curve points and control points', () => {
    expect(pathDataBounds('M0 0L10 0L10 10')).toEqual({ x: 0, y: 0, width: 10, height: 10 })
    expect(pathDataBounds('M0 0C-10 -5 20 -5 10 10')).toEqual({ x: -10, y: -5, width: 30, height: 15 })
  })

  it('returns null for empty or invalid data', () => {
    expect(pathDataBounds('')).toBeNull()
    // A path with only an M draws a degenerate zero-size point.
    expect(pathDataBounds('M0 0Z')).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(pathDataBounds('nope')).toBeNull()
  })
})

describe('normalizePathData', () => {
  it('recenters the bounding box on the origin', () => {
    const normalized = normalizePathData('M10 20L30 20L30 40')
    expect(pathDataBounds(normalized)).toEqual({ x: -10, y: -10, width: 20, height: 20 })
  })

  it('keeps multiple subpaths and curve shapes', () => {
    const normalized = normalizePathData('M0 0L10 0M20 20C25 20 25 30 30 30')
    const bounds = pathDataBounds(normalized)
    expect(bounds).toEqual({ x: -15, y: -15, width: 30, height: 30 })
  })

  it('passes unparseable data through unchanged', () => {
    expect(normalizePathData('nonsense')).toBe('nonsense')
  })
})

describe('pathDataToSubpathAnchors', () => {
  it('converts a single subpath like pathDataToAnchors', () => {
    expect(pathDataToSubpathAnchors('M0 0L10 0L10 10Z')).toEqual([
      {
        anchors: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 }
        ],
        closed: true
      }
    ])
  })

  it('keeps every subpath of multi-contour paths separate', () => {
    const subpaths = pathDataToSubpathAnchors('M0 0L50 0L50 20ZM5 5L10 5L10 10Z')
    expect(subpaths).toHaveLength(2)
    expect(subpaths![0].anchors).toHaveLength(3)
    expect(subpaths![0].closed).toBe(true)
    expect(subpaths![1].anchors).toEqual([
      { x: 5, y: 5 },
      { x: 10, y: 5 },
      { x: 10, y: 10 }
    ])
    expect(subpaths![1].closed).toBe(true)
  })

  it('converts quadratic controls to cubic handles per subpath', () => {
    const subpaths = pathDataToSubpathAnchors('M0 0Q6 0 9 9M20 0L30 0')
    expect(subpaths).toHaveLength(2)
    expect(subpaths![0].anchors[0].out).toEqual({ x: 4, y: 0 })
    expect(subpaths![0].anchors[1].in).toEqual({ x: -2, y: -6 })
    expect(subpaths![0].closed).toBe(false)
    expect(subpaths![1].anchors).toEqual([
      { x: 20, y: 0 },
      { x: 30, y: 0 }
    ])
  })

  it('rejects unparseable, empty and impossible data', () => {
    expect(pathDataToSubpathAnchors('')).toBeNull()
    expect(pathDataToSubpathAnchors('nonsense')).toBeNull()
    expect(pathDataToSubpathAnchors('M0 0 A5 5 0 0 1 10 10')).toBeNull()
    // Drawing continues after a Z without a new M.
    expect(pathDataToSubpathAnchors('M0 0L10 0ZL20 20')).toBeNull()
    // Coordinates before any M.
    expect(pathDataToSubpathAnchors('L10 10')).toBeNull()
  })
})

describe('pathNaturalSize', () => {
  it('returns the parsed bounds when available', () => {
    const node: PathNode = {
      type: 'path',
      id: 'p',
      center: { x: 0, y: 0 },
      width: 99,
      height: 99,
      rotation: 0,
      opacity: 1,
      d: 'M-5 -5L5 5',
      stroke: '#fff',
      strokeWidth: 2
    }
    expect(pathNaturalSize(node)).toEqual({ width: 10, height: 10 })
  })

  it('falls back to the placed size for unparseable data', () => {
    const node: PathNode = {
      type: 'path',
      id: 'p',
      center: { x: 0, y: 0 },
      width: 30,
      height: 40,
      rotation: 0,
      opacity: 1,
      d: 'garbage'
    }
    expect(pathNaturalSize(node)).toEqual({ width: 30, height: 40 })
  })
})
