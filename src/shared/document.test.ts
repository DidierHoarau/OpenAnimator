import { describe, expect, it } from 'vitest'

import {
  addLayer,
  addNodeToLayer,
  cloneDocument,
  createDocument,
  documentDuration,
  evaluateLayerAtFrame,
  findKeyframeAtFrame,
  insertBlankKeyframe,
  insertFrame,
  insertKeyframe,
  isAnimatorDocument,
  isSceneNode,
  removeKeyframe,
  removeLayer,
  removeNodeFromLayer,
  setKeyframeTween,
  updateNodeInLayer
} from './document'
import { createStarterDocument } from './starterDocument'
import { cloneNode } from './model'
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

describe('document operations', () => {
  it('creates a document with one empty layer and keyframe at 0', () => {
    const doc = createDocument('test', 960, 540, 24)
    expect(doc.schemaVersion).toBe(2)
    expect(doc.layers).toHaveLength(1)
    expect(doc.layers[0].keyframes).toEqual([{ frame: 0, nodes: [] }])
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
    addNodeToLayer(layer, 0, rect('a', 10, 10))
    const created = insertKeyframe(layer, 10)
    expect(created).not.toBeNull()
    expect(created?.nodes).toHaveLength(1)
    // A copy, not the same object.
    expect(created?.nodes[0]).not.toBe(layer.keyframes[0].nodes[0])
    expect(findKeyframeAtFrame(layer, 10)?.nodes[0].id).toBe('a')
  })

  it('rejects duplicate keyframes at the same frame', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    expect(insertKeyframe(layer, 0)).toBeNull()
    expect(insertBlankKeyframe(layer, 0)).toBeNull()
  })

  it('inserts a blank keyframe that contributes no poses', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    addNodeToLayer(layer, 0, rect('a', 10, 10))
    insertBlankKeyframe(layer, 10)
    // The blank keyframe neither clears nor extends the shape: it stays on
    // stage only at its own keyframe.
    expect(findKeyframeAtFrame(layer, 10)?.nodes).toEqual([])
    expect(evaluateLayerAtFrame(layer, 0)[0].id).toBe('a')
    expect(evaluateLayerAtFrame(layer, 5)).toEqual([])
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
    addNodeToLayer(layer, 0, rect('a', 10, 10))
    insertKeyframe(layer, 10)
    // Moving the shape in the new keyframe must not affect the previous one.
    updateNodeInLayer(layer, 10, 'a', (node) => {
      node.center.x = 500
    })
    expect(findKeyframeAtFrame(layer, 0)?.nodes[0].center.x).toBe(10)
    expect(findKeyframeAtFrame(layer, 10)?.nodes[0].center.x).toBe(500)
  })

  it('clones nodes including nested objects and group children', () => {
    const node = rect('a', 10, 20)
    const copy = cloneNode(node)
    expect(copy).toEqual(node)
    expect(copy).not.toBe(node)
    expect(copy.center).not.toBe(node.center)
    copy.center.x = 99
    expect(node.center.x).toBe(10)

    const group: GroupNode = {
      type: 'group',
      id: 'g',
      center: { x: 0, y: 0 },
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1,
      children: [rect('child', 5, 5)]
    }
    const groupCopy = cloneNode(group)
    expect(groupCopy).toEqual(group)
    expect(groupCopy).not.toBe(group)
    expect((groupCopy as GroupNode).children[0]).not.toBe(group.children[0])
    ;(groupCopy as GroupNode).children[0].center.x = 77
    expect(group.children[0].center.x).toBe(5)
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

  it('insertFrame shifts keyframes on all layers', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer1 = doc.layers[0]
    insertKeyframe(layer1, 5)
    const layer2 = addLayer(doc, 'Layer 2')
    insertKeyframe(layer2, 5)
    insertFrame(doc, layer1.id, 3)
    expect(layer1.keyframes.map((k) => k.frame).sort((a, b) => a - b)).toEqual([0, 6])
    expect(layer2.keyframes.map((k) => k.frame).sort((a, b) => a - b)).toEqual([0, 6])
  })

  it('computes the duration from the authored frame count when larger', () => {
    const doc = createDocument('test', 960, 540, 24)
    doc.frames = 25
    expect(documentDuration(doc)).toBe(25)
    insertKeyframe(doc.layers[0], 40)
    expect(documentDuration(doc)).toBe(41)
  })

  it('isAnimatorDocument requires schemaVersion 2 and validates deeply', () => {
    const valid = createDocument('test', 960, 540, 24)
    valid.layers[0].keyframes[0].nodes.push(rect('a', 0, 0))
    expect(isAnimatorDocument(valid)).toBe(true)
    expect(isAnimatorDocument(cloneDocument(valid))).toBe(true)

    // Anything without schemaVersion 2 (e.g. a v1 document) is rejected here;
    // those go through migrateDocument instead.
    const v1 = valid as unknown as Record<string, unknown>
    delete v1.schemaVersion
    expect(isAnimatorDocument(v1)).toBe(false)

    expect(isAnimatorDocument({})).toBe(false)
    expect(isAnimatorDocument(null)).toBe(false)
    expect(isAnimatorDocument({ ...valid, fps: 0 })).toBe(false)
    expect(isAnimatorDocument({ ...valid, layers: 'nope' })).toBe(false)
    expect(isAnimatorDocument({ ...valid, background: 5 })).toBe(false)

    const badFrames = { ...valid, frames: 0 }
    expect(isAnimatorDocument(badFrames)).toBe(false)
    const fractionalFrames = { ...valid, frames: 2.5 }
    expect(isAnimatorDocument(fractionalFrames)).toBe(false)
    const stringFrames = { ...valid, frames: '12' }
    expect(isAnimatorDocument(stringFrames)).toBe(false)
  })

  it('isAnimatorDocument rejects malformed layers, keyframes and nodes', () => {
    const valid = createDocument('test', 960, 540, 24)
    const layer = valid.layers[0]
    const keyframe = layer.keyframes[0]

    const badLayer = { ...valid, layers: [{ ...layer, visible: 'yes' }] }
    expect(isAnimatorDocument(badLayer)).toBe(false)

    const badFrame = { ...valid, layers: [{ ...layer, keyframes: [{ ...keyframe, frame: -1 }] }] }
    expect(isAnimatorDocument(badFrame)).toBe(false)

    const badEasing = {
      ...valid,
      layers: [{ ...layer, keyframes: [{ ...keyframe, tween: { easing: 'wobble' } }] }]
    }
    expect(isAnimatorDocument(badEasing)).toBe(false)

    const badNode = {
      ...valid,
      layers: [
        {
          ...layer,
          keyframes: [{ ...keyframe, nodes: [{ type: 'alien', id: 'x' }] }]
        }
      ]
    }
    expect(isAnimatorDocument(badNode)).toBe(false)
  })

  it('round-trips the authored frame count through JSON', () => {
    const doc = createStarterDocument()
    const restored: unknown = JSON.parse(JSON.stringify(doc))
    expect(isAnimatorDocument(restored)).toBe(true)
    expect((restored as { frames?: number }).frames).toBe(25)
  })

  it('adds nodes to the active keyframe and can remove/update them', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    addNodeToLayer(layer, 0, rect('a', 10, 10))
    expect(updateNodeInLayer(layer, 4, 'a', (node) => {
      node.center.x = 42
    })).toBe(true)
    // The update lands on the shape's own keyframe (frame 0).
    expect(evaluateLayerAtFrame(layer, 0)[0].center.x).toBe(42)
    expect(updateNodeInLayer(layer, 4, 'missing', () => undefined)).toBe(false)
    expect(removeNodeFromLayer(layer, 4, 'a')).toBe(true)
    expect(evaluateLayerAtFrame(layer, 0)).toEqual([])
  })

  it('creates a keyframe when drawing before the first keyframe', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = doc.layers[0]
    layer.keyframes = []
    addNodeToLayer(layer, 7, rect('a', 0, 0))
    expect(findKeyframeAtFrame(layer, 7)?.nodes).toHaveLength(1)
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

  it('cloneDocument returns a fully independent copy', () => {
    const doc = createStarterDocument()
    const clone = cloneDocument(doc)
    expect(clone).toEqual(doc)
    expect(clone).not.toBe(doc)
    clone.name = 'changed'
    clone.layers[0].name = 'changed layer'
    clone.layers[0].keyframes[0].nodes[0].center.x = -999
    clone.layers[0].keyframes[0].nodes[0].center.y = -999
    expect(doc.name).toBe('Untitled')
    expect(doc.layers[0].name).not.toBe('changed layer')
    expect(doc.layers[0].keyframes[0].nodes[0].center.x).not.toBe(-999)
    expect(doc.layers[0].keyframes[0].nodes[0].center.y).not.toBe(-999)
  })
})

describe('isSceneNode', () => {
  it('accepts every node kind and rejects junk', () => {
    expect(isSceneNode(rect('a', 0, 0))).toBe(true)
    expect(isSceneNode({ ...rect('a', 0, 0), primitive: 'ellipse' })).toBe(true)
    expect(
      isSceneNode({
        type: 'image',
        id: 'i',
        center: { x: 0, y: 0 },
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1,
        resourceId: 'res-1',
        naturalWidth: 100,
        naturalHeight: 100,
        smoothing: true
      })
    ).toBe(true)
    expect(
      isSceneNode({
        type: 'symbol',
        id: 's',
        center: { x: 0, y: 0 },
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1,
        assetId: 'asset-1'
      })
    ).toBe(true)
    const group: SceneNode = {
      type: 'group',
      id: 'g',
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      children: [rect('child', 0, 0)]
    }
    expect(isSceneNode(group)).toBe(true)

    expect(isSceneNode({ type: 'alien', id: 'x' })).toBe(false)
    expect(isSceneNode({ ...rect('a', 0, 0), type: 'nope' })).toBe(false)
    expect(isSceneNode({ ...rect('a', 0, 0), primitive: 'triangle' })).toBe(false)
    expect(isSceneNode({ ...rect('a', 0, 0), fill: 5 })).toBe(false)
    expect(isSceneNode({ ...rect('a', 0, 0), center: { x: 'x', y: 0 } })).toBe(false)
    expect(isSceneNode({ ...rect('a', 0, 0), width: NaN })).toBe(false)
    expect(isSceneNode({ ...rect('a', 0, 0), id: 7 })).toBe(false)
    expect(isSceneNode(null)).toBe(false)
    expect(isSceneNode({ ...group, children: [{ ...group, children: [] }] })).toBe(true)
    // A group holding a junk child is invalid (recursive validation).
    expect(isSceneNode({ ...group, children: [{ type: 'alien', id: 'x' }] })).toBe(false)
  })
})
