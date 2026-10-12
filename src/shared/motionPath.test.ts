import { describe, expect, it } from 'vitest'

import { cubicBezierPoint, motionPathForNode, segmentControls } from './motionPath'
import type { ObjectLayer, PrimitiveNode } from './model'

function rect(id: string, x: number, y: number): PrimitiveNode {
  return {
    type: 'primitive',
    primitive: 'rect',
    id,
    center: { x, y },
    width: 10,
    height: 10,
    rotation: 0,
    fill: '#ffffff',
    opacity: 1
  }
}

function layer(keyframes: ObjectLayer['keyframes']): ObjectLayer {
  return { kind: 'object', id: 'l', name: 'L', visible: true, locked: false, keyframes }
}

describe('cubicBezierPoint', () => {
  it('maps the ends to the endpoints', () => {
    const p0 = { x: 0, y: 0 }
    const p1 = { x: 10, y: 20 }
    expect(cubicBezierPoint(p0, { x: 1, y: 1 }, { x: 9, y: 19 }, p1, 0)).toEqual(p0)
    expect(cubicBezierPoint(p0, { x: 1, y: 1 }, { x: 9, y: 19 }, p1, 1)).toEqual(p1)
  })

  it('follows the control points at the midpoint', () => {
    const point = cubicBezierPoint({ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }, 0.5)
    // Symmetric arch: x = 5, y = 3 * 0.25 * 0.5 * 10 + 3 * 0.5 * 0.25 * 10 = 7.5.
    expect(point.x).toBeCloseTo(5)
    expect(point.y).toBeCloseTo(7.5)
  })
})

describe('segmentControls', () => {
  it('derives catmull-rom handles from the neighbours', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 10 }
    ]
    const { c1, c2 } = segmentControls(points, 1)
    // c1 = p1 + (p2 - p0) / 6 = (10, 0) + (20, 10) / 6
    expect(c1.x).toBeCloseTo(10 + 20 / 6)
    expect(c1.y).toBeCloseTo(10 / 6)
    // c2 = p2 - (p3 - p1) / 6 with p3 clamped to p2 = (20, 10) - (10, 10) / 6
    expect(c2.x).toBeCloseTo(20 - 10 / 6)
    expect(c2.y).toBeCloseTo(10 - 10 / 6)
  })

  it('clamps the first and last segments to their endpoints', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 10 }
    ]
    const { c1, c2 } = segmentControls(points, 0)
    // p0 clamps to p1 and p3 clamps to p2: handles at the thirds.
    expect(c1).toEqual({ x: 10 / 6, y: 10 / 6 })
    expect(c2).toEqual({ x: 10 - 10 / 6, y: 10 - 10 / 6 })
  })
})

describe('motionPathForNode', () => {
  it('returns null without motion or a tween', () => {
    expect(motionPathForNode(layer([]), 'a')).toBeNull()
    expect(
      motionPathForNode(layer([{ frame: 0, nodes: [rect('a', 0, 0)] }]), 'a')
    ).toBeNull()
    // Two poses but no tween: the node jumps, there is no traversed path.
    const staticSpan = layer([
      { frame: 0, nodes: [rect('a', 0, 0)] },
      { frame: 10, nodes: [rect('a', 50, 0)] }
    ])
    expect(motionPathForNode(staticSpan, 'a')).toBeNull()
  })

  it('samples a tweened segment and reports its waypoints', () => {
    const tweened = layer([
      { frame: 0, nodes: [rect('a', 0, 0)], tween: { easing: 'linear' } },
      { frame: 10, nodes: [rect('a', 100, 50)] }
    ])
    const path = motionPathForNode(tweened, 'a')
    expect(path).not.toBeNull()
    expect(path?.waypoints).toEqual([
      { frame: 0, point: { x: 0, y: 0 } },
      { frame: 10, point: { x: 100, y: 50 } }
    ])
    expect(path?.smooth).toBe(false)
    // Linear segment: the polyline is start + end.
    expect(path?.polyline).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 50 }
    ])
  })

  it('skips segments whose source keyframe has no tween', () => {
    const mixed = layer([
      { frame: 0, nodes: [rect('a', 0, 0)] },
      { frame: 5, nodes: [rect('a', 0, 100)], tween: { easing: 'linear' } },
      { frame: 10, nodes: [rect('a', 100, 100)] }
    ])
    const path = motionPathForNode(mixed, 'a')
    expect(path).not.toBeNull()
    // Only the tweened 5→10 segment forms the path (no line to the jump).
    expect(path?.polyline).toEqual([
      { x: 0, y: 100 },
      { x: 100, y: 100 }
    ])
  })

  it('samples smooth segments with curved points between the waypoints', () => {
    const smooth = layer([
      { frame: 0, nodes: [rect('a', 0, 0)], tween: { easing: 'linear', path: 'smooth' } },
      { frame: 10, nodes: [rect('a', 100, 0)], tween: { easing: 'linear', path: 'smooth' } },
      { frame: 20, nodes: [rect('a', 200, 100)] }
    ])
    const path = motionPathForNode(smooth, 'a')
    expect(path?.smooth).toBe(true)
    // Two smooth segments: start + 2 * 24 samples.
    expect(path?.polyline).toHaveLength(1 + 48)
    expect(path?.polyline[0]).toEqual({ x: 0, y: 0 })
    expect(path?.polyline[48]).toEqual({ x: 200, y: 100 })
    // The curve bows off the straight chord (catmull-rom through (100, 0)).
    const fifthSample = path?.polyline[5]
    expect(fifthSample?.y).not.toBeCloseTo(0)
  })

  it('ignores other nodes and follows re-parented entry order', () => {
    const twoNodes = layer([
      { frame: 0, nodes: [rect('a', 0, 0), rect('b', 500, 0)], tween: { easing: 'linear' } },
      { frame: 10, nodes: [rect('b', 500, 0), rect('a', 10, 0)] }
    ])
    const path = motionPathForNode(twoNodes, 'a')
    expect(path?.waypoints).toEqual([
      { frame: 0, point: { x: 0, y: 0 } },
      { frame: 10, point: { x: 10, y: 0 } }
    ])
  })
})
