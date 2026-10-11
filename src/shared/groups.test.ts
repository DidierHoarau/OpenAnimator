import { describe, expect, it } from 'vitest'

import { groupNaturalSize, groupNodes, ungroupNode } from './groups'
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

describe('groupNodes', () => {
  it('computes the selection bbox, centers the group and re-expresses children locally', () => {
    const a = rect('a', 10, 20)
    const b = rect('b', 200, 140)
    const group = groupNodes([a, b], 'g1')
    // Union bounds: x from -40 to 250, y from -5 to 165.
    expect(group.type).toBe('group')
    expect(group.id).toBe('g1')
    expect(group.center).toEqual({ x: 105, y: 80 })
    expect(group.width).toBe(290)
    expect(group.height).toBe(170)
    expect(group.rotation).toBe(0)
    expect(group.opacity).toBe(1)
    expect(group.children.map((child) => child.id)).toEqual(['a', 'b'])
    const [localA, localB] = group.children as PrimitiveNode[]
    expect(localA.center).toEqual({ x: 10 - 105, y: 20 - 80 })
    expect(localB.center).toEqual({ x: 200 - 105, y: 140 - 80 })
    // Intrinsic fields survive unchanged.
    expect(localA.width).toBe(100)
    expect(localA.height).toBe(50)
    expect(localA.fill).toBe('#ff0000')
    expect(localB.rotation).toBe(0)
  })

  it('accounts for rotation in the selection bounds', () => {
    const a = rect('a', 0, 0, { width: 100, height: 50, rotation: 90 })
    const group = groupNodes([a], 'g')
    // A 90° rotated 100x50 rect spans 50 wide, 100 tall.
    expect(group.width).toBeCloseTo(50)
    expect(group.height).toBeCloseTo(100)
    expect(group.center).toEqual({ x: 0, y: 0 })
  })

  it('deep-clones the children so the input is never shared or mutated', () => {
    const a = rect('a', 10, 20)
    const original = structuredClone(a)
    const group = groupNodes([a], 'g')
    expect(group.children[0]).not.toBe(a)
    ;(group.children[0] as PrimitiveNode).center.x = 999
    ;(group.children[0] as PrimitiveNode).fill = '#00ff00'
    expect(a).toEqual(original)
  })

  it('throws on an empty selection', () => {
    expect(() => groupNodes([], 'g')).toThrow('cannot group an empty selection')
  })
})

describe('groupNaturalSize', () => {
  it('returns the union bounds of the children in local space', () => {
    const group = groupNodes([rect('a', 10, 20), rect('b', 200, 140)], 'g')
    const natural = groupNaturalSize(group.children)
    expect(natural).toEqual({ width: 290, height: 170 })
  })

  it('returns zero size for empty children', () => {
    expect(groupNaturalSize([])).toEqual({ width: 0, height: 0 })
  })
})

describe('ungroupNode', () => {
  it('round-trips group → ungroup exactly for axis-aligned children', () => {
    const a = rect('a', 10, 20)
    const b = rect('b', 200, 140, { opacity: 0.5, stroke: '#ffffff', strokeWidth: 2 })
    const originals: SceneNode[] = [a, b]
    const group = groupNodes(originals, 'g1')
    const restored = ungroupNode(group)
    expect(restored.map((node) => node.id)).toEqual(['a', 'b'])
    expect(restored[0]).toEqual(a)
    expect(restored[1]).toEqual(b)
  })

  it('round-trips rotated children within floating-point precision', () => {
    const a = rect('a', 10, 20)
    const b = rect('b', 200, 140, { rotation: 30, opacity: 0.5 })
    const group = groupNodes([a, b], 'g1')
    const restored = ungroupNode(group) as PrimitiveNode[]
    expect(restored[0].id).toBe('a')
    expect(restored[0].center.x).toBeCloseTo(10)
    expect(restored[0].center.y).toBeCloseTo(20)
    expect(restored[1].center.x).toBeCloseTo(200)
    expect(restored[1].center.y).toBeCloseTo(140)
    expect(restored[1].width).toBeCloseTo(100)
    expect(restored[1].height).toBeCloseTo(50)
    expect(restored[1].rotation).toBe(30)
    expect(restored[1].opacity).toBe(0.5)
  })

  it('folds a group translation into the children', () => {
    const a = rect('a', 0, 0)
    const group = groupNodes([a], 'g')
    const moved: GroupNode = { ...group, center: { x: group.center.x + 40, y: group.center.y - 10 } }
    const [restored] = ungroupNode(moved) as PrimitiveNode[]
    expect(restored.center).toEqual({ x: 40, y: -10 })
  })

  it('folds a group scale (resized placed box) into the children', () => {
    const a = rect('a', 0, 0)
    const b = rect('b', 100, 0)
    const group = groupNodes([a, b], 'g')
    // Natural size 200x50; doubling the placed width doubles child widths.
    const scaled: GroupNode = { ...group, width: group.width * 2 }
    const [restoredA, restoredB] = ungroupNode(scaled) as PrimitiveNode[]
    expect(restoredA.width).toBe(200)
    expect(restoredB.width).toBe(200)
    expect(restoredA.height).toBe(50)
    // Child `a` sits at local x -50, pushed to -100 by the 2× horizontal scale.
    expect(restoredA.center.x).toBeCloseTo(group.center.x - 100)
    expect(restoredB.center.x).toBeCloseTo(group.center.x + 100)
    expect(restoredA.center.y).toBe(group.center.y)
  })

  it('folds a group rotation into the children', () => {
    const a = rect('a', 0, 0)
    const group = groupNodes([a], 'g')
    // The child sits at the group center; rotating the group moves nothing
    // but adds rotation to the child.
    const rotated: GroupNode = { ...group, rotation: 90 }
    const [restored] = ungroupNode(rotated) as PrimitiveNode[]
    expect(restored.rotation).toBe(90)
    expect(restored.center).toEqual(group.center)
  })

  it('folds rotation and offset together into child positions', () => {
    const a = rect('a', 0, 0)
    const b = rect('b', 100, 0)
    const group = groupNodes([a, b], 'g')
    // Child `a` sits at local (-50, 0); after a 90° rotation of the group
    // (y-down clockwise) the parent-space offset becomes (0, -50).
    const rotated: GroupNode = { ...group, rotation: 90 }
    const [restoredA, restoredB] = ungroupNode(rotated) as PrimitiveNode[]
    expect(restoredA.center.x).toBeCloseTo(group.center.x)
    expect(restoredA.center.y).toBeCloseTo(group.center.y - 50)
    expect(restoredB.center.x).toBeCloseTo(group.center.x)
    expect(restoredB.center.y).toBeCloseTo(group.center.y + 50)
    expect(restoredA.rotation).toBe(90)
  })

  it('folds group opacity into the children', () => {
    const a = rect('a', 0, 0, { opacity: 0.8 })
    const group = groupNodes([a], 'g')
    const translucent: GroupNode = { ...group, opacity: 0.5 }
    const [restored] = ungroupNode(translucent) as PrimitiveNode[]
    expect(restored.opacity).toBeCloseTo(0.4)
  })

  it('guards zero-size groups with unit scale factors', () => {
    const emptyGroup: GroupNode = {
      type: 'group',
      id: 'g',
      center: { x: 10, y: 10 },
      width: 0,
      height: 0,
      rotation: 0,
      opacity: 1,
      children: []
    }
    expect(ungroupNode(emptyGroup)).toEqual([])
  })

  it('does not mutate the group or its children', () => {
    const a = rect('a', 0, 0)
    const group = groupNodes([a], 'g')
    const snapshot = structuredClone(group)
    ungroupNode({ ...group, rotation: 45, width: 999 })
    expect(group).toEqual(snapshot)
  })
})
