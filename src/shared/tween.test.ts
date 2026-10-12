import { describe, expect, it } from 'vitest'

import { evaluateLayerAtFrame } from './document'
import type { AnimatorDocument, GroupNode, ImageNode, ObjectLayer, PathAnchor, PathNode, PrimitiveNode, SceneNode, SymbolNode, TextNode } from './model'
import { pathDataToSubpathAnchors } from './pathModel'
import { morphPathData, tweenNode, tweenNodes } from './tween'

/** Parses path data into subpath anchors for tolerant geometry comparison. */
function anchorsOf(d: string): Array<{ anchors: PathAnchor[]; closed: boolean }> {
  const subpaths = pathDataToSubpathAnchors(d)
  if (!subpaths) throw new Error(`unparsable path data: ${d}`)
  return subpaths
}

function expectAnchorsCloseTo(actual: string, expected: Array<{ anchors: PathAnchor[]; closed: boolean }>): void {
  const parsed = anchorsOf(actual)
  expect(parsed.length).toBe(expected.length)
  parsed.forEach((subpath, index) => {
    expect(subpath.closed).toBe(expected[index].closed)
    expect(subpath.anchors.length).toBe(expected[index].anchors.length)
    subpath.anchors.forEach((anchor, anchorIndex) => {
      const other = expected[index].anchors[anchorIndex]
      expect(anchor.x).toBeCloseTo(other.x, 2)
      expect(anchor.y).toBeCloseTo(other.y, 2)
      for (const handle of ['in', 'out'] as const) {
        const value = anchor[handle] ?? { x: 0, y: 0 }
        const target = other[handle] ?? { x: 0, y: 0 }
        expect(value.x).toBeCloseTo(target.x, 2)
        expect(value.y).toBeCloseTo(target.y, 2)
      }
    })
  })
}

function shape(id: string, overrides: Partial<PrimitiveNode> = {}): PrimitiveNode {
  return {
    type: 'primitive',
    primitive: 'rect',
    id,
    center: { x: 0, y: 0 },
    width: 100,
    height: 50,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1,
    ...overrides
  }
}

function group(id: string, overrides: Partial<GroupNode> = {}): GroupNode {
  return {
    type: 'group',
    id,
    center: { x: 0, y: 0 },
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    children: [shape('child', { center: { x: 0, y: 0 } })],
    ...overrides
  }
}

function image(id: string, overrides: Partial<ImageNode> = {}): ImageNode {
  return {
    type: 'image',
    id,
    center: { x: 0, y: 0 },
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    resourceId: 'res-1',
    naturalWidth: 800,
    naturalHeight: 400,
    smoothing: true,
    ...overrides
  }
}

function symbol(id: string, overrides: Partial<SymbolNode> = {}): SymbolNode {
  return {
    type: 'symbol',
    id,
    center: { x: 0, y: 0 },
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    assetId: 'asset-1',
    ...overrides
  }
}

describe('tweenNode', () => {
  it('interpolates geometry, rotation and opacity', () => {
    const from = shape('a', { center: { x: 0, y: 0 }, rotation: 0, opacity: 1 })
    const to = shape('a', { center: { x: 100, y: 200 }, rotation: 90, opacity: 0 })
    const result = tweenNode(from, to, 0.5)
    expect(result.center).toEqual({ x: 50, y: 100 })
    expect(result.rotation).toBe(45)
    expect(result.opacity).toBe(0.5)
  })

  it('applies channel progress overrides per property', () => {
    const from = shape('a', { center: { x: 0, y: 0 }, opacity: 1, fill: '#000000' })
    const to = shape('a', { center: { x: 100, y: 0 }, opacity: 0, fill: '#ffffff' })
    const result = tweenNode(from, to, 0.5, undefined, { opacity: 0.25 }) as PrimitiveNode
    // The transform channel keeps the base progress; opacity uses its own.
    expect(result.center.x).toBe(50)
    expect(result.opacity).toBe(0.75)
    // Absent channels default to the base progress.
    expect(result.fill).toBe('#808080')
  })

  it('applies the fill override to the fill and leaves the stroke on the base progress', () => {
    const from = shape('a', { fill: '#000000', stroke: '#000000', strokeWidth: 1 })
    const to = shape('a', { fill: '#ffffff', stroke: '#ffffff', strokeWidth: 3 })
    const result = tweenNode(from, to, 0.5, undefined, { fill: 0.25 }) as PrimitiveNode
    expect(result.fill).toBe('#404040')
    expect(result.stroke).toBe('#808080')
    expect(result.strokeWidth).toBe(2)
  })

  it('defaults every channel to the base progress when no overrides are given', () => {
    const from = shape('a', { opacity: 1, fill: '#000000' })
    const to = shape('a', { opacity: 0, fill: '#ffffff' })
    const result = tweenNode(from, to, 0.5, undefined, {}) as PrimitiveNode
    expect(result.opacity).toBe(0.5)
    expect(result.fill).toBe('#808080')
  })

  it('follows a center bezier path when given one', () => {
    const from = shape('a', { center: { x: 0, y: 0 } })
    const to = shape('a', { center: { x: 100, y: 0 } })
    // Straight chord would put the midpoint at (50, 0); the arc lifts it.
    const lifted = tweenNode(from, to, 0.5, { c1: { x: 0, y: 80 }, c2: { x: 100, y: 80 } })
    expect(lifted.center.x).toBeCloseTo(50)
    expect(lifted.center.y).toBeCloseTo(60)
    // The other interpolated fields are unaffected.
    expect(lifted.width).toBe(100)
  })

  it('interpolates fill colors', () => {
    const result = tweenNode(shape('a', { fill: '#000000' }), shape('a', { fill: '#ffffff' }), 0.5)
    expect((result as PrimitiveNode).fill).toBe('#808080')
  })

  it('snaps between primitives of different kinds', () => {
    const from = shape('a', { primitive: 'rect' })
    const to = shape('a', { primitive: 'ellipse' })
    expect((tweenNode(from, to, 0.5) as PrimitiveNode).primitive).toBe('rect')
    expect((tweenNode(from, to, 1) as PrimitiveNode).primitive).toBe('ellipse')
  })

  it('falls back to raw colors when not valid hex', () => {
    const from = shape('a', { fill: 'red' })
    const to = shape('a', { fill: 'blue' })
    expect((tweenNode(from, to, 0.5) as PrimitiveNode).fill).toBe('red')
    expect((tweenNode(from, to, 1) as PrimitiveNode).fill).toBe('blue')
  })

  it('interpolates matching gradient fills (geometry and stops)', () => {
    const from = shape('a', {
      fill: {
        type: 'linear',
        angle: 0,
        stops: [
          { offset: 0, color: '#ff0000' },
          { offset: 1, color: '#000000' }
        ]
      }
    })
    const to = shape('a', {
      fill: {
        type: 'linear',
        angle: 90,
        stops: [
          { offset: 0, color: '#0000ff' },
          { offset: 1, color: '#ffffff' }
        ]
      }
    })
    const mid = tweenNode(from, to, 0.5) as PrimitiveNode
    expect(mid.fill).toEqual({
      type: 'linear',
      angle: 45,
      stops: [
        { offset: 0, color: '#800080' },
        { offset: 1, color: '#808080' }
      ]
    })
    // t=0 and t=1 reproduce the ends exactly.
    expect((tweenNode(from, to, 0) as PrimitiveNode).fill).toEqual(from.fill)
    expect((tweenNode(from, to, 1) as PrimitiveNode).fill).toEqual(to.fill)
  })

  it('interpolates radial gradients', () => {
    const from = shape('a', {
      fill: { type: 'radial', cx: 0.5, cy: 0.5, r: 0.5, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] }
    })
    const to = shape('a', {
      fill: { type: 'radial', cx: 0.5, cy: 0.5, r: 1, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] }
    })
    const mid = tweenNode(from, to, 0.5) as PrimitiveNode
    expect(mid.fill).toMatchObject({ type: 'radial', r: 0.75 })
  })

  it('snaps solid↔gradient and gradient-of-different-shape pairs', () => {
    const gradient = {
      type: 'linear' as const,
      angle: 0,
      stops: [
        { offset: 0, color: '#ff0000' },
        { offset: 1, color: '#0000ff' }
      ]
    }
    const solid = shape('a', { fill: '#ff0000' })
    const painted = shape('a', { fill: gradient })
    expect((tweenNode(painted, solid, 0.5) as PrimitiveNode).fill).toBe(gradient)
    expect((tweenNode(painted, solid, 1) as PrimitiveNode).fill).toBe('#ff0000')
    expect((tweenNode(solid, painted, 0.5) as PrimitiveNode).fill).toBe('#ff0000')
    expect((tweenNode(solid, painted, 1) as PrimitiveNode).fill).toBe(gradient)
    const radial = shape('a', {
      fill: { type: 'radial', cx: 0.5, cy: 0.5, r: 0.5, stops: gradient.stops }
    })
    expect((tweenNode(painted, radial, 0.5) as PrimitiveNode).fill).toBe(gradient)
  })

  it('interpolates gradient strokes when both ends define one', () => {
    const stroke = (angle: number): PrimitiveNode =>
      shape('a', {
        stroke: {
          type: 'linear',
          angle,
          stops: [
            { offset: 0, color: '#000000' },
            { offset: 1, color: '#000000' }
          ]
        },
        strokeWidth: 2
      })
    expect((tweenNode(stroke(0), stroke(90), 0.5) as PrimitiveNode).stroke).toMatchObject({
      type: 'linear',
      angle: 45
    })
    // One end without a stroke keeps the defined one (no lerp).
    const bare = shape('a', { strokeWidth: 2 })
    expect((tweenNode(stroke(0), bare, 0.5) as PrimitiveNode).stroke).toEqual(stroke(0).stroke)
    expect((tweenNode(bare, stroke(0), 0.5) as PrimitiveNode).stroke).toEqual(stroke(0).stroke)
  })

  it('tweens a group: transform and opacity lerp, children come from `from`', () => {
    const from = group('g', { center: { x: 0, y: 0 }, opacity: 1 })
    const to = group('g', {
      center: { x: 100, y: 200 },
      width: 200,
      height: 100,
      rotation: 60,
      opacity: 0.4,
      children: [shape('rewritten', { center: { x: 999, y: 999 } })]
    })
    const result = tweenNode(from, to, 0.5) as GroupNode
    expect(result.type).toBe('group')
    expect(result.center).toEqual({ x: 50, y: 100 })
    expect(result.width).toBe(150)
    expect(result.height).toBe(75)
    expect(result.rotation).toBe(30)
    expect(result.opacity).toBeCloseTo(0.7)
    // Children are identity fields: never interpolated, taken from `from`.
    expect(result.children).toBe(from.children)
    expect(result.children[0].id).toBe('child')
  })

  it('tweens an image: identity fields come from `from`', () => {
    const from = image('i', { center: { x: 0, y: 0 }, opacity: 1, resourceId: 'res-a' })
    const to = image('i', {
      center: { x: 80, y: 40 },
      width: 200,
      height: 100,
      rotation: 45,
      opacity: 0.2,
      resourceId: 'res-b',
      naturalWidth: 1,
      naturalHeight: 1,
      smoothing: false
    })
    const result = tweenNode(from, to, 0.5) as ImageNode
    expect(result.center).toEqual({ x: 40, y: 20 })
    expect(result.width).toBe(150)
    expect(result.height).toBe(75)
    expect(result.rotation).toBe(22.5)
    expect(result.opacity).toBeCloseTo(0.6)
    expect(result.resourceId).toBe('res-a')
    expect(result.naturalWidth).toBe(800)
    expect(result.naturalHeight).toBe(400)
    expect(result.smoothing).toBe(true)
  })

  it('tweens a symbol: identity fields come from `from`', () => {
    const from = symbol('s', { center: { x: 0, y: 0 } })
    const to = symbol('s', { center: { x: 100, y: 0 }, assetId: 'asset-2' })
    const result = tweenNode(from, to, 0.25) as SymbolNode
    expect(result.center.x).toBe(25)
    expect(result.assetId).toBe('asset-1')
  })

  it('snaps between nodes of different types', () => {
    const shapeNode = shape('a')
    const groupNode = group('a')
    expect((tweenNode(shapeNode, groupNode, 0.5) as PrimitiveNode).type).toBe('primitive')
    expect((tweenNode(shapeNode, groupNode, 1) as GroupNode).type).toBe('group')
    expect((tweenNode(groupNode, shapeNode, 0.5) as GroupNode).type).toBe('group')
    expect((tweenNode(groupNode, shapeNode, 1) as PrimitiveNode).type).toBe('primitive')
  })

  it('tweens a path: transform, stroke width and paints lerp, mismatched geometry snaps from `from`', () => {
    const from: PathNode = {
      type: 'path',
      id: 'p',
      center: { x: 0, y: 0 },
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1,
      d: 'M0 0L10 10',
      stroke: '#111111',
      strokeWidth: 2
    }
    const to: PathNode = {
      type: 'path',
      id: 'p',
      center: { x: 100, y: 50 },
      width: 200,
      height: 150,
      rotation: 90,
      opacity: 0.2,
      d: 'M999 999',
      stroke: '#222222',
      strokeWidth: 10
    }
    const result = tweenNode(from, to, 0.5) as PathNode
    expect(result.center).toEqual({ x: 50, y: 25 })
    expect(result.width).toBe(150)
    expect(result.height).toBe(100)
    expect(result.rotation).toBe(45)
    expect(result.strokeWidth).toBe(6)
    expect(result.d).toBe('M0 0L10 10')
    expect(result.stroke).toBe('#1a1a1a')
    expect(result.fill).toBeUndefined()
  })

  it('morphs a compatible path pair through `morphPathData`, keeping the ends exact', () => {
    const from: PathNode = {
      type: 'path',
      id: 'p',
      center: { x: 0, y: 0 },
      width: 20,
      height: 10,
      rotation: 0,
      opacity: 1,
      d: 'M0 0 L20 0 L20 10 Z',
      fill: '#0000ff'
    }
    const to: PathNode = { ...from, center: { x: 50, y: 50 }, d: 'M0 0 L30 0 L30 10 Z' }
    const mid = tweenNode(from, to, 0.5) as PathNode
    expect(mid.d).toBe('M-12.5 -5L12.5 -5L12.5 5L-12.5 -5Z')
    // The evaluator tweens at keyframe frames too (progress 0/1), so the
    // ends must stay byte-identical to the authored data.
    expect((tweenNode(from, to, 0) as PathNode).d).toBe('M0 0 L20 0 L20 10 Z')
    expect((tweenNode(from, to, 1) as PathNode).d).toBe('M0 0 L30 0 L30 10 Z')
  })

  it('keeps a path stroke width when only one side defines it', () => {
    const from: PathNode = {
      type: 'path',
      id: 'p',
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      d: 'M0 0L1 1',
      strokeWidth: 4
    }
    const to: PathNode = { ...from, strokeWidth: undefined }
    expect((tweenNode(from, to, 0.5) as PathNode).strokeWidth).toBe(4)
  })

  it('lerps path fills and strokes through `lerpPaint`', () => {
    const from: PathNode = {
      type: 'path',
      id: 'p',
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      d: 'M0 0L1 1',
      fill: '#000000',
      stroke: '#ff0000'
    }
    const to: PathNode = { ...from, fill: '#ffffff', stroke: '#00ff00' }
    const result = tweenNode(from, to, 0.5) as PathNode
    expect(result.fill).toBe('#808080')
    expect(result.stroke).toBe('#808000')
  })

  it('lerps path gradients stop by stop, including alpha', () => {
    const from: PathNode = {
      type: 'path',
      id: 'p',
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      d: 'M0 0L1 1',
      fill: {
        type: 'linear',
        angle: 0,
        stops: [
          { offset: 0, color: '#ff0000', alpha: 1 },
          { offset: 1, color: '#0000ff' }
        ]
      }
    }
    const to: PathNode = {
      ...from,
      fill: {
        type: 'linear',
        angle: 180,
        stops: [
          { offset: 0, color: '#ff0000', alpha: 0 },
          { offset: 1, color: '#0000ff', alpha: 1 }
        ]
      }
    }
    const result = tweenNode(from, to, 0.5) as PathNode
    expect(result.fill).toEqual({
      type: 'linear',
      angle: 90,
      stops: [
        { offset: 0, color: '#ff0000', alpha: 0.5 },
        { offset: 1, color: '#0000ff' }
      ]
    })
  })

  it('snaps path paint mismatches and lets the defined end win', () => {
    const base: PathNode = {
      type: 'path',
      id: 'p',
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      d: 'M0 0L1 1'
    }
    const gradient = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] } as const
    // Solid ↔ gradient snaps: `from` until the last frame, `to` at t = 1.
    const solidFrom: PathNode = { ...base, fill: '#ff0000' }
    const gradientTo: PathNode = { ...base, fill: { ...gradient, stops: [...gradient.stops] } }
    expect((tweenNode(solidFrom, gradientTo, 0.5) as PathNode).fill).toBe('#ff0000')
    expect((tweenNode(solidFrom, gradientTo, 1) as PathNode).fill).toEqual(gradientTo.fill)
    // One side undefined: the defined end wins at every t.
    expect((tweenNode(base, solidFrom, 0.5) as PathNode).fill).toBe('#ff0000')
    expect((tweenNode(solidFrom, base, 0.5) as PathNode).fill).toBe('#ff0000')
    expect((tweenNode(base, base, 0.5) as PathNode).fill).toBeUndefined()
  })

  it('carries path stroke styles through the tween: styles hold, dash offset lerps', () => {
    const from: PathNode = {
      type: 'path',
      id: 'p',
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      d: 'M0 0L1 1',
      stroke: '#111111',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'bevel',
      strokeDasharray: [6, 4],
      strokeDashoffset: 0
    }
    const to: PathNode = {
      ...from,
      strokeLinecap: 'butt',
      strokeLinejoin: 'miter',
      strokeDasharray: [2, 2],
      strokeDashoffset: 10
    }
    const result = tweenNode(from, to, 0.5) as PathNode
    expect(result.strokeLinecap).toBe('round')
    expect(result.strokeLinejoin).toBe('bevel')
    expect(result.strokeDasharray).toEqual([6, 4])
    expect(result.strokeDashoffset).toBe(5)
    // Absent style fields stay absent.
    const bare = tweenNode({ ...from, strokeLinecap: undefined, strokeLinejoin: undefined, strokeDasharray: undefined, strokeDashoffset: undefined }, { ...from, strokeLinecap: undefined, strokeLinejoin: undefined, strokeDasharray: undefined, strokeDashoffset: undefined }, 0.5) as PathNode
    expect(bare.strokeLinecap).toBeUndefined()
    expect(bare.strokeLinejoin).toBeUndefined()
    expect(bare.strokeDasharray).toBeUndefined()
    expect(bare.strokeDashoffset).toBeUndefined()
  })

  it('carries stroke styles through primitive and text tweens', () => {
    const primitive = tweenNode(
      shape('a', {
        stroke: '#000000',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeDasharray: [4, 2],
        strokeDashoffset: 2
      }),
      shape('a', {
        stroke: '#000000',
        strokeWidth: 2,
        strokeLinecap: 'butt',
        strokeDasharray: [1, 1],
        strokeDashoffset: 6
      }),
      0.25
    ) as PrimitiveNode
    expect(primitive.strokeLinecap).toBe('round')
    expect(primitive.strokeDasharray).toEqual([4, 2])
    expect(primitive.strokeDashoffset).toBe(3)
    expect(primitive.strokeWidth).toBe(2)

    const textFrom: TextNode = {
      type: 'text',
      id: 't',
      center: { x: 0, y: 0 },
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1,
      text: 'Hi',
      fontFamily: 'Noto Sans',
      fontSize: 20,
      fontWeight: 400,
      fill: '#ffffff',
      align: 'left',
      stroke: '#000000',
      strokeWidth: 1,
      strokeLinecap: 'square',
      strokeDasharray: [3, 3],
      strokeDashoffset: 1
    }
    const textTo: TextNode = { ...textFrom, strokeDashoffset: 5, strokeLinecap: 'butt' }
    const text = tweenNode(textFrom, textTo, 0.5) as TextNode
    expect(text.strokeLinecap).toBe('square')
    expect(text.strokeDasharray).toEqual([3, 3])
    expect(text.strokeDashoffset).toBe(3)
  })

  it('tweens a text: font size lerps, content and font snap from `from`', () => {
    const from: TextNode = {
      type: 'text',
      id: 't',
      center: { x: 0, y: 0 },
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1,
      text: 'From',
      fontFamily: 'Noto Sans',
      fontSize: 20,
      fontWeight: 400,
      fill: '#ffffff',
      align: 'left'
    }
    const to: TextNode = {
      ...from,
      center: { x: 50, y: 0 },
      width: 300,
      height: 100,
      text: 'To',
      fontSize: 60,
      fontWeight: 700,
      align: 'right',
      fill: '#000000'
    }
    const result = tweenNode(from, to, 0.5) as TextNode
    expect(result.fontSize).toBe(40)
    expect(result.width).toBe(200)
    expect(result.height).toBe(75)
    expect(result.text).toBe('From')
    expect(result.fontFamily).toBe('Noto Sans')
    expect(result.fontWeight).toBe(400)
    expect(result.fill).toBe('#ffffff')
    expect(result.align).toBe('left')
  })
})

describe('morphPathData', () => {
  it('lerps matching outlines anchor by anchor (re-centered on their bounding boxes)', () => {
    expect(morphPathData('M0 0 L20 0 L20 10 Z', 'M0 0 L30 0 L30 10 Z', 0.5)).toBe(
      'M-12.5 -5L12.5 -5L12.5 5L-12.5 -5Z'
    )
    // Different sizes and offsets: both start re-centered, so only shape
    // interpolates — the centers of the two boxes do not drag the geometry.
    const mid = morphPathData('M0 0 L20 0 L20 10 Z', 'M100 100 L130 100 L130 110 Z', 0.5)
    expect(mid).toBe('M-12.5 -5L12.5 -5L12.5 5L-12.5 -5Z')
  })

  it('round-trips the parsed end geometries at t=0 and t=1', () => {
    const from = 'M-10 -10 L10 -10 L0 10'
    const to = 'M-20 -5 L20 -5 L0 5'
    const fromAnchors = anchorsOf(from)
    const toAnchors = anchorsOf(to)
    expectAnchorsCloseTo(morphPathData(from, to, 0)!, fromAnchors)
    expectAnchorsCloseTo(morphPathData(from, to, 1)!, toAnchors)
    // Closed outlines keep their closing segment and flag.
    const closed = morphPathData('M0 0 L20 0 L20 10 Z', 'M0 0 L30 0 L30 10 Z', 1)
    expect(closed).toBe('M-15 -5L15 -5L15 5L-15 -5Z')
  })

  it('treats a corner pose’s missing handle as a zero-length handle', () => {
    // from is straight, to is curved: the midpoint is a shallower curve.
    expect(morphPathData('M-15 0 L15 0', 'M-15 0 C-5 0 5 0 15 0', 0.5)).toBe(
      'M-15 0C-10 0 10 0 15 0'
    )
    // And curving back the other way.
    expect(morphPathData('M-15 0 C-5 0 5 0 15 0', 'M-15 0 L15 0', 0.5)).toBe(
      'M-15 0C-10 0 10 0 15 0'
    )
    // Two curves average their handles (both boxes already centered).
    expect(morphPathData('M-15 -5 C-5 -5 5 5 15 5', 'M-15 -5 C-15 5 0 5 15 5', 0.5)).toBe(
      'M-15 -5C-10 0 2.5 5 15 5'
    )
  })

  it('morphs every subpath of a multi-subpath outline', () => {
    const from = 'M0 0 L10 0 L10 10 Z M20 0 L30 0 L30 10 Z'
    const to = 'M0 0 L20 0 L20 10 Z M40 0 L60 0 L60 10 Z'
    const mid = morphPathData(from, to, 0.5)!
    const subpaths = anchorsOf(mid)
    expect(subpaths).toHaveLength(2)
    // One global bounding-box center re-centers both subpaths together.
    expect(subpaths[0].anchors[0]).toMatchObject({ x: -22.5, y: -5 })
    expect(subpaths[1].anchors[0]).toMatchObject({ x: 7.5, y: -5 })
    expect(subpaths[1].anchors[2]).toMatchObject({ x: 22.5, y: 5 })
  })

  it('returns null for incompatible or unparseable outlines (the snap fallback)', () => {
    // Anchor-count mismatch.
    expect(morphPathData('M0 0 L20 0 L20 10 Z', 'M0 0 L30 0 Z', 0.5)).toBeNull()
    // Subpath-count mismatch.
    expect(
      morphPathData('M0 0 L20 0 L20 10 Z', 'M0 0 L30 0 L30 10 Z M40 0 L50 0 L50 10 Z', 0.5)
    ).toBeNull()
    // Open vs closed.
    expect(morphPathData('M0 0 L20 0 L20 10', 'M0 0 L20 0 L20 10 Z', 0.5)).toBeNull()
    // Arcs are rejected by the parser.
    expect(morphPathData('M0 0 A5 5 0 0 1 10 10', 'M0 0 L10 10', 0.5)).toBeNull()
  })
})

describe('tweenNodes', () => {
  it('tweens matching nodes and holds static the others', () => {
    const from: SceneNode[] = [shape('a', { center: { x: 0, y: 0 } }), shape('static')]
    const to: SceneNode[] = [shape('a', { center: { x: 100, y: 0 } }), shape('b')]
    const result = tweenNodes(from, to, 0.5)
    expect(result).toHaveLength(2)
    expect(result[0].center.x).toBe(50)
    expect(result[1].center.x).toBe(0)
  })

  it('handles mixed node types by id matching', () => {
    const from: SceneNode[] = [group('g'), shape('p', { center: { x: 0, y: 0 } })]
    const to: SceneNode[] = [group('g', { center: { x: 40, y: 0 } }), symbol('p')]
    const result = tweenNodes(from, to, 0.5)
    expect((result[0] as GroupNode).center.x).toBe(20)
    // The primitive `p` snaps against a symbol: primitive until the end.
    expect((result[1] as PrimitiveNode).type).toBe('primitive')
  })
})

describe('evaluateLayerAtFrame', () => {
  const layer: ObjectLayer = {
    kind: 'object',
    id: 'layer',
    name: 'Layer 1',
    visible: true,
    locked: false,
    keyframes: [
      {
        frame: 0,
        nodes: [shape('a', { center: { x: 0, y: 0 } })],
        tween: { easing: 'linear' }
      },
      { frame: 10, nodes: [shape('a', { center: { x: 100, y: 0 } })] }
    ]
  }

  it('renders nothing before the first keyframe', () => {
    const emptyLayer: ObjectLayer = { ...layer, keyframes: [{ frame: 5, nodes: [shape('a')] }] }
    expect(evaluateLayerAtFrame(emptyLayer, 2)).toEqual([])
  })

  it('interpolates inside a tweened span with easing', () => {
    expect(evaluateLayerAtFrame(layer, 5)[0].center.x).toBe(50)
  })

  it('applies per-channel easing overrides through the evaluator', () => {
    const channelLayer: ObjectLayer = {
      ...layer,
      keyframes: [
        {
          frame: 0,
          nodes: [shape('a', { center: { x: 0, y: 0 }, opacity: 1, fill: '#000000' })],
          tween: { easing: 'linear', easings: { opacity: 'ease-in', fill: 'ease-out' } }
        },
        { frame: 10, nodes: [shape('a', { center: { x: 100, y: 0 }, opacity: 0, fill: '#ffffff' })] }
      ]
    }
    const result = evaluateLayerAtFrame(channelLayer, 5)[0] as PrimitiveNode
    // The transform channel keeps the linear base; ease-in at 0.5 is 0.125
    // and ease-out 0.875.
    expect(result.center.x).toBe(50)
    expect(result.opacity).toBe(0.875)
    expect(result.fill).toBe('#dfdfdf')
  })

  it('evaluates gradient fill interpolation through the tween pipeline', () => {
    const gradientLayer: ObjectLayer = {
      ...layer,
      keyframes: [
        {
          frame: 0,
          nodes: [
            shape('a', {
              fill: {
                type: 'linear',
                angle: 0,
                stops: [
                  { offset: 0, color: '#000000' },
                  { offset: 1, color: '#000000' }
                ]
              }
            })
          ],
          tween: { easing: 'linear' }
        },
        {
          frame: 10,
          nodes: [
            shape('a', {
              fill: {
                type: 'linear',
                angle: 0,
                stops: [
                  { offset: 0, color: '#ffffff' },
                  { offset: 1, color: '#ffffff' }
                ]
              }
            })
          ]
        }
      ]
    }
    const mid = evaluateLayerAtFrame(gradientLayer, 5)[0] as PrimitiveNode
    expect(mid.fill).toEqual({
      type: 'linear',
      angle: 0,
      stops: [
        { offset: 0, color: '#808080' },
        { offset: 1, color: '#808080' }
      ]
    })
  })

  it('evaluates cubic bezier easing definitions', () => {
    const eased: ObjectLayer = {
      ...layer,
      keyframes: [
        { frame: 0, nodes: [shape('a', { center: { x: 0, y: 0 } })], tween: { easing: { x1: 0, y1: 0, x2: 1, y2: 1 } } },
        { frame: 10, nodes: [shape('a', { center: { x: 100, y: 0 } })] }
      ]
    }
    // The identity bezier approximates linear within solver tolerance.
    expect(evaluateLayerAtFrame(eased, 5)[0].center.x).toBeCloseTo(50, 1)
  })

  it('bows the center along a smooth path across three waypoints', () => {
    const smoothLayer: ObjectLayer = {
      ...layer,
      keyframes: [
        {
          frame: 0,
          nodes: [shape('a', { center: { x: 0, y: 0 } })],
          tween: { easing: 'linear', path: 'smooth' }
        },
        { frame: 10, nodes: [shape('a', { center: { x: 100, y: 100 } })], tween: { easing: 'linear', path: 'smooth' } },
        { frame: 20, nodes: [shape('a', { center: { x: 200, y: 0 } })] }
      ]
    }
    // Mid-segment the center leaves the straight chord (catmull-rom at the
    // middle waypoint): y overshoots above the 0→100 chord or deviates
    // laterally from it, while x stays strictly inside the segment.
    const atFive = evaluateLayerAtFrame(smoothLayer, 5)[0].center
    const chordY = 50
    expect(atFive.x).toBeGreaterThan(0)
    expect(atFive.x).toBeLessThan(100)
    expect(Math.abs(atFive.y - chordY)).toBeGreaterThan(1)

    // With `path: 'linear'` (or absent) the same waypoints follow the chord.
    const straightLayer: ObjectLayer = {
      ...layer,
      keyframes: smoothLayer.keyframes.map((keyframe) =>
        keyframe.tween ? { ...keyframe, tween: { easing: 'linear' as const } } : keyframe
      )
    }
    expect(evaluateLayerAtFrame(straightLayer, 5)[0].center.x).toBe(50)
    expect(evaluateLayerAtFrame(straightLayer, 5)[0].center.y).toBe(50)
  })

  it('keeps the straight chord when a smooth segment lacks a neighbour (2 waypoints)', () => {
    const twoWaypoints: ObjectLayer = {
      ...layer,
      keyframes: [
        { frame: 0, nodes: [shape('a', { center: { x: 0, y: 0 } })], tween: { easing: 'linear', path: 'smooth' } },
        { frame: 10, nodes: [shape('a', { center: { x: 100, y: 50 } })] }
      ]
    }
    // Clamped handles ride the chord itself: the sampled center stays on it.
    const atFive = evaluateLayerAtFrame(twoWaypoints, 5)[0].center
    expect(atFive.x).toBeCloseTo(50)
    expect(atFive.y).toBeCloseTo(25)
  })

  it('uses the target keyframe content at its frame', () => {
    expect(evaluateLayerAtFrame(layer, 10)[0].center.x).toBe(100)
  })

  it('stops rendering after the last keyframe', () => {
    // The object stays on stage through its final keyframe, but not beyond it.
    expect(evaluateLayerAtFrame(layer, 10)[0].center.x).toBe(100)
    expect(evaluateLayerAtFrame(layer, 15)).toEqual([])
  })

  it('tweens each node toward its own next keyframe and hides it after its last one', () => {
    const partial: ObjectLayer = {
      ...layer,
      keyframes: [
        {
          frame: 0,
          tween: { easing: 'linear' },
          nodes: [
            shape('a', { center: { x: 0, y: 0 } }),
            shape('b', { center: { x: 5, y: 0 } })
          ]
        },
        { frame: 10, nodes: [shape('a', { center: { x: 100, y: 0 } })] },
        { frame: 20, nodes: [shape('b', { center: { x: 5, y: 0 } })] }
      ]
    }
    // `a` tweens toward its own next keyframe (10); `b` is keyed only at 0
    // and 20 with the same pose, so it holds its position.
    const atFive = evaluateLayerAtFrame(partial, 5)
    expect(atFive.map((s) => s.id).sort()).toEqual(['a', 'b'])
    expect(atFive.find((s) => s.id === 'a')?.center.x).toBe(50)
    expect(atFive.find((s) => s.id === 'b')?.center.x).toBe(5)

    // After `a`'s last keyframe (10) it leaves the stage; `b` stays until 20.
    const atFifteen = evaluateLayerAtFrame(partial, 15)
    expect(atFifteen.map((s) => s.id)).toEqual(['b'])
    expect(atFifteen[0].center.x).toBe(5)
    expect(evaluateLayerAtFrame(partial, 20).map((s) => s.id)).toEqual(['b'])
    expect(evaluateLayerAtFrame(partial, 21)).toEqual([])
  })

  it('tweens a group through a tweened span as one unit', () => {
    const groupLayer: ObjectLayer = {
      kind: 'object',
      id: 'layer',
      name: 'Layer 1',
      visible: true,
      locked: false,
      keyframes: [
        {
          frame: 0,
          nodes: [group('g', { center: { x: 0, y: 0 }, opacity: 1 })],
          tween: { easing: 'linear' }
        },
        { frame: 10, nodes: [group('g', { center: { x: 100, y: 0 }, opacity: 0 })] }
      ]
    }
    const atFive = evaluateLayerAtFrame(groupLayer, 5)[0] as GroupNode
    expect(atFive.center.x).toBe(50)
    expect(atFive.opacity).toBeCloseTo(0.5)
    expect(atFive.children).toEqual((groupLayer.keyframes[0].nodes[0] as GroupNode).children)
  })

  it('ignores a tween on the final keyframe', () => {
    const trailing: ObjectLayer = {
      ...layer,
      keyframes: [
        ...layer.keyframes,
        { frame: 20, nodes: [shape('a', { center: { x: 999, y: 0 } })], tween: { easing: 'linear' } }
      ]
    }
    // The final tween never interpolates and the object ends at frame 20.
    expect(evaluateLayerAtFrame(trailing, 20)[0].center.x).toBe(999)
    expect(evaluateLayerAtFrame(trailing, 25)).toEqual([])
  })

  it('morphs a compatible path through a tweened span, endpoints exact', () => {
    const path = (d: string): PathNode => ({
      type: 'path',
      id: 'p',
      center: { x: 0, y: 0 },
      width: 20,
      height: 10,
      rotation: 0,
      opacity: 1,
      d,
      fill: '#0000ff'
    })
    const morphLayer: ObjectLayer = {
      ...layer,
      keyframes: [
        { frame: 0, nodes: [path('M0 0 L20 0 L20 10 Z')], tween: { easing: 'linear' } },
        { frame: 10, nodes: [path('M0 0 L30 0 L30 10 Z')] }
      ]
    }
    // Keyframe frames evaluate the tween at progress 0/1 — the ends must
    // stay byte-identical to the authored data.
    expect((evaluateLayerAtFrame(morphLayer, 0)[0] as PathNode).d).toBe('M0 0 L20 0 L20 10 Z')
    expect((evaluateLayerAtFrame(morphLayer, 10)[0] as PathNode).d).toBe('M0 0 L30 0 L30 10 Z')
    const mid = evaluateLayerAtFrame(morphLayer, 5)[0] as PathNode
    expect(mid.d).not.toBe('M0 0 L20 0 L20 10 Z')
    expect(mid.d).not.toBe('M0 0 L30 0 L30 10 Z')
    expect(mid.d).toBe('M-12.5 -5L12.5 -5L12.5 5L-12.5 -5Z')
  })
})

describe('document validation', () => {
  it('isAnimatorDocument accepts valid documents and rejects junk', async () => {
    const { isAnimatorDocument } = await import('./document')
    const valid: AnimatorDocument = {
      schemaVersion: 9,
      name: 'test',
      width: 100,
      height: 100,
      fps: 24,
      background: '#000000',
      layers: [{ kind: 'object', id: 'l', name: 'L', visible: true, locked: false, keyframes: [] as never[] }],
      assets: [],
      palette: ['#ff0000'],
      fonts: []
    }
    expect(isAnimatorDocument(valid)).toBe(true)
    expect(isAnimatorDocument({})).toBe(false)
    expect(isAnimatorDocument(null)).toBe(false)
    expect(isAnimatorDocument({ ...valid, fps: 0 })).toBe(false)
    expect(isAnimatorDocument({ ...valid, layers: 'nope' })).toBe(false)
    expect(isAnimatorDocument({ ...valid, assets: 'nope' })).toBe(false)
    // The current schema requires a well-formed palette of hex colors.
    expect(isAnimatorDocument({ ...valid, palette: undefined })).toBe(false)
    expect(isAnimatorDocument({ ...valid, palette: ['red'] })).toBe(false)
    expect(isAnimatorDocument({ ...valid, palette: ['#ff0000', '#ff0000'] })).toBe(true)
  })
})
