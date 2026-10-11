import { describe, expect, it } from 'vitest'

import {
  hitTestNode,
  hitTestNodes,
  nodeBounds,
  rectIntersectsRect,
  unionNodeBounds
} from './hitTesting'
import { groupNodes } from './groups'
import type { GroupNode, PrimitiveNode, SceneNode } from './model'

function rect(id: string, x: number, y: number, overrides: Partial<PrimitiveNode> = {}): PrimitiveNode {
  return {
    type: 'primitive',
    primitive: 'rect',
    id,
    center: { x, y },
    width: 100,
    height: 50,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1,
    ...overrides
  }
}

describe('hitTestNode — primitives', () => {
  it('hits axis-aligned rectangles', () => {
    const node = rect('a', 100, 100)
    expect(hitTestNode(node, { x: 100, y: 100 })).toBe(true)
    expect(hitTestNode(node, { x: 148, y: 124 })).toBe(true)
    expect(hitTestNode(node, { x: 160, y: 100 })).toBe(false)
  })

  it('hits rotated rectangles in local space', () => {
    const node = rect('a', 100, 100, { rotation: 90 })
    // 90° clockwise: the 100-wide, 50-tall rect spans ±25 horizontally and ±50 vertically.
    expect(hitTestNode(node, { x: 100, y: 135 })).toBe(true)
    expect(hitTestNode(node, { x: 135, y: 100 })).toBe(false)
  })

  it('hits ellipses', () => {
    const node = rect('a', 100, 100, { primitive: 'ellipse' })
    expect(hitTestNode(node, { x: 100, y: 100 })).toBe(true)
    expect(hitTestNode(node, { x: 149, y: 100 })).toBe(true)
    expect(hitTestNode(node, { x: 145, y: 145 })).toBe(false)
  })

  it('hits image and symbol nodes by their placed box', () => {
    const image: SceneNode = {
      type: 'image',
      id: 'i',
      center: { x: 0, y: 0 },
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1,
      resourceId: 'r',
      naturalWidth: 100,
      naturalHeight: 50,
      smoothing: true
    }
    expect(hitTestNode(image, { x: 49, y: 24 })).toBe(true)
    expect(hitTestNode(image, { x: 60, y: 0 })).toBe(false)
    const symbol: SceneNode = { ...image, type: 'symbol', assetId: 'a' } as unknown as SceneNode
    expect(hitTestNode(symbol, { x: 49, y: 24 })).toBe(true)
    expect(hitTestNode(symbol, { x: 60, y: 0 })).toBe(false)
  })
})

describe('hitTestNode — groups', () => {
  it('hits through to the children in group-local space', () => {
    const group = groupNodes([rect('a', 0, 0), rect('b', 150, 0)], 'g')
    // The placed box spans x -50..200, y -25..25.
    expect(hitTestNode(group, { x: 0, y: 0 })).toBe(true)
    expect(hitTestNode(group, { x: 150, y: 0 })).toBe(true)
    // Inside the placed box but not on any child.
    expect(hitTestNode(group, { x: 75, y: 0 })).toBe(false)
    // Outside the placed box entirely.
    expect(hitTestNode(group, { x: 250, y: 0 })).toBe(false)
  })

  it('precision-tests children after scaling the group', () => {
    const group = groupNodes([rect('a', 0, 0), rect('b', 150, 0)], 'g')
    // Shrink the placed box to half size around the same center: the child
    // boxes shrink with it. Child a lands at x 12.5..62.5, child b at
    // 87.5..137.5.
    const scaled: GroupNode = { ...group, width: group.width / 2, height: group.height / 2 }
    expect(hitTestNode(scaled, { x: 50, y: 0 })).toBe(true)
    expect(hitTestNode(scaled, { x: 110, y: 0 })).toBe(true)
    // Inside the placed box but between the two shrunken children.
    expect(hitTestNode(scaled, { x: 75, y: 0 })).toBe(false)
    // Outside the placed box entirely.
    expect(hitTestNode(scaled, { x: 200, y: 0 })).toBe(false)
  })

  it('tests a rotated group by inverse-transforming the point', () => {
    const group = groupNodes([rect('a', 0, 0), rect('b', 150, 0)], 'g')
    const rotated: GroupNode = { ...group, rotation: 90 }
    // After a 90° rotation around the group center (75, 0), child b (local
    // (75, 0)) lands at (75, 75) and child a at (75, -75).
    expect(hitTestNode(rotated, { x: 75, y: 75 })).toBe(true)
    expect(hitTestNode(rotated, { x: 75, y: -75 })).toBe(true)
    expect(hitTestNode(rotated, { x: 150, y: 0 })).toBe(false)
  })

  it('hits the topmost child only through hitTestNodes ordering', () => {
    const a = rect('a', 0, 0)
    const b = rect('b', 0, 0)
    expect(hitTestNodes([a, b], { x: 0, y: 0 })?.id).toBe('b')
    expect(hitTestNodes([a, b], { x: 0, y: 1000 })).toBeUndefined()
  })
})

describe('nodeBounds', () => {
  it('computes the axis-aligned bounds of an unrotated node', () => {
    const bounds = nodeBounds(rect('a', 100, 100))
    expect(bounds).toEqual({ x: 50, y: 75, width: 100, height: 50 })
  })

  it('computes the rotation-aware bounding box of a rotated node', () => {
    const bounds = nodeBounds(rect('a', 100, 100, { rotation: 90 }))
    // A 90° rotation swaps the footprint: 50 wide, 100 tall.
    expect(bounds.x).toBeCloseTo(75)
    expect(bounds.y).toBeCloseTo(50)
    expect(bounds.width).toBeCloseTo(50)
    expect(bounds.height).toBeCloseTo(100)
    const diagonal = nodeBounds(rect('b', 0, 0, { rotation: 45 }))
    expect(diagonal.width).toBeCloseTo((100 + 50) * Math.SQRT1_2)
    expect(diagonal.height).toBeCloseTo((100 + 50) * Math.SQRT1_2)
  })

  it('works uniformly for every node kind', () => {
    const group = groupNodes([rect('a', 0, 0)], 'g')
    expect(nodeBounds(group)).toEqual({ x: -50, y: -25, width: 100, height: 50 })
  })
})

describe('unionNodeBounds', () => {
  it('unions the bounds of its input nodes', () => {
    const union = unionNodeBounds([rect('a', 0, 0), rect('b', 150, 40)])
    expect(union).toEqual({ x: -50, y: -25, width: 250, height: 90 })
  })

  it('returns a zero-size box for an empty list', () => {
    expect(unionNodeBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

describe('rectIntersectsRect', () => {
  it('detects rectangle intersections for the rubber-band marquee', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 }
    expect(rectIntersectsRect(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true)
    expect(rectIntersectsRect(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(true)
    expect(rectIntersectsRect(a, { x: 11, y: 11, width: 5, height: 5 })).toBe(false)
    expect(rectIntersectsRect(a, { x: -5, y: -5, width: 5, height: 20 })).toBe(true)
    // A contained rect intersects.
    expect(rectIntersectsRect(a, { x: 2, y: 2, width: 2, height: 2 })).toBe(true)
  })
})
