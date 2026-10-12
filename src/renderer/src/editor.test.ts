import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createDocument,
  createDrawingLayer,
  evaluateLayerAtFrame,
  getLayer,
  resolveCellAtFrame
} from '@shared/document'
import type { Asset, AudioLayer, DrawingLayer, GroupNode, ImageNode, ObjectLayer, PrimitiveNode, SceneNode, SymbolNode } from '@shared/model'

import { Editor } from './editor'
import type { EditorDeps } from './editor'

function rect(id: string): PrimitiveNode {
  return {
    id,
    type: 'primitive',
    primitive: 'rect',
    center: { x: 0, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1
  }
}

describe('Editor timeline operations', () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor(createDocument('test', 960, 540, 24))
  })

  it('removeNodeKeyframe deletes the object keyframe and drops it when empty', () => {
    editor.addNode(rect('a'))
    const layerId = editor.currentLayerId
    editor.insertFrameHere()
    editor.setFrame(1)
    editor.ensureNodeKeyframe('a')
    expect(editor.hasNodeKeyframeAt(layerId, 'a', 1)).toBe(true)

    expect(editor.removeNodeKeyframe('a')).toBe(true)
    expect(editor.hasNodeKeyframeAt(layerId, 'a', 1)).toBe(false)
    const layer = getLayer(editor.document, layerId)!
    expect(layer.keyframes.some((keyframe) => keyframe.frame === 1)).toBe(false)
    // The earlier keyframe is untouched: the object still holds through frame 0.
    expect(editor.hasNodeKeyframeAt(layerId, 'a', 0)).toBe(true)
    // Without its own keyframe at the current frame, removal is a no-op.
    expect(editor.removeNodeKeyframe('a')).toBe(false)
    expect(editor.hasNodeKeyframeAt(layerId, 'a', 0)).toBe(true)
  })

  it('deleteNode removes the object from every keyframe and clears the selection', () => {
    editor.addNode(rect('a'))
    const layerId = editor.currentLayerId
    editor.insertFrameHere()
    editor.setFrame(1)
    editor.ensureNodeKeyframe('a')
    editor.selectNodes(['a'], 'replace')

    editor.deleteNode(layerId, 'a')
    const layer = getLayer(editor.document, layerId)!
    // Every keyframe was emptied by the removal and therefore dropped.
    expect(layer.keyframes).toHaveLength(0)
    expect(editor.selectedNodeIds).toEqual([])
  })

  it('renameNode stores the name in every keyframe', () => {
    editor.addNode(rect('a'))
    const layerId = editor.currentLayerId
    editor.renameNode(layerId, 'a', 'Hero')
    const layer = getLayer(editor.document, layerId)!
    expect(layer.keyframes[0].nodes[0].name).toBe('Hero')
  })

  it('removeFrameHere shrinks the timeline and clamps the playhead', () => {
    editor.insertFrameHere()
    editor.setFrame(1)
    expect(editor.duration).toBe(2)

    expect(editor.removeFrameHere()).toBe(true)
    expect(editor.duration).toBe(1)
    expect(editor.currentFrame).toBe(0)
    expect(editor.removeFrameHere()).toBe(true)
    expect(editor.duration).toBe(1)
  })

  it('layer operations: add at the bottom, move, rename, remove', () => {
    const firstId = editor.currentLayerId
    editor.addLayerAtBottom()
    expect(editor.document.layers).toHaveLength(2)
    const secondId = editor.currentLayerId
    expect(editor.document.layers[1].id).toBe(secondId)

    editor.moveLayer(secondId, 0)
    expect(editor.document.layers[0].id).toBe(secondId)

    editor.renameLayer(secondId, 'Foreground')
    expect(getLayer(editor.document, secondId)?.name).toBe('Foreground')

    editor.removeLayer(secondId)
    expect(editor.document.layers).toHaveLength(1)
    expect(editor.currentLayerId).toBe(firstId)

    // The last remaining layer is never removed.
    editor.removeLayer(firstId)
    expect(editor.document.layers).toHaveLength(1)
  })

  it('ensureNodeKeyframe keys only the targeted object', () => {
    editor.addNode(rect('a'))
    editor.addNode(rect('b'))
    const layerId = editor.currentLayerId
    editor.insertFrameHere()
    editor.setFrame(1)

    expect(editor.ensureNodeKeyframe('a')).toBe(true)
    expect(editor.hasNodeKeyframeAt(layerId, 'a', 1)).toBe(true)
    expect(editor.hasNodeKeyframeAt(layerId, 'b', 1)).toBe(false)
    const layer = getLayer(editor.document, layerId)!
    const keyed = layer.keyframes.find((keyframe) => keyframe.frame === 1)!
    expect(keyed.nodes.map((node) => node.id)).toEqual(['a'])
    // b has no keyframe at frame 1, so its span ends at frame 0: only `a`
    // is on stage here.
    const content = evaluateLayerAtFrame(layer, 1)
    expect(content.map((shape) => shape.id)).toEqual(['a'])
  })

  it('seekToFrame clamps to the timeline instead of mutating the document', () => {
    editor.addNode(rect('a'))
    expect(editor.duration).toBe(1)

    // A click past the end never extends the document nor pushes history:
    // check against a fresh editor so the addNode history entry stays out of
    // the assertion.
    const fresh = new Editor(createDocument('seek', 320, 180, 12))
    fresh.seekToFrame(5)
    expect(fresh.currentFrame).toBe(0)
    expect(fresh.duration).toBe(1)
    expect(fresh.canUndo).toBe(false)

    // Extending the timeline stays an explicit edit (+ Frame / F5), after
    // which keyframes can land past the last content frame.
    editor.insertFrameHere()
    editor.seekToFrame(1)
    expect(editor.currentFrame).toBe(1)
    expect(editor.duration).toBe(2)
    expect(editor.ensureNodeKeyframe('a')).toBe(true)
    expect(editor.hasNodeKeyframeAt(editor.currentLayerId, 'a', 1)).toBe(true)
  })

  it('view listeners are fault-isolated: one throwing view never starves the others', () => {
    let failures = 0
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      failures += 1
    })
    try {
      let called = 0
      editor.onDocChange(() => {
        throw new Error('boom')
      })
      editor.onDocChange(() => {
        called += 1
      })
      editor.addNode(rect('a'))
      expect(called).toBe(1)
      expect(failures).toBeGreaterThan(0)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('removeLayer auto-switches the tool off a drawing layer', () => {
    editor.addLayerAtBottom('drawing')
    const drawingLayerId = editor.currentLayerId
    expect(editor.tool).toBe('brush')

    editor.removeLayer(drawingLayerId)
    expect(editor.currentLayer?.kind).toBe('object')
    expect(editor.tool).toBe('select')
  })

  it('insertKeyframeHere and removeKeyframeHere act on the selected object', () => {
    editor.addNode(rect('a'))
    editor.addNode(rect('b'))
    const layerId = editor.currentLayerId
    editor.insertFrameHere()
    editor.setFrame(1)

    editor.selectNodes(['a'], 'replace')
    expect(editor.insertKeyframeHere()).toBe(true)
    expect(editor.hasNodeKeyframeAt(layerId, 'a', 1)).toBe(true)
    expect(editor.hasNodeKeyframeAt(layerId, 'b', 1)).toBe(false)

    expect(editor.removeKeyframeHere()).toBe(true)
    expect(editor.hasNodeKeyframeAt(layerId, 'a', 1)).toBe(false)

    // Without a selection both actions are no-ops.
    editor.selectNodes([], 'replace')
    expect(editor.insertKeyframeHere()).toBe(false)
    expect(editor.removeKeyframeHere()).toBe(false)
  })
})

describe('Editor multi-select', () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor(createDocument('test', 960, 540, 24))
  })

  function rectAt(id: string, x: number, y: number): PrimitiveNode {
    return {
      id,
      type: 'primitive',
      primitive: 'rect',
      center: { x, y },
      width: 10,
      height: 10,
      rotation: 0,
      fill: '#ff0000',
      opacity: 1
    }
  }

  function contentIds(): string[] {
    const layer = getLayer(editor.document, editor.currentLayerId)!
    return evaluateLayerAtFrame(layer, editor.currentFrame).map((node) => node.id)
  }

  it('selectNodes replaces, adds and toggles membership', () => {
    editor.addNode(rectAt('a', 0, 0))
    editor.addNode(rectAt('b', 100, 0))
    editor.addNode(rectAt('c', 200, 0))

    editor.selectNodes(['a'], 'replace')
    expect(editor.selectedNodeIds).toEqual(['a'])
    expect(editor.primarySelectedNodeId).toBe('a')

    editor.selectNodes(['b'], 'add')
    expect(editor.selectedNodeIds).toEqual(['a', 'b'])
    expect(editor.primarySelectedNodeId).toBe('b')

    editor.selectNodes(['a'], 'toggle')
    expect(editor.selectedNodeIds).toEqual(['b'])

    // Neither 'a' nor 'c' is selected, so both get added.
    editor.selectNodes(['a', 'c'], 'toggle')
    expect([...editor.selectedNodeIds].sort()).toEqual(['a', 'b', 'c'])

    editor.selectNodes(['b', 'c'], 'replace')
    expect(editor.selectedNodeIds).toEqual(['b', 'c'])
  })

  it('updateSelectedNodes moves the whole selection and auto-keys each shape', () => {
    editor.addNode(rectAt('a', 0, 0))
    editor.addNode(rectAt('b', 100, 0))
    editor.addNode(rectAt('c', 200, 0))
    const layerId = editor.currentLayerId
    editor.selectNodes(['a', 'c'], 'replace')

    // Extend the timeline explicitly, then move the playhead to frame 3.
    while (editor.duration <= 3) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    editor.seekToFrame(3)
    editor.updateSelectedNodes((node) => {
      node.center.x += 50
    })

    expect(editor.hasNodeKeyframeAt(layerId, 'a', 3)).toBe(true)
    expect(editor.hasNodeKeyframeAt(layerId, 'b', 3)).toBe(false)
    expect(editor.hasNodeKeyframeAt(layerId, 'c', 3)).toBe(true)
    const layer = getLayer(editor.document, layerId)!
    const content = evaluateLayerAtFrame(layer, 3)
    expect(content.find((node) => node.id === 'a')?.center.x).toBe(50)
    expect(content.find((node) => node.id === 'c')?.center.x).toBe(250)
    // Only the two selected nodes received the keyframe at frame 3.
    expect(layer.keyframes.find((keyframe) => keyframe.frame === 3)!.nodes).toHaveLength(2)
  })

  it('nudgeSelected and deleteSelected operate on the whole selection', () => {
    editor.addNode(rectAt('a', 0, 0))
    editor.addNode(rectAt('b', 100, 0))
    editor.addNode(rectAt('c', 200, 0))
    editor.selectNodes(['a', 'b'], 'replace')

    editor.nudgeSelected(10, 5)
    const layer = getLayer(editor.document, editor.currentLayerId)!
    const content = evaluateLayerAtFrame(layer, 0)
    expect(content.find((node) => node.id === 'a')?.center).toEqual({ x: 10, y: 5 })
    expect(content.find((node) => node.id === 'b')?.center).toEqual({ x: 110, y: 5 })
    expect(content.find((node) => node.id === 'c')?.center).toEqual({ x: 200, y: 0 })

    editor.deleteSelected()
    expect(contentIds()).toEqual(['c'])
    expect(editor.selectedNodeIds).toEqual([])
  })

  it('insertKeyframeHere keys every selected shape', () => {
    editor.addNode(rectAt('a', 0, 0))
    editor.addNode(rectAt('b', 100, 0))
    const layerId = editor.currentLayerId
    editor.insertFrameHere()
    editor.setFrame(1)
    editor.selectNodes(['a', 'b'], 'replace')

    expect(editor.insertKeyframeHere()).toBe(true)
    expect(editor.hasNodeKeyframeAt(layerId, 'a', 1)).toBe(true)
    expect(editor.hasNodeKeyframeAt(layerId, 'b', 1)).toBe(true)
  })

  it('getSelectionBounds returns the union of the selected shape bounds', () => {
    editor.addNode(rectAt('a', 10, 20))
    editor.addNode(rectAt('b', 100, 80))
    editor.selectNodes(['a'], 'replace')
    expect(editor.getSelectionBounds()).toEqual({ x: 5, y: 15, width: 10, height: 10 })

    editor.selectNodes(['b'], 'add')
    expect(editor.getSelectionBounds()).toEqual({ x: 5, y: 15, width: 100, height: 70 })

    editor.selectNodes([], 'replace')
    expect(editor.getSelectionBounds()).toBeNull()
  })
})

function symbolAsset(id: string, name: string, children: SceneNode[]): Asset {
  return {
    id,
    name,
    kind: 'symbol',
    content: {
      type: 'group',
      id: 'content',
      center: { x: 0, y: 0 },
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1,
      children
    },
    createdAt: 1
  }
}

function imageAsset(id: string, resourceId: string): Asset {
  return { id, name: id, kind: 'image', resourceId, naturalWidth: 640, naturalHeight: 480, createdAt: 1 }
}

describe('Editor — asset library and symbols', () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor(createDocument('test', 960, 540, 24))
  })

  function nodesIn(layerId = editor.currentLayerId): SceneNode[] {
    return getLayer(editor.document, layerId)!.keyframes[0].nodes
  }

  it('saveSelectionAsSymbol replaces the selection with one instance (one undo step)', () => {
    editor.addNode(rect('a', 10, 0))
    editor.addNode(rect('b', 110, 0))
    editor.selectNodes(['a', 'b'], 'replace')

    expect(editor.saveSelectionAsSymbol()).toBe(true)
    expect(editor.document.assets).toHaveLength(1)
    const asset = editor.document.assets[0]
    expect(asset.kind).toBe('symbol')
    expect(asset.name).toBe('Symbol 1')

    const keyframeNodes = nodesIn()
    expect(keyframeNodes).toHaveLength(1)
    const instance = keyframeNodes[0] as SymbolNode
    expect(instance.type).toBe('symbol')
    expect(instance.assetId).toBe(asset.id)
    expect(instance.width).toBe(asset.content!.width)
    expect(instance.height).toBe(asset.content!.height)
    expect(editor.selectedNodeIds).toEqual([instance.id])

    editor.undo()
    expect(editor.document.assets).toHaveLength(0)
    expect(nodesIn().map((node) => node.id)).toEqual(['a', 'b'])
    editor.redo()
    expect(editor.document.assets).toHaveLength(1)
    expect(nodesIn()[0].type).toBe('symbol')
  })

  it('saveSelectionAsSymbol numbers successive symbols and rejects an empty selection', () => {
    editor.addNode(rect('a', 0))
    editor.selectNodes(['a'], 'replace')
    expect(editor.saveSelectionAsSymbol()).toBe(true)
    editor.addNode(rect('b', 100))
    editor.selectNodes(['b'], 'replace')
    expect(editor.saveSelectionAsSymbol()).toBe(true)
    expect(editor.document.assets.map((asset) => asset.name)).toEqual(['Symbol 1', 'Symbol 2'])

    editor.selectNodes([], 'replace')
    expect(editor.saveSelectionAsSymbol()).toBe(false)
    expect(editor.document.assets).toHaveLength(2)
  })

  it('placeAsset places symbol instances at the natural content size', () => {
    const asset = symbolAsset('s', 'Rocket', [
      { id: 'c1', type: 'primitive', primitive: 'rect', center: { x: 0, y: 0 }, width: 100, height: 50, rotation: 0, fill: '#ff0000', opacity: 1 }
    ])
    editor.document.assets = [asset]

    expect(editor.placeAsset('s')).toBe(true)
    const instance = nodesIn()[0] as SymbolNode
    expect(instance.type).toBe('symbol')
    expect(instance.assetId).toBe('s')
    expect(instance.center).toEqual({ x: 480, y: 270 })
    expect(instance.width).toBe(100)
    expect(instance.height).toBe(50)
    expect(editor.selectedNodeIds).toEqual([instance.id])

    expect(editor.placeAsset('gone')).toBe(false)
  })

  it('placeAsset places image assets as image nodes', () => {
    editor.document.assets = [imageAsset('img', 'hash-a')]
    expect(editor.placeAsset('img', { x: 100, y: 60 })).toBe(true)
    const node = nodesIn()[0] as ImageNode
    expect(node.type).toBe('image')
    expect(node.resourceId).toBe('hash-a')
    expect(node.center).toEqual({ x: 100, y: 60 })
    expect(node.naturalWidth).toBe(640)
  })

  it('breakApartSelection decouples instances into editable groups', () => {
    const asset = symbolAsset('s', 'Rocket', [
      { id: 'c1', type: 'primitive', primitive: 'rect', center: { x: 0, y: 0 }, width: 100, height: 50, rotation: 0, fill: '#ff0000', opacity: 1 }
    ])
    editor.document.assets = [asset]
    editor.placeAsset('s')
    const instance = nodesIn()[0] as SymbolNode
    editor.selectNodes([instance.id], 'replace')

    expect(editor.breakApartSelection()).toBe(true)
    const group = nodesIn()[0] as GroupNode
    expect(group.type).toBe('group')
    expect(group.center).toEqual(instance.center)
    expect(group.width).toBe(instance.width)
    expect(group.children[0].id).toBe('c1')
    expect(editor.selectedNodeIds).toEqual([group.id])
    // The asset itself stays; the content is a copy, not shared.
    expect(editor.document.assets).toHaveLength(1)
    expect(group.children[0]).not.toBe(asset.content!.children[0])

    editor.undo()
    expect(nodesIn()[0].type).toBe('symbol')
  })

  it('breakApartSelection is a no-op without a selected symbol', () => {
    editor.addNode(rect('a', 0))
    editor.selectNodes(['a'], 'replace')
    expect(editor.breakApartSelection()).toBe(false)
    expect(nodesIn()[0].type).toBe('primitive')
  })

  it('deleteAsset reports how many instances were on stage', () => {
    const asset = symbolAsset('s', 'Rocket', [])
    editor.document.assets = [asset]
    editor.placeAsset('s')
    editor.placeAsset('s')
    expect(editor.countAssetInstances('s')).toBe(2)
    expect(editor.deleteAsset('s')).toBe(2)
    expect(editor.document.assets).toHaveLength(0)
    // The instances stay (as placeholders) until removed manually.
    expect(nodesIn()).toHaveLength(2)
    expect(editor.deleteAsset('s')).toBe(0)
  })

  it('registers, renames and duplicates assets', () => {
    const id = editor.registerImageAsset('hash-a', { width: 640, height: 480 }, 'photo.png')
    expect(editor.document.assets).toHaveLength(1)
    expect(editor.document.assets[0].kind).toBe('image')
    expect(editor.document.assets[0].resourceId).toBe('hash-a')

    editor.renameAsset(id, 'Hero image')
    expect(editor.document.assets[0].name).toBe('Hero image')

    const copyId = editor.duplicateAsset(id)
    expect(copyId).not.toBe(id)
    expect(editor.document.assets[1].name).toBe('Hero image copy')
    expect(editor.document.assets).toHaveLength(2)
    expect(editor.duplicateAsset('gone')).toBeNull()

    editor.undo()
    expect(editor.document.assets).toHaveLength(1)
  })

  it('importAndPlaceAsset registers asset + resources in one undo step', () => {
    const asset = imageAsset('ext-1', 'hash-a')
    const bytes = new Uint8Array([1, 2, 3])
    editor.beginInteraction()
    const placed = editor.importAndPlaceAsset(asset, { 'hash-a': bytes }, { x: 40, y: 40 })
    editor.endInteraction()
    expect(placed).toBe(true)
    expect(editor.document.assets.map((entry) => entry.id)).toEqual(['ext-1'])
    expect(editor.resources.getUrl('hash-a')).not.toBeNull()
    expect((nodesIn()[0] as ImageNode).center).toEqual({ x: 40, y: 40 })

    editor.undo()
    expect(editor.document.assets).toHaveLength(0)
    expect(nodesIn()).toHaveLength(0)
    // Already-known assets are not re-registered (and survive a failed place).
    editor.document.assets = [asset]
    editor.beginInteraction()
    expect(editor.importAndPlaceAsset(asset, { 'hash-a': bytes })).toBe(true)
    editor.endInteraction()
    expect(editor.document.assets).toHaveLength(1)
    expect(nodesIn()).toHaveLength(1)
  })

  it('importAndPlaceAsset rolls back the asset when placement fails', () => {
    editor.document.layers[0].locked = true
    const asset = imageAsset('ext-1', 'hash-a')
    expect(editor.importAndPlaceAsset(asset, { 'hash-a': new Uint8Array([1]) })).toBe(false)
    expect(editor.document.assets).toHaveLength(0)
    expect(editor.canUndo).toBe(false)
  })
})

describe('Editor — symbol edit mode', () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor(createDocument('test', 960, 540, 24))
  })

  function rectAt(id: string, x: number, y = 0): PrimitiveNode {
    return {
      id,
      type: 'primitive',
      primitive: 'rect',
      center: { x, y },
      width: 100,
      height: 50,
      rotation: 0,
      fill: '#ff0000',
      opacity: 1
    }
  }

  function childAt(editor: Editor, index: number): PrimitiveNode {
    const asset = editor.document.assets[0]
    return asset.content!.children[index] as PrimitiveNode
  }

  it('edits the asset in isolation and commits to every instance', () => {
    editor.document.assets = [
      symbolAsset('s', 'Rocket', [
        { id: 'c1', type: 'primitive', primitive: 'rect', center: { x: 0, y: 0 }, width: 100, height: 50, rotation: 0, fill: '#ff0000', opacity: 1 }
      ])
    ]
    editor.placeAsset('s')

    expect(editor.beginSymbolEdit('s')).toBe(true)
    expect(editor.editingAssetId).toBe('s')
    // The scratch document holds clones of the content children.
    const scratchNodes = editor.document.layers[0].keyframes[0].nodes
    expect(scratchNodes.map((node) => node.id)).toEqual(['c1'])
    expect(editor.canUndo).toBe(false)

    editor.addNode(rectAt('c2', 200))
    editor.endSymbolEdit(true)

    expect(editor.editingAssetId).toBeNull()
    expect(editor.document.layers[0].keyframes[0].nodes[0].type).toBe('symbol')
    const content = editor.document.assets[0].content!
    expect(content.children.map((node) => node.id)).toEqual(['c1', 'c2'])
    expect(content.width).toBeGreaterThan(100)
    // One undo step reverts the whole commit.
    editor.undo()
    expect(editor.document.assets[0].content!.children.map((node) => node.id)).toEqual(['c1'])
    editor.redo()
    expect(editor.document.assets[0].content!.children.map((node) => node.id)).toEqual(['c1', 'c2'])

    // A second edit session works from the updated content.
    expect(editor.beginSymbolEdit('s')).toBe(true)
    expect(editor.document.layers[0].keyframes[0].nodes.map((node) => node.id)).toEqual(['c1', 'c2'])
    editor.endSymbolEdit(false)
    expect(editor.document.assets[0].content!.children.map((node) => node.id)).toEqual(['c1', 'c2'])
  })

  it('refuses to start while already editing and ignores end without editing', () => {
    editor.document.assets = [symbolAsset('s', 'Rocket', [])]
    expect(editor.beginSymbolEdit('gone')).toBe(false)
    expect(editor.beginSymbolEdit('s')).toBe(true)
    expect(editor.beginSymbolEdit('s')).toBe(false)
    editor.endSymbolEdit(false)
    editor.endSymbolEdit(false) // no-op, no editing session
    expect(editor.editingAssetId).toBeNull()
  })

  it('blocks asset-less edits and validates the asset graph on load', () => {
    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))
    expect(editor.beginSymbolEdit('nothing')).toBe(false)

    // A cyclic asset graph still loads, but the status bar explains it.
    const cyclic = symbolAsset('cyclic', 'Loop', [])
    ;(cyclic.content!.children as SceneNode[]).push({
      id: 'self',
      type: 'symbol',
      assetId: 'cyclic',
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1
    })
    editor.document.assets = [cyclic]
    editor.setDocument(editor.document)
    expect(messages.some((message) => message.includes('cycle'))).toBe(true)
  })

  it('childAt edits land in content-local coordinates', () => {
    editor.document.assets = [
      symbolAsset('s', 'Rocket', [
        { id: 'c1', type: 'primitive', primitive: 'rect', center: { x: 10, y: 20 }, width: 100, height: 50, rotation: 0, fill: '#ff0000', opacity: 1 }
      ])
    ]
    expect(childAt(editor, 0).center).toEqual({ x: 10, y: 20 })
  })
})


describe('drawing layers and paint tools', () => {
  const transparentBytes = new Uint8Array([0, 0, 0, 0])

  function drawingEditor(deps: EditorDeps = {}): { editor: Editor; layer: DrawingLayer } {
    const doc = createDocument('test', 960, 540, 24)
    const layer = createDrawingLayer('Draw')
    doc.layers.unshift(layer)
    const editor = new Editor(doc, deps)
    editor.currentLayerId = layer.id
    return { editor, layer }
  }

  /** The live drawing layer of the editor's current document (undo/redo
   * replace the document object, so captured aliases go stale). */
  function liveLayer(editor: Editor, id: string): DrawingLayer {
    const layer = getLayer(editor.document, id)
    if (!layer || layer.kind !== 'drawing') throw new Error('drawing layer vanished')
    return layer
  }

  /** Grows the authored timeline up to `frame` through the explicit + Frame
   * edit (seeking alone no longer extends the document). */
  function extendTimelineTo(editor: Editor, frame: number): void {
    while (editor.duration <= frame) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
  }

  /** Cell-op editor whose transparent buffers and stores are fully fake. */
  function seededEditor(storeLog: Uint8Array[] = []): { editor: Editor; layer: DrawingLayer } {
    let next = 0
    return drawingEditor({
      createTransparentPng: async (width, height) => {
        expect(width).toBe(960)
        expect(height).toBe(540)
        return transparentBytes
      },
      storeResource: async (bytes) => {
        storeLog.push(bytes)
        next += 1
        return `res-${next}`
      }
    })
  }

  it('restricts tools per layer kind and auto-switches on layer switches', () => {
    const { editor } = drawingEditor()
    const objectId = editor.document.layers[1].id
    // Drawing layer: brush/eraser/hand only; incompatible requests are ignored.
    expect(editor.tool).toBe('brush')
    editor.setTool('eraser')
    expect(editor.tool).toBe('eraser')
    editor.setTool('select')
    expect(editor.tool).toBe('eraser')
    editor.setTool('rect')
    expect(editor.tool).toBe('eraser')
    // Hand is compatible with both kinds.
    editor.setTool('hand')
    expect(editor.tool).toBe('hand')

    // Switching back to the object layer keeps Hand (compatible everywhere)...
    editor.setCurrentLayer(objectId)
    expect(editor.tool).toBe('hand')
    // ...and an incompatible eraser request is ignored, not auto-switched.
    editor.setTool('eraser')
    expect(editor.tool).toBe('hand')

    // On the object layer, select/rect work again and the brush is refused.
    editor.setTool('select')
    expect(editor.tool).toBe('select')
    editor.setTool('rect')
    expect(editor.tool).toBe('rect')
    // The vector brush commits PathNodes, so it is an object-layer tool.
    editor.setTool('vector')
    expect(editor.tool).toBe('vector')
    editor.setTool('brush')
    expect(editor.tool).toBe('vector')
  })

  it('auto-switches the tool when the document changes under it', () => {
    const { editor, layer } = drawingEditor()
    expect(editor.tool).toBe('brush')
    // e.g. an undo of the drawing layer's creation: the brush cannot stay.
    editor.document.layers = editor.document.layers.filter((entry) => entry.id !== layer.id)
    editor.setDocument(editor.document)
    expect(editor.tool).toBe('select')
  })

  it('commits a stroke with auto-cell and a single undo step', () => {
    const { editor, layer } = drawingEditor()
    editor.seekToFrame(5)
    expect(editor.commitStroke('paint-1', 5)).toBe(true)
    expect(liveLayer(editor, layer.id).cells).toEqual([{ frame: 5, resourceId: 'paint-1' }])
    expect(editor.duration).toBe(6)

    editor.undo()
    expect(liveLayer(editor, layer.id).cells).toHaveLength(0)
    editor.redo()
    expect(liveLayer(editor, layer.id).cells).toEqual([{ frame: 5, resourceId: 'paint-1' }])

    // Painting again at the same frame replaces the cell content, still as
    // its own undo step.
    editor.commitStroke('paint-2', 5)
    editor.undo()
    expect(liveLayer(editor, layer.id).cells).toEqual([{ frame: 5, resourceId: 'paint-1' }])
  })

  it('refuses to commit strokes on other layer kinds or locked layers', () => {
    const doc = createDocument('test', 960, 540, 24)
    const editor = new Editor(doc)
    expect(editor.commitStroke('paint-1')).toBe(false)

    const locked = drawingEditor()
    locked.layer.locked = true
    expect(locked.editor.commitStroke('paint-1')).toBe(false)
  })

  it('insertCellHere duplicates the previous cell or seeds a transparent one', async () => {
    const { editor, layer } = seededEditor()

    // Blank layer: the duplicate falls back to a transparent buffer.
    expect(await editor.insertCellHere()).toBe(true)
    expect(liveLayer(editor, layer.id).cells).toEqual([{ frame: 0, resourceId: 'res-1' }])

    // A painted cell at 0, then F6 at frame 3 duplicates its resource.
    editor.commitStroke('paint-1', 0)
    extendTimelineTo(editor, 3)
    editor.seekToFrame(3)
    expect(await editor.insertCellHere()).toBe(true)
    expect(liveLayer(editor, layer.id).cells.map((cell) => cell.frame)).toEqual([0, 3])
    expect(liveLayer(editor, layer.id).cells[1].resourceId).toBe('paint-1')

    // A cell already at the playhead refuses the insertion.
    expect(await editor.insertCellHere()).toBe(false)
    expect(liveLayer(editor, layer.id).cells).toHaveLength(2)

    // Everything above is one undo step per insertion.
    editor.undo()
    expect(liveLayer(editor, layer.id).cells.map((cell) => cell.frame)).toEqual([0])
  })

  it('insertBlankCellHere always seeds a transparent cell', async () => {
    const { editor, layer } = seededEditor()
    editor.commitStroke('paint-1', 0)
    extendTimelineTo(editor, 3)
    editor.seekToFrame(2)
    expect(await editor.insertBlankCellHere()).toBe(true)
    // The blank cell is its own transparent resource, not the held content.
    expect(liveLayer(editor, layer.id).cells[1].resourceId).toBe('res-1')
    // A cell already at the playhead refuses the insertion.
    expect(await editor.insertBlankCellHere()).toBe(false)

    // After the blank cell, frame 3 holds the transparent buffer — the
    // painted content stopped holding through.
    editor.seekToFrame(3)
    expect(resolveCellAtFrame(liveLayer(editor, layer.id), 3)).toBe('res-1')
  })

  it('clearCellHere blanks the cell at the playhead', async () => {
    const { editor, layer } = seededEditor()
    // Nothing held: nothing to clear.
    expect(await editor.clearCellHere()).toBe(false)

    editor.commitStroke('paint-1', 0)
    expect(await editor.clearCellHere()).toBe(true)
    expect(liveLayer(editor, layer.id).cells[0].resourceId).not.toBe('paint-1')
    editor.undo()
    expect(liveLayer(editor, layer.id).cells[0].resourceId).toBe('paint-1')
  })

  it('removeCellHere removes exactly the cell at the playhead', () => {
    const { editor, layer } = seededEditor()
    expect(editor.removeCellHere()).toBe(false)

    editor.commitStroke('paint-1', 0)
    editor.commitStroke('paint-2', 3)
    // Frame 1 holds the cell of frame 0 but has no cell of its own.
    editor.seekToFrame(1)
    expect(editor.removeCellHere()).toBe(false)
    editor.seekToFrame(3)
    expect(editor.removeCellHere()).toBe(true)
    expect(liveLayer(editor, layer.id).cells.map((cell) => cell.frame)).toEqual([0])
    editor.undo()
    expect(liveLayer(editor, layer.id).cells.map((cell) => cell.frame)).toEqual([0, 3])
  })

  it('seeks between cell boundaries', () => {
    const { editor } = seededEditor()
    expect(editor.seekToPreviousCell()).toBe(false)
    editor.commitStroke('paint-1', 0)
    editor.commitStroke('paint-2', 4)
    extendTimelineTo(editor, 6)
    editor.seekToFrame(6)
    expect(editor.seekToPreviousCell()).toBe(true)
    expect(editor.currentFrame).toBe(4)
    expect(editor.seekToPreviousCell()).toBe(true)
    expect(editor.currentFrame).toBe(0)
    expect(editor.seekToPreviousCell()).toBe(false)
    editor.seekToFrame(1)
    expect(editor.seekToNextCell()).toBe(true)
    expect(editor.currentFrame).toBe(4)
    expect(editor.seekToNextCell()).toBe(false)
  })

  it('clamps brush settings and per-layer drawing resolution', () => {
    const { editor, layer } = seededEditor()
    editor.setBrushSize(0)
    expect(editor.brushSize).toBe(1)
    editor.setBrushSize(500)
    expect(editor.brushSize).toBe(100)
    editor.setBrushSize(12.6)
    expect(editor.brushSize).toBe(13)
    editor.setBrushSize(Number.NaN)
    expect(editor.brushSize).toBe(13)
    editor.setBrushOpacity(2)
    expect(editor.brushOpacity).toBe(1)
    editor.setBrushOpacity(-1)
    expect(editor.brushOpacity).toBe(0)

    editor.setDrawingResolution(layer.id, 2.4)
    expect(layer.resolutionScale).toBe(2)
    editor.setDrawingResolution(layer.id, 99)
    expect(layer.resolutionScale).toBe(4)
    editor.setDrawingResolution(layer.id, 0)
    expect(layer.resolutionScale).toBe(1)
    editor.setDrawingResolution('missing', 2)
    // Each resolution change is its own undo step.
    editor.undo()
    expect(liveLayer(editor, layer.id).resolutionScale).toBe(4)
    editor.undo()
    expect(liveLayer(editor, layer.id).resolutionScale).toBe(2)
  })

  it('cell operations refuse object layers and locked drawing layers', async () => {
    const doc = createDocument('test', 960, 540, 24)
    const editor = new Editor(doc)
    expect(await editor.insertCellHere()).toBe(false)
    expect(await editor.insertBlankCellHere()).toBe(false)
    expect(await editor.clearCellHere()).toBe(false)
    expect(editor.removeCellHere()).toBe(false)

    const locked = seededEditor()
    locked.layer.locked = true
    expect(await locked.editor.insertCellHere()).toBe(false)
    expect(await locked.editor.insertBlankCellHere()).toBe(false)
    expect(await locked.editor.clearCellHere()).toBe(false)
    expect(locked.editor.removeCellHere()).toBe(false)
  })

  it('keeps object operations off drawing layers', () => {
    const { editor, layer } = seededEditor()
    editor.addNode(rect('a'))
    expect(layer.cells).toHaveLength(0)
    editor.insertKeyframeHere()
    editor.ensureNodeKeyframe('a')
    expect(layer.cells).toHaveLength(0)
    expect(getLayer(editor.document, layer.id)?.kind).toBe('drawing')
  })
})

describe('Editor — document palette', () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor(createDocument('test', 960, 540, 24))
  })

  it('setPalette normalizes, dedupes and stores as one undo step', () => {
    editor.setPalette(['#FF0000', 'bogus', '#ff0000', '#ABC'])
    expect(editor.document.palette).toEqual(['#ff0000', '#aabbcc'])
    editor.undo()
    expect(editor.document.palette).toEqual([])
    editor.redo()
    expect(editor.document.palette).toEqual(['#ff0000', '#aabbcc'])
  })

  it('setPalette is a no-op (no history entry) when the palette is unchanged', () => {
    editor.setPalette(['#ff0000'])
    editor.undo()
    expect(editor.document.palette).toEqual([])
    // Calling with an equivalent (unnormalized) list must not add history.
    editor.setPalette(['#ff0000'])
    editor.undo()
    expect(editor.document.palette).toEqual([])
    expect(editor.canUndo).toBe(false)
  })

  it('addPaletteColor appends normalized colors once, ignoring invalid and duplicate entries', () => {
    editor.addPaletteColor('#ABCDEF')
    editor.addPaletteColor('#abcdef')
    editor.addPaletteColor('not-a-color')
    expect(editor.document.palette).toEqual(['#abcdef'])
    editor.undo()
    expect(editor.document.palette).toEqual([])
    expect(editor.canUndo).toBe(false)
  })

  it('addPaletteColor refuses at the cap with a status message', () => {
    const message = vi.fn()
    editor.onMessage(message)
    editor.setPalette(
      Array.from({ length: 48 }, (_, index) => `#${index.toString(16).padStart(6, '0')}`)
    )
    editor.addPaletteColor('#ffffff')
    expect(editor.document.palette).toHaveLength(48)
    expect(message).toHaveBeenCalledWith('Palette is full (48 colors)')
  })

  it('removePaletteColor removes by normalized color as one undo step', () => {
    editor.setPalette(['#ff0000', '#00ff00'])
    editor.removePaletteColor('#FF0000')
    expect(editor.document.palette).toEqual(['#00ff00'])
    editor.removePaletteColor('#123456')
    expect(editor.document.palette).toEqual(['#00ff00'])
    editor.undo()
    expect(editor.document.palette).toEqual(['#ff0000', '#00ff00'])
  })
})

describe('Editor — addNodeWithAssets', () => {
  it('adds the node and the assets in a single undo step, and selects the node', () => {
    const editor = new Editor(createDocument('test', 960, 540, 24))
    const node: GroupNode = {
      id: 'imported',
      type: 'group',
      center: { x: 10, y: 20 },
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1,
      children: []
    }
    const asset: Asset = {
      id: 'asset-1',
      name: 'Imported symbol 1',
      kind: 'symbol',
      createdAt: 0,
      content: {
        id: 'content',
        type: 'group',
        center: { x: 0, y: 0 },
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1,
        children: []
      }
    }
    editor.addNodeWithAssets(node, [asset])
    const layer = editor.currentLayer
    if (!layer || layer.kind !== 'object') throw new Error('expected an object layer')
    expect(evaluateLayerAtFrame(layer, 0).map((entry) => entry.id)).toEqual(['imported'])
    expect(editor.document.assets.map((entry) => entry.id)).toEqual(['asset-1'])
    expect(editor.selectedNodeIds).toEqual(['imported'])
    editor.undo()
    expect(editor.document.assets).toHaveLength(0)
    expect(
      evaluateLayerAtFrame(getLayer(editor.document, layer.id) as ObjectLayer, 0)
    ).toHaveLength(0)
  })

  it('refuses drawing and locked layers', () => {
    const doc = createDocument('test', 960, 540, 24)
    const drawing = createDrawingLayer('Draw')
    doc.layers.unshift(drawing)
    const editor = new Editor(doc)
    editor.currentLayerId = drawing.id
    editor.addNodeWithAssets(rect('x'), [])
    expect(drawing.cells).toHaveLength(0)

    editor.setCurrentLayer(doc.layers[1].id)
    doc.layers[1].locked = true
    editor.addNodeWithAssets(rect('x'), [])
    expect(editor.canUndo).toBe(false)
  })
})

const AUDIO_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])

/** Live audio layer of the editor's current document (undo replaces it). */
function liveAudioLayer(editor: Editor, id: string): AudioLayer {
  const layer = getLayer(editor.document, id)
  if (!layer || layer.kind !== 'audio') throw new Error('audio layer vanished')
  return layer
}

describe('Editor — audio playback bridge', () => {
  function stubAudio() {
    return { start: vi.fn(), stop: vi.fn(), sync: vi.fn(), scrub: vi.fn() }
  }

  /** Manual animation-frame pump for the playback loop (node environment). */
  function stubAnimationFrames(): { pump: (time: number) => void; restore: () => void } {
    let scheduled: ((time: number) => void) | null = null
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: (time: number) => void) => {
        scheduled = callback
        return 1
      },
      cancelAnimationFrame: () => {
        scheduled = null
      }
    })
    return {
      pump: (time: number) => {
        const callback = scheduled
        if (!callback) throw new Error('no animation frame was scheduled')
        scheduled = null
        callback(time)
      },
      restore: () => vi.unstubAllGlobals()
    }
  }

  it('play/pause drive the bridge and a loop wrap re-syncs it to frame 0', () => {
    const audio = stubAudio()
    const raf = stubAnimationFrames()
    try {
      const editor = new Editor(createDocument('test', 960, 540, 24), { audio })
      editor.insertFrameHere() // duration 2: playable, wraps on frame 1
      editor.play()
      expect(editor.playing).toBe(true)
      expect(audio.start).toHaveBeenCalledWith(editor.document, 0, 24)
      editor.play()
      expect(audio.start).toHaveBeenCalledTimes(1) // already playing

      // Seeking during playback re-aligns the mix to the new position.
      editor.seekToFrame(1)
      expect(audio.sync).toHaveBeenLastCalledWith(editor.document, 1, 24)

      // Pump the loop one frame: 1 + 1 >= duration wraps back to frame 0.
      raf.pump(1000)
      raf.pump(1000 + 1000 / 24)
      expect(editor.currentFrame).toBe(0)
      expect(audio.sync).toHaveBeenLastCalledWith(editor.document, 0, 24)
      expect(audio.sync).toHaveBeenCalledTimes(2)

      editor.pause()
      expect(editor.playing).toBe(false)
      expect(audio.stop).toHaveBeenCalledTimes(1)
      // Paused seeks never touch the mix.
      audio.sync.mockClear()
      editor.seekToFrame(1)
      expect(audio.sync).not.toHaveBeenCalled()
    } finally {
      raf.restore()
    }
  })

  it('the paused scrub blip fires only while the flag is on', () => {
    const audio = stubAudio()
    const editor = new Editor(createDocument('test', 960, 540, 24), { audio })
    editor.insertFrameHere()
    editor.seekToFrame(1)
    expect(audio.scrub).not.toHaveBeenCalled() // off by default

    editor.setScrubAudio(true)
    expect(editor.scrubAudio).toBe(true)
    editor.seekToFrame(0)
    expect(audio.scrub).toHaveBeenCalledWith(editor.document, 0, 24)

    editor.toggleScrubAudio()
    expect(editor.scrubAudio).toBe(false)
    audio.scrub.mockClear()
    editor.seekToFrame(1)
    expect(audio.scrub).not.toHaveBeenCalled()
  })
})

describe('Editor — camera and audio mutations', () => {
  it('audio creation, clip moves, volume clamping and mute are one undo step each', () => {
    const editor = new Editor(createDocument('test', 960, 540, 24))
    editor.resources.put('res-audio', AUDIO_BYTES)

    // Unknown resources are refused without a history entry.
    expect(editor.addAudioLayer('missing', 'Ghost')).toBeNull()
    expect(editor.canUndo).toBe(false)

    const created = editor.addAudioLayer('res-audio', 'Score', 3)
    if (!created) throw new Error('expected the audio layer')
    expect(liveAudioLayer(editor, created.id).startFrame).toBe(3)
    expect(editor.currentLayerId).toBe(created.id)

    // Volume clamps to 0..1; clamping to the current value adds no history.
    editor.setAudioLayerVolume(created.id, 1.5)
    expect(liveAudioLayer(editor, created.id).volume).toBe(1)
    editor.setAudioLayerVolume(created.id, 0.25)
    expect(liveAudioLayer(editor, created.id).volume).toBe(0.25)
    expect(editor.setAudioClipStart(created.id, 6.4)).toBe(true)
    expect(liveAudioLayer(editor, created.id).startFrame).toBe(6)
    expect(editor.setAudioClipStart(created.id, -5)).toBe(true)
    expect(liveAudioLayer(editor, created.id).startFrame).toBe(0)
    editor.toggleAudioMute(created.id)
    expect(liveAudioLayer(editor, created.id).visible).toBe(false)

    // Walk the history back: one entry per mutation (the no-op clamp pushed
    // nothing), ending at the layer creation.
    editor.undo()
    expect(liveAudioLayer(editor, created.id).visible).toBe(true)
    editor.undo()
    expect(liveAudioLayer(editor, created.id).startFrame).toBe(6)
    editor.undo()
    expect(liveAudioLayer(editor, created.id).startFrame).toBe(3)
    editor.undo()
    expect(liveAudioLayer(editor, created.id).volume).toBe(1)
    editor.undo()
    expect(editor.document.layers.some((entry) => entry.id === created.id)).toBe(false)
    expect(editor.canUndo).toBe(false)
  })

  it('camera retimes coalesce into a single undo step', () => {
    const editor = new Editor(createDocument('test', 960, 540, 24))
    while (editor.duration <= 15) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    if (!editor.addCameraLayer()) throw new Error('expected the camera layer')
    editor.setFrame(6)
    editor.ensureCameraKeyframe()
    editor.setFrame(12)
    editor.ensureCameraKeyframe()
    expect(editor.cameraLayer?.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 6, 12])

    expect(
      editor.moveCameraKeyframes([
        { fromFrame: 6, toFrame: 7 },
        { fromFrame: 12, toFrame: 13 }
      ])
    ).toBe(true)
    expect(editor.cameraLayer?.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 7, 13])
    editor.undo()
    expect(editor.cameraLayer?.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 6, 12])
    editor.redo()
    expect(editor.cameraLayer?.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 7, 13])
  })
})
