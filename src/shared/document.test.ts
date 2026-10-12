import { describe, expect, it } from 'vitest'

import {
  addLayer,
  addNodeToLayer,
  applyKeyframeChunk,
  cellRangeAtFrame,
  cloneDocument,
  createDocument,
  createDrawingLayer,
  documentDuration,
  evaluateLayerAtFrame,
  extractKeyframeChunk,
  findKeyframeAtFrame,
  holdStepOf,
  insertBlankKeyframe,
  insertCell,
  insertFrame,
  insertKeyframe,
  isAnimatorDocument,
  isAsset,
  isSceneNode,
  moveCell,
  moveKeyframeEntries,
  moveNodeKeyframeEntry,
  moveNodeKeyframes,
  removeCell,
  removeFrame,
  removeKeyframe,
  removeLayer,
  removeNodeFromLayer,
  resolveCellAtFrame,
  setCellContent,
  setCellEnd,
  setKeyframeTween,
  updateNodeInLayer
} from './document'
import { createStarterDocument } from './starterDocument'
import { cloneNode, isObjectLayer } from './model'
import type { AnimatorDocument, GroupNode, ObjectLayer, PrimitiveNode, SceneNode } from './model'

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

function firstLayer(doc: AnimatorDocument): ObjectLayer {
  const layer = doc.layers[0]
  if (!isObjectLayer(layer)) throw new Error('expected an object layer')
  return layer
}

describe('document operations', () => {
  it('creates a document with one empty layer and keyframe at 0', () => {
    const doc = createDocument('test', 960, 540, 24)
    expect(doc.schemaVersion).toBe(5)
    expect(doc.palette).toEqual([])
    expect(doc.layers).toHaveLength(1)
    expect(firstLayer(doc).keyframes).toEqual([{ frame: 0, nodes: [] }])
    expect(documentDuration(doc)).toBe(1)
  })

  it('computes duration from the furthest keyframe', () => {
    const doc = createDocument('test', 960, 540, 24)
    insertKeyframe(firstLayer(doc), 23)
    expect(documentDuration(doc)).toBe(24)
  })

  it('inserts a keyframe copying the active content', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
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
    const layer = firstLayer(doc)
    expect(insertKeyframe(layer, 0)).toBeNull()
    expect(insertBlankKeyframe(layer, 0)).toBeNull()
  })

  it('inserts a blank keyframe that contributes no poses', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
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
    const layer = firstLayer(doc)
    insertKeyframe(layer, 10)
    expect(removeKeyframe(layer, 10)).toBe(true)
    expect(removeKeyframe(layer, 10)).toBe(false)
    expect(layer.keyframes).toHaveLength(1)
  })

  it('sets and clears tweens', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    insertKeyframe(layer, 10)
    expect(setKeyframeTween(layer, 0, { easing: 'linear' })).toBe(true)
    expect(layer.keyframes[0].tween).toEqual({ easing: 'linear' })
    expect(setKeyframeTween(layer, 0, undefined)).toBe(true)
    expect(layer.keyframes[0].tween).toBeUndefined()
    expect(setKeyframeTween(layer, 99, { easing: 'linear' })).toBe(false)
  })

  it('inserts frames by shifting keyframes later', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    insertKeyframe(layer, 10)
    insertFrame(doc, layer.id, 5)
    expect(layer.keyframes.map((k) => k.frame).sort((a, b) => a - b)).toEqual([0, 11])
  })

  it('inserts a keyframe with an independent deep copy of the content', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
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
    const layer = firstLayer(doc)
    // Regression: on a fresh document F5 used to be a no-op and the playhead
    // was locked at frame 0 because the duration was keyframe-derived.
    insertFrame(doc, layer.id, 0)
    expect(documentDuration(doc)).toBe(2)
    expect(layer.keyframes.map((k) => k.frame)).toEqual([0])
  })

  it('insertFrame extends the timeline at and after the last keyframe', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
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
    const layer1 = firstLayer(doc)
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
    insertKeyframe(firstLayer(doc), 40)
    expect(documentDuration(doc)).toBe(41)
  })

  it('isAnimatorDocument requires schemaVersion 4 and validates deeply', () => {
    const valid = createDocument('test', 960, 540, 24)
    firstLayer(valid).keyframes[0].nodes.push(rect('a', 0, 0))
    expect(isAnimatorDocument(valid)).toBe(true)
    expect(isAnimatorDocument(cloneDocument(valid))).toBe(true)

    // Anything without schemaVersion 4 (e.g. a v1 document) is rejected here;
    // those go through migrateDocument instead.
    const v1 = { ...valid } as Record<string, unknown>
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

    // Hold step: an integer in [1, 16] when present.
    expect(isAnimatorDocument({ ...valid, holdStep: 2 })).toBe(true)
    expect(isAnimatorDocument({ ...valid, holdStep: 16 })).toBe(true)
    expect(isAnimatorDocument({ ...valid, holdStep: 0 })).toBe(false)
    expect(isAnimatorDocument({ ...valid, holdStep: 17 })).toBe(false)
    expect(isAnimatorDocument({ ...valid, holdStep: 1.5 })).toBe(false)
    expect(isAnimatorDocument({ ...valid, holdStep: '2' })).toBe(false)
  })

  it('isAnimatorDocument rejects malformed layers, keyframes and nodes', () => {
    const valid = createDocument('test', 960, 540, 24)
    const layer = firstLayer(valid)
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
    const layer = firstLayer(doc)
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
    const layer = firstLayer(doc)
    layer.keyframes = []
    addNodeToLayer(layer, 7, rect('a', 0, 0))
    expect(findKeyframeAtFrame(layer, 7)?.nodes).toHaveLength(1)
  })

  it('adds layers on top and never removes the last layer', () => {
    const doc = createDocument('test', 960, 540, 24)
    const added = addLayer(doc, 'Overlay')
    expect(doc.layers[0].id).toBe(added.id)
    expect(firstLayer(doc).keyframes[0].frame).toBe(0)
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
    const cloneLayer = firstLayer(clone)
    const docLayer = firstLayer(doc)
    cloneLayer.name = 'changed layer'
    cloneLayer.keyframes[0].nodes[0].center.x = -999
    cloneLayer.keyframes[0].nodes[0].center.y = -999
    expect(doc.name).toBe('Untitled')
    expect(docLayer.name).not.toBe('changed layer')
    expect(docLayer.keyframes[0].nodes[0].center.x).not.toBe(-999)
    expect(docLayer.keyframes[0].nodes[0].center.y).not.toBe(-999)
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

    const path: SceneNode = {
      type: 'path',
      id: 'p',
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      d: 'M0 0L10 10',
      stroke: '#ffffff',
      strokeWidth: 2
    }
    expect(isSceneNode(path)).toBe(true)
    expect(isSceneNode({ ...path, fill: '#22d3ee' })).toBe(true)
    expect(isSceneNode({ ...path, d: 42 })).toBe(false)
    expect(isSceneNode({ ...path, fill: 5 })).toBe(false)
    expect(isSceneNode({ ...path, strokeWidth: 'thick' })).toBe(false)

    const text: SceneNode = {
      type: 'text',
      id: 't',
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      text: 'Hello',
      fontFamily: 'Noto Sans',
      fontSize: 24,
      fontWeight: 700,
      fill: '#ffffff',
      align: 'center'
    }
    expect(isSceneNode(text)).toBe(true)
    expect(isSceneNode({ ...text, text: 5 })).toBe(false)
    expect(isSceneNode({ ...text, fontSize: 'big' })).toBe(false)
    expect(isSceneNode({ ...text, align: 'justified' })).toBe(false)
    expect(isSceneNode({ ...text, fill: null })).toBe(false)

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

describe('isAsset', () => {
  function symbolContent(): GroupNode {
    return {
      type: 'group',
      id: 'content',
      center: { x: 0, y: 0 },
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1,
      children: [rect('child', 0, 0)]
    }
  }

  it('accepts valid symbol and image assets', () => {
    expect(
      isAsset({ id: 'a', name: 'Rocket', kind: 'symbol', content: symbolContent(), createdAt: 1 })
    ).toBe(true)
    expect(
      isAsset({ id: 'b', name: 'pic', kind: 'image', resourceId: 'hash-a', createdAt: 2 })
    ).toBe(true)
    expect(
      isAsset({ id: 'b', name: 'pic', kind: 'image', resourceId: 'hash-a', naturalWidth: 10, naturalHeight: 20, createdAt: 2 })
    ).toBe(true)
  })

  it('rejects junk shapes and missing discriminant fields', () => {
    expect(isAsset(null)).toBe(false)
    expect(isAsset('nope')).toBe(false)
    expect(isAsset({ id: 'a', name: 'x', kind: 'texture', createdAt: 1 })).toBe(false)
    expect(isAsset({ id: 'a', name: 'x', kind: 'symbol', createdAt: 1 })).toBe(false)
    // Symbol content must be a valid group node.
    expect(isAsset({ id: 'a', name: 'x', kind: 'symbol', content: { type: 'alien' }, createdAt: 1 })).toBe(false)
    expect(isAsset({ id: 'a', name: 'x', kind: 'symbol', content: null, createdAt: 1 })).toBe(false)
    // Image assets need a resource id; sizes must be finite when present.
    expect(isAsset({ id: 'a', name: 'x', kind: 'image', createdAt: 1 })).toBe(false)
    expect(isAsset({ id: 'a', name: 'x', kind: 'image', resourceId: 'h', naturalWidth: NaN, createdAt: 1 })).toBe(false)
    expect(isAsset({ id: 'a', name: 'x', kind: 'image', resourceId: 'h', createdAt: 'now' })).toBe(false)
    expect(isAsset({ id: 'a', kind: 'image', resourceId: 'h', createdAt: 1 })).toBe(false)
  })

  it('feeds document validation: malformed assets reject the whole document', () => {
    const valid = createDocument('test', 960, 540, 24)
    expect(isAnimatorDocument(valid)).toBe(true)
    expect(isAnimatorDocument({ ...valid, assets: [{ garbage: true }] })).toBe(false)
    const withAsset = createDocument('test', 960, 540, 24)
    withAsset.assets = [{ id: 'a', name: 'Rocket', kind: 'symbol', content: symbolContent(), createdAt: 1 }]
    expect(isAnimatorDocument(withAsset)).toBe(true)
  })
})

describe('drawing layers and cells', () => {
  function drawingLayer(): ReturnType<typeof createDrawingLayer> {
    return createDrawingLayer('Draw')
  }

  it('resolves cells with hold-until-next semantics', () => {
    const layer = drawingLayer()
    layer.cells.push({ frame: 2, resourceId: 'res-a' }, { frame: 5, resourceId: 'res-b' })
    expect(resolveCellAtFrame(layer, 0)).toBeNull()
    expect(resolveCellAtFrame(layer, 1)).toBeNull()
    expect(resolveCellAtFrame(layer, 2)).toBe('res-a')
    expect(resolveCellAtFrame(layer, 4)).toBe('res-a')
    expect(resolveCellAtFrame(layer, 5)).toBe('res-b')
    // The last cell holds to the end of the timeline.
    expect(resolveCellAtFrame(layer, 99)).toBe('res-b')
  })

  it('setCellContent replaces the cell at the frame and sorts by frame', () => {
    const layer = drawingLayer()
    const first = setCellContent(layer, 3, 'res-a')
    const second = setCellContent(layer, 0, 'res-b')
    expect(layer.cells.map((cell) => cell.frame)).toEqual([0, 3])
    expect(setCellContent(layer, 3, 'res-c')).toBe(first)
    expect(first.resourceId).toBe('res-c')
    expect(second.resourceId).toBe('res-b')
  })

  it('insertCell refuses duplicates and removeCell removes exactly one frame', () => {
    const layer = drawingLayer()
    expect(insertCell(layer, 0, 'res-a')).not.toBeNull()
    expect(insertCell(layer, 0, 'res-b')).toBeNull()
    expect(removeCell(layer, 1)).toBe(false)
    expect(removeCell(layer, 0)).toBe(true)
    expect(removeCell(layer, 0)).toBe(false)
    expect(layer.cells).toHaveLength(0)
  })

  it('cellRangeAtFrame reports the hold of the cell at a frame', () => {
    const layer = drawingLayer()
    layer.cells.push(
      { frame: 2, resourceId: 'res-a' },
      { frame: 5, resourceId: 'res-b' },
      { frame: 9, resourceId: 'res-c' }
    )
    // Blank before the first cell.
    expect(cellRangeAtFrame(layer, 0, 20)).toBeNull()
    // Middle cell: holds to the frame before the next cell.
    expect(cellRangeAtFrame(layer, 2, 20)).toEqual({ cellFrame: 2, endFrame: 4, lastHolds: false })
    expect(cellRangeAtFrame(layer, 4, 20)).toEqual({ cellFrame: 2, endFrame: 4, lastHolds: false })
    // The last cell holds to the end of the authored timeline.
    expect(cellRangeAtFrame(layer, 5, 20)).toEqual({ cellFrame: 5, endFrame: 8, lastHolds: false })
    expect(cellRangeAtFrame(layer, 15, 20)).toEqual({ cellFrame: 9, endFrame: 19, lastHolds: true })
    expect(cellRangeAtFrame(layer, 19, 20)).toEqual({ cellFrame: 9, endFrame: 19, lastHolds: true })
  })

  it('cellRangeAtFrame handles a single cell holding to the end', () => {
    const layer = drawingLayer()
    layer.cells.push({ frame: 0, resourceId: 'res-a' })
    expect(cellRangeAtFrame(layer, 12, 8)).toEqual({ cellFrame: 0, endFrame: 7, lastHolds: true })
  })

  it('moveCell relocates a cell, and the moved cell wins over an occupied target', () => {
    const layer = drawingLayer()
    layer.cells.push(
      { frame: 1, resourceId: 'res-a' },
      { frame: 4, resourceId: 'res-b' },
      { frame: 7, resourceId: 'res-c' }
    )
    expect(moveCell(layer, 1, 5)).toBe(true)
    expect(layer.cells.map((cell) => cell.frame)).toEqual([4, 5, 7])
    expect(layer.cells.find((cell) => cell.frame === 5)?.resourceId).toBe('res-a')

    // Merging onto the occupied frame 7: the moved cell replaces the target.
    expect(moveCell(layer, 5, 7)).toBe(true)
    expect(layer.cells.map((cell) => cell.frame)).toEqual([4, 7])
    expect(layer.cells.find((cell) => cell.frame === 7)?.resourceId).toBe('res-a')
  })

  it('moveCell is a no-op for a missing source or an identical target', () => {
    const layer = drawingLayer()
    layer.cells.push({ frame: 2, resourceId: 'res-a' })
    expect(moveCell(layer, 0, 3)).toBe(false)
    expect(moveCell(layer, 2, 2)).toBe(false)
    expect(layer.cells.map((cell) => cell.frame)).toEqual([2])
  })

  it('setCellEnd moves the next cell right after the new end', () => {
    const layer = drawingLayer()
    layer.cells.push(
      { frame: 2, resourceId: 'res-a' },
      { frame: 6, resourceId: 'res-b' }
    )
    expect(setCellEnd(layer, 2, 8, 20)).toBe(true)
    expect(layer.cells.map((cell) => cell.frame)).toEqual([2, 9])

    // Shrinking below the start clamps to the cell's own frame.
    expect(setCellEnd(layer, 2, 1, 20)).toBe(true)
    expect(layer.cells.map((cell) => cell.frame)).toEqual([2, 3])

    // Unchanged end: no-op.
    expect(setCellEnd(layer, 2, 2, 20)).toBe(false)
    // No cell holds the frame: no-op.
    expect(setCellEnd(layer, 15, 18, 20)).toBe(false)
  })

  it('setCellEnd shortens the last cell with a blank cell after the new end', () => {
    const layer = drawingLayer()
    layer.cells.push({ frame: 2, resourceId: 'res-a' })
    // The last cell holds to the timeline end (19): shortening inserts a
    // blank cell at end + 1.
    expect(setCellEnd(layer, 2, 9, 20, 'res-blank')).toBe(true)
    expect(layer.cells).toEqual([
      { frame: 2, resourceId: 'res-a' },
      { frame: 10, resourceId: 'res-blank' }
    ])
    // Extending to the timeline end stays impossible; without a blank
    // resource the insertion is refused.
    const single = drawingLayer()
    single.cells.push({ frame: 0, resourceId: 'res-a' })
    expect(setCellEnd(single, 0, 9, 10)).toBe(false)
    expect(setCellEnd(single, 0, 5, 10)).toBe(false)
    expect(single.cells.map((cell) => cell.frame)).toEqual([0])
  })

  it('moveNodeKeyframes shifts every keyframe of the node and merges at the destination', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    insertKeyframe(layer, 2)
    addNodeToLayer(layer, 2, rect('a', 10, 0))
    addNodeToLayer(layer, 2, rect('b', 20, 0))
    // Keyframe 5 copies { a, b }: drop 'b' and add 'c' for a distinct pose.
    insertKeyframe(layer, 5)
    removeNodeFromLayer(layer, 5, 'b')
    addNodeToLayer(layer, 5, rect('c', 40, 0))

    // Shift the two 'a' entries by +2: 2 → 4, 5 → 7.
    expect(moveNodeKeyframes(layer, 'a', 2, 20)).toBe(true)
    const framesOf = (id: string): number[] =>
      layer.keyframes.filter((kf) => kf.nodes.some((node) => node.id === id)).map((kf) => kf.frame)
    expect(framesOf('a')).toEqual([4, 7])
    expect(framesOf('b')).toEqual([2])
    expect(framesOf('c')).toEqual([5])

    // Merging: move 'b' (frame 2) onto frame 4 where 'a' already sits.
    expect(moveNodeKeyframes(layer, 'b', 2, 20)).toBe(true)
    const merged = layer.keyframes.find((keyframe) => keyframe.frame === 4)!
    expect(merged.nodes.map((node) => node.id).sort()).toEqual(['a', 'b'])
  })

  it('moveNodeKeyframes clamps the shift so the whole span stays in the timeline', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    addNodeToLayer(layer, 0, rect('a', 0, 0))
    // Keyframe 5 copies 'a': the node spans frames 0..5.
    insertKeyframe(layer, 5)

    // Timeline of 10 frames (0..9): the span shifts right by 4 exactly onto
    // the timeline end.
    expect(moveNodeKeyframes(layer, 'a', 4, 10)).toBe(true)
    const framesOf = (): number[] =>
      layer.keyframes
        .filter((keyframe) => keyframe.nodes.some((node) => node.id === 'a'))
        .map((keyframe) => keyframe.frame)
    expect(framesOf()).toEqual([4, 9])
    // The span now touches the end: any further right shift is blocked.
    expect(moveNodeKeyframes(layer, 'a', 3, 10)).toBe(false)
    expect(framesOf()).toEqual([4, 9])
    // Moving left clamps to frame 0.
    expect(moveNodeKeyframes(layer, 'a', -99, 10)).toBe(true)
    expect(framesOf()).toEqual([0, 5])
  })

  it('moveNodeKeyframes drops keyframes emptied by the move and refuses unknown nodes', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    addNodeToLayer(layer, 0, rect('a', 0, 0))
    // The only keyframe holds exactly 'a': moving it away drops the keyframe.
    expect(moveNodeKeyframes(layer, 'a', 3, 10)).toBe(true)
    expect(layer.keyframes).toEqual([{ frame: 3, nodes: [expect.objectContaining({ id: 'a' })] }])

    expect(moveNodeKeyframes(layer, 'ghost', 1, 10)).toBe(false)
    expect(moveNodeKeyframes(layer, 'a', 0, 10)).toBe(false)
  })

  it('holdStepOf defaults to 1 (every frame) and passes explicit values through', () => {
    const doc = createDocument('test', 960, 540, 24)
    expect(holdStepOf(doc)).toBe(1)
    doc.holdStep = 3
    expect(holdStepOf(doc)).toBe(3)
  })
})

describe('keyframe entry moves', () => {
  it('moves one node entry to a target frame and replaces the same node there', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    // Frame 0: { a, b }; frame 4: { a, b }; frame 8: { c }.
    addNodeToLayer(layer, 0, rect('a', 0, 0))
    addNodeToLayer(layer, 0, rect('b', 0, 0))
    insertKeyframe(layer, 4)
    insertBlankKeyframe(layer, 8)
    addNodeToLayer(layer, 8, rect('c', 0, 0))

    // Move a@0 → 4: 'a' is replaced at 4 (other nodes untouched), 'b' stays at 0.
    expect(moveNodeKeyframeEntry(layer, 'a', 0, 4, 20)).toBe(true)
    const at = (frame: number): string[] | undefined =>
      layer.keyframes.find((keyframe) => keyframe.frame === frame)?.nodes.map((node) => node.id).sort()
    expect(at(0)).toEqual(['b'])
    expect(at(4)).toEqual(['a', 'b'])
    expect(at(8)).toEqual(['c'])
  })

  it('drops a keyframe emptied by the move together with its tween', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    addNodeToLayer(layer, 0, rect('a', 0, 0))
    setKeyframeTween(layer, 0, { easing: 'ease-in' })
    insertKeyframe(layer, 5)
    insertBlankKeyframe(layer, 10)
    addNodeToLayer(layer, 10, rect('b', 0, 0))
    setKeyframeTween(layer, 5, { easing: 'linear' })

    // 0 holds only 'a': moving it to 2 empties frame 0, tween dies with it.
    expect(moveNodeKeyframeEntry(layer, 'a', 0, 2, 20)).toBe(true)
    expect(layer.keyframes.map((keyframe) => keyframe.frame)).toEqual([2, 5, 10])
    expect(layer.keyframes.find((keyframe) => keyframe.frame === 2)?.tween).toBeUndefined()
    // The destination keyframe (5) keeps its own tween untouched.
    expect(layer.keyframes.find((keyframe) => keyframe.frame === 5)?.tween).toEqual({ easing: 'linear' })
  })

  it('applies several moves atomically with replace semantics', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    addNodeToLayer(layer, 0, rect('a', 0, 0))
    addNodeToLayer(layer, 0, rect('b', 0, 0))
    insertKeyframe(layer, 6)
    // Swap the two entries: a@0→6, b@6→0 — a chain that sequential single
    // moves could not perform without clobbering intermediate state.
    expect(
      moveKeyframeEntries(
        layer,
        [
          { nodeId: 'a', fromFrame: 0, toFrame: 6 },
          { nodeId: 'b', fromFrame: 6, toFrame: 0 }
        ],
        20
      )
    ).toBe(true)
    expect(layer.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 6])
    const at = (frame: number): string[] =>
      layer.keyframes.find((keyframe) => keyframe.frame === frame)!.nodes.map((node) => node.id).sort()
    expect(at(0)).toEqual(['b'])
    expect(at(6)).toEqual(['a'])
  })

  it('ignores no-ops, out-of-range targets and unknown sources without touching the layer', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    addNodeToLayer(layer, 0, rect('a', 0, 0))
    insertKeyframe(layer, 3)
    const snapshot = JSON.stringify(layer.keyframes)

    expect(moveNodeKeyframeEntry(layer, 'a', 0, 0, 10)).toBe(false)
    expect(moveNodeKeyframeEntry(layer, 'a', 0, 10, 10)).toBe(false)
    expect(moveNodeKeyframeEntry(layer, 'a', 0, -1, 10)).toBe(false)
    expect(moveNodeKeyframeEntry(layer, 'ghost', 0, 2, 10)).toBe(false)
    expect(moveNodeKeyframeEntry(layer, 'a', 7, 2, 10)).toBe(false)
    expect(JSON.stringify(layer.keyframes)).toBe(snapshot)

    // A batch with only ineffective moves changes nothing either.
    expect(
      moveKeyframeEntries(
        layer,
        [
          { nodeId: 'a', fromFrame: 0, toFrame: 0 },
          { nodeId: 'ghost', fromFrame: 3, toFrame: 4 }
        ],
        10
      )
    ).toBe(false)
    expect(JSON.stringify(layer.keyframes)).toBe(snapshot)
  })
})

describe('keyframe chunks (clipboard)', () => {
  function chunkLayer(): ObjectLayer {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    addNodeToLayer(layer, 0, rect('a', 0, 0))
    addNodeToLayer(layer, 0, rect('b', 0, 0))
    setKeyframeTween(layer, 0, { easing: 'ease-out' })
    insertKeyframe(layer, 4)
    removeNodeFromLayer(layer, 4, 'b')
    return layer
  }

  it('extracts entries at frame offsets and carries the tween exactly once', () => {
    const chunk = extractKeyframeChunk(chunkLayer(), 0, 4)
    expect(chunk.map((entry) => [entry.nodeId, entry.offset])).toEqual([
      ['a', 0],
      ['b', 0],
      ['a', 4]
    ])
    // The tween of keyframe 0 rides its first entry only.
    expect(chunk[0].tween).toEqual({ easing: 'ease-out' })
    expect(chunk[1].tween).toBeUndefined()
    expect(chunk[2].tween).toBeUndefined()
    // Entries hold clones, detached from the layer.
    expect(chunk[2].node).not.toBe(chunk[0].node)

    // A node filter keeps only that node's entries.
    const onlyB = extractKeyframeChunk(chunkLayer(), 0, 4, ['b'])
    expect(onlyB.map((entry) => [entry.nodeId, entry.offset])).toEqual([['b', 0]])
    // An empty range extracts nothing.
    expect(extractKeyframeChunk(chunkLayer(), 9, 12)).toEqual([])
  })

  it('applies a chunk at a target frame, creating and merging keyframes', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    insertBlankKeyframe(layer, 10)
    addNodeToLayer(layer, 10, rect('c', 0, 0))
    const chunk = extractKeyframeChunk(chunkLayer(), 0, 4)

    expect(applyKeyframeChunk(layer, chunk, 10, 30)).toBe(true)
    const at = (frame: number): string[] | undefined =>
      layer.keyframes.find((keyframe) => keyframe.frame === frame)?.nodes.map((node) => node.id).sort()
    // Target 10 already held 'c': the pasted 'a'/'b' join it.
    expect(at(10)).toEqual(['a', 'b', 'c'])
    expect(at(14)).toEqual(['a'])
    // The source tween restores onto the merged keyframe at 10.
    expect(layer.keyframes.find((keyframe) => keyframe.frame === 10)?.tween).toEqual({ easing: 'ease-out' })
  })

  it('never clobbers an existing tween and skips out-of-range entries', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    insertBlankKeyframe(layer, 20)
    addNodeToLayer(layer, 20, rect('z', 0, 0))
    setKeyframeTween(layer, 20, { easing: 'linear' })
    const chunk = extractKeyframeChunk(chunkLayer(), 0, 4)

    // Target 19 + offsets 0/4: frames 19, 19, 23 all land inside a 24-frame
    // timeline.
    expect(applyKeyframeChunk(layer, chunk, 19, 24)).toBe(true)
    expect(layer.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 19, 20, 23])
    expect(layer.keyframes.find((keyframe) => keyframe.frame === 23)?.nodes.map((node) => node.id)).toEqual(['a'])

    // Pasting the offset-0 'a' entry onto 20 merges with 'z'; the existing
    // tween stays.
    expect(applyKeyframeChunk(layer, [chunk[0]], 20, 24)).toBe(true)
    expect(layer.keyframes.find((keyframe) => keyframe.frame === 20)?.tween).toEqual({ easing: 'linear' })
    expect(layer.keyframes.find((keyframe) => keyframe.frame === 20)?.nodes.map((node) => node.id).sort()).toEqual(['a', 'z'])
  })

  it('skips every out-of-range entry and reports no change', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = firstLayer(doc)
    const chunk = extractKeyframeChunk(chunkLayer(), 0, 4)
    expect(applyKeyframeChunk(layer, chunk, -5, 10)).toBe(false)
    expect(applyKeyframeChunk(layer, chunk, 99, 10)).toBe(false)
    expect(applyKeyframeChunk(layer, [], 0, 10)).toBe(false)
    expect(layer.keyframes).toHaveLength(1)
    expect(layer.keyframes[0]).toEqual({ frame: 0, nodes: [] })
  })
})

describe('drawing frame ops and layer validation', () => {
  it('insertFrame shifts cells later and removeFrame shifts them back', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = createDrawingLayer('Draw')
    doc.layers.push(layer)
    layer.cells.push({ frame: 2, resourceId: 'res-a' }, { frame: 4, resourceId: 'res-b' })

    insertFrame(doc, layer.id, 1)
    expect(layer.cells.map((cell) => cell.frame)).toEqual([3, 5])

    removeFrame(doc, 1)
    expect(layer.cells.map((cell) => cell.frame)).toEqual([2, 4])

    removeFrame(doc, 0)
    expect(layer.cells.map((cell) => cell.frame)).toEqual([1, 3])
    expect(documentDuration(doc)).toBe(4)
  })

  it('removeFrame never removes the only cell of a drawing layer', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = createDrawingLayer('Draw')
    doc.layers.push(layer)
    layer.cells.push({ frame: 0, resourceId: 'res-a' })
    removeFrame(doc, 0)
    expect(layer.cells.map((cell) => cell.frame)).toEqual([0])
  })

  it('documentDuration counts drawing cell frames', () => {
    const doc = createDocument('test', 960, 540, 24)
    const layer = createDrawingLayer('Draw')
    doc.layers.push(layer)
    expect(documentDuration(doc)).toBe(1)
    layer.cells.push({ frame: 11, resourceId: 'res-a' })
    expect(documentDuration(doc)).toBe(12)
  })

  it('addLayer creates object and drawing layers', () => {
    const doc = createDocument('test', 960, 540, 24)
    const drawing = addLayer(doc, 'Draw', 'bottom', 'drawing')
    expect(drawing.kind).toBe('drawing')
    expect(drawing.cells).toEqual([])
    expect(drawing.resolutionScale).toBe(1)
    const object = addLayer(doc, 'Top')
    expect(object.kind).toBe('object')
    expect(object.keyframes).toEqual([{ frame: 0, nodes: [] }])
  })

  it('isAnimatorDocument validates drawing layers deeply', () => {
    const valid = createDocument('test', 960, 540, 24)
    valid.layers.push(createDrawingLayer('Draw'))
    expect(isAnimatorDocument(valid)).toBe(true)

    const unknownKind = cloneDocument(valid)
    ;(unknownKind.layers[1] as unknown as Record<string, unknown>).kind = 'vector'
    expect(isAnimatorDocument(unknownKind)).toBe(false)

    const badScale = cloneDocument(valid)
    ;(badScale.layers[1] as unknown as { resolutionScale: number }).resolutionScale = 0
    expect(isAnimatorDocument(badScale)).toBe(false)

    const badCell = cloneDocument(valid)
    ;(badCell.layers[1] as unknown as { cells: unknown[] }).cells = [
      { frame: -1, resourceId: 'r' }
    ]
    expect(isAnimatorDocument(badCell)).toBe(false)

    const junkCell = cloneDocument(valid)
    ;(junkCell.layers[1] as unknown as { cells: unknown[] }).cells = [{ frame: 0 }]
    expect(isAnimatorDocument(junkCell)).toBe(false)
  })
})
