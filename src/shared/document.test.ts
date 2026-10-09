import { describe, expect, it } from 'vitest'

import {
  addLayer,
  addShapeToLayer,
  createDocument,
  documentDuration,
  evaluateLayerAtFrame,
  findKeyframeAtFrame,
  insertBlankKeyframe,
  insertFrame,
  insertKeyframe,
  isAnimatorDocument,
  removeKeyframe,
  removeLayer,
  removeShapeFromLayer,
  setKeyframeTween,
  updateShapeInLayer
} from './document'
import { createStarterDocument } from './starterDocument'
import { hitTestShape, hitTestShapes } from './hitTesting'
import type { Shape } from './model'

function rect(id: string, x: number, y: number, overrides: Partial<Shape> = {}): Shape {
  return {
    id,
    kind: 'rect',
    center: { x, y },
    width: 100,
    height: 50,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1,
    ...overrides
  }
}

describe('document operations', () => {
  it('creates a document with one empty layer and keyframe at 0', () => {
    const doc = createDocument('test', 960, 540, 24)
    expect(doc.layers).toHaveLength(1)
    expect(doc.layers[0].keyframes).toEqual([{ frame: 0, shapes: [] }])
    expect(documentDuration(doc)).toBe(1)
  })

  it('computes duration from the furthest keyframe', () => {
    const doc = createDocument('test', 960, 540, 24)
    insertKeyframe(doc.layers[0], 23)
    expect(documentDuration(doc)).toBe(24)
  })

  it('inserts a keyframe copying the active content', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    addShapeToLayer(layer, 0, rect('a', 10, 10))
    const created = insertKeyframe(layer, 10)
    expect(created).not.toBeNull()
    expect(created?.shapes).toHaveLength(1)
    // A copy, not the same object.
    expect(created?.shapes[0]).not.toBe(layer.keyframes[0].shapes[0])
    expect(findKeyframeAtFrame(layer, 10)?.shapes[0].id).toBe('a')
  })

  it('rejects duplicate keyframes at the same frame', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    expect(insertKeyframe(layer, 0)).toBeNull()
    expect(insertBlankKeyframe(layer, 0)).toBeNull()
  })

  it('inserts a blank keyframe, creating a gap in content', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    addShapeToLayer(layer, 0, rect('a', 10, 10))
    insertBlankKeyframe(layer, 10)
    expect(evaluateLayerAtFrame(layer, 15)).toEqual([])
    expect(evaluateLayerAtFrame(layer, 5)[0].id).toBe('a')
  })

  it('removes keyframes', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    insertKeyframe(layer, 10)
    expect(removeKeyframe(layer, 10)).toBe(true)
    expect(removeKeyframe(layer, 10)).toBe(false)
    expect(layer.keyframes).toHaveLength(1)
  })

  it('sets and clears tweens', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    insertKeyframe(layer, 10)
    expect(setKeyframeTween(layer, 0, { easing: 'linear' })).toBe(true)
    expect(layer.keyframes[0].tween).toEqual({ easing: 'linear' })
    expect(setKeyframeTween(layer, 0, undefined)).toBe(true)
    expect(layer.keyframes[0].tween).toBeUndefined()
    expect(setKeyframeTween(layer, 99, { easing: 'linear' })).toBe(false)
  })

  it('inserts frames by shifting keyframes later', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    insertKeyframe(layer, 10)
    insertFrame(doc, layer.id, 5)
    expect(layer.keyframes.map((k) => k.frame).sort((a, b) => a - b)).toEqual([0, 11])
  })

  it('inserts a keyframe with an independent deep copy of the content', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    addShapeToLayer(layer, 0, rect('a', 10, 10))
    insertKeyframe(layer, 10)
    // Moving the shape in the new keyframe must not affect the previous one.
    updateShapeInLayer(layer, 10, 'a', (shape) => {
      shape.center.x = 500
    })
    expect(findKeyframeAtFrame(layer, 0)?.shapes[0].center.x).toBe(10)
    expect(findKeyframeAtFrame(layer, 10)?.shapes[0].center.x).toBe(500)
  })

  it('clones shapes including nested objects', async () => {
    const { cloneShape } = await import('./model')
    const shape = rect('a', 10, 20)
    const copy = cloneShape(shape)
    expect(copy).toEqual(shape)
    expect(copy).not.toBe(shape)
    expect(copy.center).not.toBe(shape.center)
    copy.center.x = 99
    expect(shape.center.x).toBe(10)
  })

  it('insertFrame extends the timeline on a fresh document', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    // Regression: on a fresh document F5 used to be a no-op and the playhead
    // was locked at frame 0 because the duration was keyframe-derived.
    insertFrame(doc, layer.id, 0)
    expect(documentDuration(doc)).toBe(2)
    expect(layer.keyframes.map((k) => k.frame)).toEqual([0])
  })

  it('insertFrame extends the timeline at and after the last keyframe', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    insertKeyframe(layer, 4)
    insertFrame(doc, layer.id, 4)
    // The authored length wins over the keyframe-derived duration.
    expect(documentDuration(doc)).toBe(6)
    expect(layer.keyframes.map((k) => k.frame).sort((a, b) => a - b)).toEqual([0, 4])
  })

  it('insertFrame ignores unknown layers', () => {
    const doc = createDocument('test', 960, 540, 24)
    expect(() => insertFrame(doc, 'missing', 0)).not.toThrow()
    expect(documentDuration(doc)).toBe(1)
  })

  it('computes the duration from the authored frame count when larger', () => {
    const doc = createDocument('test', 960, 540, 24)
    doc.frames = 25
    expect(documentDuration(doc)).toBe(25)
    insertKeyframe(doc.layers[0], 40)
    expect(documentDuration(doc)).toBe(41)
  })

  it('isAnimatorDocument accepts the legacy format without frames', () => {
    const legacy: Record<string, unknown> = {
      name: 'legacy',
      width: 100,
      height: 100,
      fps: 24,
      background: '#000000',
      layers: []
    }
    expect(isAnimatorDocument(legacy)).toBe(true)
    expect(isAnimatorDocument({ ...legacy, frames: 12 })).toBe(true)
    expect(isAnimatorDocument({ ...legacy, frames: 0 })).toBe(false)
    expect(isAnimatorDocument({ ...legacy, frames: -3 })).toBe(false)
    expect(isAnimatorDocument({ ...legacy, frames: 2.5 })).toBe(false)
    expect(isAnimatorDocument({ ...legacy, frames: '12' })).toBe(false)
  })

  it('round-trips the authored frame count through JSON', () => {
    const doc = createStarterDocument()
    const restored: unknown = JSON.parse(JSON.stringify(doc))
    expect(isAnimatorDocument(restored)).toBe(true)
    expect((restored as { frames?: number }).frames).toBe(25)
  })

  it('adds shapes to the active keyframe and can remove/update them', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    addShapeToLayer(layer, 0, rect('a', 10, 10))
    expect(updateShapeInLayer(layer, 4, 'a', (shape) => {
      shape.center.x = 42
    })).toBe(true)
    expect(evaluateLayerAtFrame(layer, 4)[0].center.x).toBe(42)
    expect(updateShapeInLayer(layer, 4, 'missing', () => undefined)).toBe(false)
    expect(removeShapeFromLayer(layer, 4, 'a')).toBe(true)
    expect(evaluateLayerAtFrame(layer, 4)).toEqual([])
  })

  it('creates a keyframe when drawing before the first keyframe', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    layer.keyframes = []
    addShapeToLayer(layer, 7, rect('a', 0, 0))
    expect(findKeyframeAtFrame(layer, 7)?.shapes).toHaveLength(1)
  })

  it('adds layers on top and never removes the last layer', () => {
    const doc = createDocument('test', 960, 540, 24)
    const added = addLayer(doc, 'Overlay')
    expect(doc.layers[0].id).toBe(added.id)
    expect(doc.layers[0].keyframes[0].frame).toBe(0)
    expect(removeLayer(doc, added.id)).toBe(true)
    expect(doc.layers).toHaveLength(1)
    expect(removeLayer(doc, doc.layers[0].id)).toBe(false)
  })

  it('survives a JSON serialization round-trip (the save format)', () => {
    const doc = createStarterDocument()
    const restored: unknown = JSON.parse(JSON.stringify(doc))
    expect(isAnimatorDocument(restored)).toBe(true)
  })
})

describe('hit testing', () => {
  it('hits axis-aligned rectangles', () => {
    const shape = rect('a', 100, 100)
    expect(hitTestShape(shape, { x: 100, y: 100 })).toBe(true)
    expect(hitTestShape(shape, { x: 148, y: 124 })).toBe(true)
    expect(hitTestShape(shape, { x: 160, y: 100 })).toBe(false)
  })

  it('hits rotated rectangles in local space', () => {
    const shape = rect('a', 100, 100, { rotation: 90 })
    // 90° clockwise: the 100-wide, 50-tall rect spans ±25 horizontally and ±50 vertically.
    expect(hitTestShape(shape, { x: 100, y: 135 })).toBe(true)
    expect(hitTestShape(shape, { x: 135, y: 100 })).toBe(false)
  })

  it('hits ellipses', () => {
    const shape = rect('a', 100, 100, { kind: 'ellipse' })
    expect(hitTestShape(shape, { x: 100, y: 100 })).toBe(true)
    expect(hitTestShape(shape, { x: 149, y: 100 })).toBe(true)
    expect(hitTestShape(shape, { x: 145, y: 145 })).toBe(false)
  })

  it('returns the topmost matching shape', () => {
    const a = rect('a', 0, 0)
    const b = rect('b', 0, 0)
    expect(hitTestShapes([a, b], { x: 0, y: 0 })?.id).toBe('b')
    expect(hitTestShapes([a, b], { x: 0, y: 1000 })).toBeUndefined()
  })
})
