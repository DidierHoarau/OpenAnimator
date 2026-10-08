import { describe, expect, it } from 'vitest'

import { evaluateLayerAtFrame } from './document'
import type { AnimatorDocument, Keyframe, Layer, Shape } from './model'
import { tweenShape, tweenShapes } from './tween'

function shape(id: string, overrides: Partial<Shape> = {}): Shape {
  return {
    id,
    kind: 'rect',
    center: { x: 0, y: 0 },
    width: 100,
    height: 50,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1,
    ...overrides
  }
}

describe('tweenShape', () => {
  it('interpolates geometry, rotation and opacity', () => {
    const from = shape('a', { center: { x: 0, y: 0 }, rotation: 0, opacity: 1 })
    const to = shape('a', { center: { x: 100, y: 200 }, rotation: 90, opacity: 0 })
    const result = tweenShape(from, to, 0.5)
    expect(result.center).toEqual({ x: 50, y: 100 })
    expect(result.rotation).toBe(45)
    expect(result.opacity).toBe(0.5)
  })

  it('interpolates fill colors', () => {
    const result = tweenShape(shape('a', { fill: '#000000' }), shape('a', { fill: '#ffffff' }), 0.5)
    expect(result.fill).toBe('#808080')
  })

  it('snaps between shapes of different kinds', () => {
    const from = shape('a', { kind: 'rect' })
    const to = shape('a', { kind: 'ellipse' })
    expect(tweenShape(from, to, 0.5).kind).toBe('rect')
    expect(tweenShape(from, to, 1).kind).toBe('ellipse')
  })

  it('falls back to raw colors when not valid hex', () => {
    const from = shape('a', { fill: 'red' })
    const to = shape('a', { fill: 'blue' })
    expect(tweenShape(from, to, 0.5).fill).toBe('red')
    expect(tweenShape(from, to, 1).fill).toBe('blue')
  })
})

describe('tweenShapes', () => {
  it('tweens matching shapes and holds static the others', () => {
    const from = [shape('a', { center: { x: 0, y: 0 } }), shape('static')]
    const to = [shape('a', { center: { x: 100, y: 0 } }), shape('b')]
    const result = tweenShapes(from, to, 0.5)
    expect(result).toHaveLength(2)
    expect(result[0].center.x).toBe(50)
    expect(result[1].center.x).toBe(0)
  })
})

describe('evaluateLayerAtFrame', () => {
  const layer: Layer = {
    id: 'layer',
    name: 'Layer 1',
    visible: true,
    locked: false,
    keyframes: [
      {
        frame: 0,
        shapes: [shape('a', { center: { x: 0, y: 0 } })],
        tween: { easing: 'linear' }
      },
      { frame: 10, shapes: [shape('a', { center: { x: 100, y: 0 } })] }
    ]
  }

  it('renders nothing before the first keyframe', () => {
    const emptyLayer: Layer = { ...layer, keyframes: [{ frame: 5, shapes: [shape('a')] }] }
    expect(evaluateLayerAtFrame(emptyLayer, 2)).toEqual([])
  })

  it('interpolates inside a tweened span with easing', () => {
    expect(evaluateLayerAtFrame(layer, 5)[0].center.x).toBe(50)
  })

  it('uses the target keyframe content at its frame', () => {
    expect(evaluateLayerAtFrame(layer, 10)[0].center.x).toBe(100)
  })

  it('holds static after the last keyframe', () => {
    expect(evaluateLayerAtFrame(layer, 15)[0].center.x).toBe(100)
  })

  it('ignores a tween on the final keyframe', () => {
    const trailing: Layer = {
      ...layer,
      keyframes: [
        ...layer.keyframes,
        { frame: 20, shapes: [shape('a', { center: { x: 999, y: 0 } })], tween: { easing: 'linear' } }
      ]
    }
    expect(evaluateLayerAtFrame(trailing, 25)[0].center.x).toBe(999)
  })
})

describe('document validation', () => {
  it('isAnimatorDocument accepts valid documents and rejects junk', async () => {
    const { isAnimatorDocument } = await import('./document')
    const valid: AnimatorDocument = {
      name: 'test',
      width: 100,
      height: 100,
      fps: 24,
      background: '#000000',
      layers: [{ id: 'l', name: 'L', visible: true, locked: false, keyframes: [] as Keyframe[] }]
    }
    expect(isAnimatorDocument(valid)).toBe(true)
    expect(isAnimatorDocument({})).toBe(false)
    expect(isAnimatorDocument(null)).toBe(false)
    expect(isAnimatorDocument({ ...valid, fps: 0 })).toBe(false)
    expect(isAnimatorDocument({ ...valid, layers: 'nope' })).toBe(false)
  })
})
