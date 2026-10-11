import { describe, expect, it } from 'vitest'

import {
  addLayer,
  addNodeToLayer,
  createDocument,
  findKeyframeAtFrame,
  getLayer,
  insertFrame,
  insertKeyframe,
  moveLayer,
  removeFrame,
  removeNodeFromAllKeyframes,
  removeNodeFromLayer,
  renameLayer,
  renameNodeInLayer
} from './document'
import type { AnimatorDocument, ObjectLayer, PrimitiveNode } from './model'

function rect(id: string): PrimitiveNode {
  return {
    type: 'primitive',
    primitive: 'rect',
    id,
    center: { x: 0, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1
  }
}

function firstLayer(doc: AnimatorDocument): ObjectLayer {
  const layer = doc.layers[0]
  if (layer.kind !== 'object') throw new Error('expected an object layer')
  return layer
}

describe('timeline document operations', () => {
  it('removeNodeFromLayer drops the keyframe emptied by the removal', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    addNodeToLayer(layer, 0, rect('a'))
    expect(findKeyframeAtFrame(layer, 0)?.nodes).toHaveLength(1)

    expect(removeNodeFromLayer(layer, 0, 'a')).toBe(true)
    // The timeline has no blank keyframes: the emptied keyframe is dropped.
    expect(findKeyframeAtFrame(layer, 0)).toBeUndefined()
    expect(removeNodeFromLayer(layer, 0, 'a')).toBe(false)
  })

  it('removeNodeFromAllKeyframes reports and drops every emptied keyframe', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    addNodeToLayer(layer, 0, rect('a'))
    addNodeToLayer(layer, 0, rect('b'))
    // kf 4 copies a and b; drop b so both keyframes hold exactly one shape.
    insertKeyframe(layer, 4)
    expect(removeNodeFromLayer(layer, 4, 'b')).toBe(true)

    expect(removeNodeFromAllKeyframes(layer, 'a')).toBe(2)
    // The emptied keyframe 4 is dropped; keyframe 0 still holds b.
    expect(layer.keyframes).toHaveLength(1)
    expect(layer.keyframes[0].frame).toBe(0)
    expect(layer.keyframes[0].nodes.map((node) => node.id)).toEqual(['b'])
  })

  it('renameNodeInLayer renames the node in every keyframe it appears in', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    addNodeToLayer(layer, 0, rect('a'))
    insertKeyframe(layer, 3)

    expect(renameNodeInLayer(layer, 'a', 'Hero')).toBe(true)
    for (const keyframe of layer.keyframes) {
      expect(keyframe.nodes.find((node) => node.id === 'a')?.name).toBe('Hero')
    }
    expect(renameNodeInLayer(layer, 'ghost', 'Nope')).toBe(false)
  })

  it('removeFrame shifts later keyframes and deletes the keyframe at the frame', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    addNodeToLayer(layer, 0, rect('a'))
    insertKeyframe(layer, 2)
    insertFrame(doc, layer.id, 0)
    expect(findKeyframeAtFrame(layer, 3)).toBeDefined()

    removeFrame(doc, 1)
    expect(findKeyframeAtFrame(layer, 3)).toBeUndefined()
    expect(findKeyframeAtFrame(layer, 2)).toBeDefined()
    expect(findKeyframeAtFrame(layer, 0)).toBeDefined()
  })

  it('removeFrame never deletes the last remaining keyframe of a layer', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    addNodeToLayer(layer, 0, rect('a'))
    insertKeyframe(layer, 1)

    removeFrame(doc, 1)
    expect(findKeyframeAtFrame(layer, 1)).toBeUndefined()
    expect(findKeyframeAtFrame(layer, 0)).toBeDefined()

    removeFrame(doc, 0)
    expect(findKeyframeAtFrame(layer, 0)).toBeDefined()
  })

  it('moveLayer reorders layers, clamps out-of-range targets and reports no-ops', () => {
    const doc = createDocument('test', 960, 540, 24)
    const first = firstLayer(doc)
    const second = addLayer(doc, 'Second', 'bottom')
    expect(doc.layers[1].id).toBe(second.id)

    expect(moveLayer(doc, second.id, 0)).toBe(true)
    expect(doc.layers[0].id).toBe(second.id)
    expect(moveLayer(doc, second.id, 9)).toBe(true)
    expect(doc.layers[doc.layers.length - 1].id).toBe(second.id)
    expect(moveLayer(doc, second.id, 1)).toBe(false)
    expect(moveLayer(doc, 'ghost', 0)).toBe(false)
    expect(doc.layers[0].id).toBe(first.id)
    expect(doc.layers[1].id).toBe(second.id)
  })

  it('addLayer appends at the bottom or the top and renameLayer renames', () => {
    const doc = createDocument('test', 960, 540, 24)
    const bottom = addLayer(doc, 'Bottom', 'bottom')
    const top = addLayer(doc, 'Top')
    expect(doc.layers[0].id).toBe(top.id)
    expect(doc.layers[doc.layers.length - 1].id).toBe(bottom.id)

    expect(renameLayer(doc, bottom.id, 'Foreground')).toBe(true)
    expect(getLayer(doc, bottom.id)?.name).toBe('Foreground')
    expect(renameLayer(doc, 'ghost', 'X')).toBe(false)
  })
})
