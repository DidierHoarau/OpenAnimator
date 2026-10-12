import { describe, expect, it } from 'vitest'

import { documentDuration, insertFrame, removeFrame } from '../document'
import type {
  AnimatorDocument,
  AudioLayer,
  CameraLayer,
  DrawingLayer,
  GroupNode,
  ImageNode,
  Keyframe,
  ObjectLayer,
  PathNode,
  PrimitiveNode,
  SceneNode,
  SymbolNode,
  TextNode
} from '../model'
import { diffDocumentsToCommands, type RecorderDiffResult, type RecorderFrameContext } from './recorder'

function rect(id: string, overrides: Partial<PrimitiveNode> = {}): PrimitiveNode {
  return {
    type: 'primitive',
    id,
    primitive: 'rect',
    center: { x: 100, y: 100 },
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    fill: '#ff5252',
    ...overrides
  }
}

function pathN(id: string, overrides: Partial<PathNode> = {}): PathNode {
  return {
    type: 'path',
    id,
    d: 'M0 0L10 0L10 10Z',
    center: { x: 5, y: 5 },
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    ...overrides
  }
}

function textN(id: string, overrides: Partial<TextNode> = {}): TextNode {
  return {
    type: 'text',
    id,
    text: 'Hello',
    fontFamily: 'Inter',
    fontSize: 32,
    fontWeight: 400,
    fill: '#ffffff',
    align: 'center',
    center: { x: 0, y: 0 },
    width: 80,
    height: 40,
    rotation: 0,
    opacity: 1,
    ...overrides
  }
}

function imageN(id: string, overrides: Partial<ImageNode> = {}): ImageNode {
  return {
    type: 'image',
    id,
    resourceId: 'res-1',
    naturalWidth: 64,
    naturalHeight: 64,
    smoothing: true,
    center: { x: 0, y: 0 },
    width: 64,
    height: 64,
    rotation: 0,
    opacity: 1,
    ...overrides
  }
}

function groupN(id: string, children: SceneNode[], overrides: Partial<GroupNode> = {}): GroupNode {
  return {
    type: 'group',
    id,
    children,
    center: { x: 0, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    ...overrides
  }
}

function symbolN(id: string, assetId: string, overrides: Partial<SymbolNode> = {}): SymbolNode {
  return {
    type: 'symbol',
    id,
    assetId,
    center: { x: 0, y: 0 },
    width: 50,
    height: 50,
    rotation: 0,
    opacity: 1,
    ...overrides
  }
}

function objectLayer(id: string, keyframes: Keyframe[], name: string = id): ObjectLayer {
  return { kind: 'object', id, name, visible: true, locked: false, keyframes }
}

function cameraLayer(id: string, keyframes: CameraLayer['keyframes'], name: string = id): CameraLayer {
  return { kind: 'camera', id, name, visible: true, locked: false, keyframes }
}

function drawingLayer(id: string, cells: DrawingLayer['cells'], name: string = id): DrawingLayer {
  return { kind: 'drawing', id, name, visible: true, locked: false, resolutionScale: 1, cells }
}

function audioLayer(id: string, overrides: Partial<AudioLayer> = {}): AudioLayer {
  return {
    kind: 'audio',
    id,
    name: id,
    visible: true,
    locked: false,
    resourceId: 'clip-1',
    startFrame: 0,
    volume: 1,
    ...overrides
  }
}

function doc(layers: AnimatorDocument['layers'], overrides: Partial<AnimatorDocument> = {}): AnimatorDocument {
  return {
    schemaVersion: 9,
    name: 'Test',
    width: 960,
    height: 540,
    fps: 24,
    background: '#10151b',
    layers,
    palette: [],
    assets: [],
    fonts: [],
    ...overrides
  }
}

function pose(x: number, y = 270, zoom = 1, rotation = 0): CameraLayer['keyframes'][number]['pose'] {
  return { center: { x, y }, zoom, rotation }
}

const CONTEXT: RecorderFrameContext = { frame: 0, layerId: null }

function diff(
  before: AnimatorDocument,
  after: AnimatorDocument,
  context: RecorderFrameContext = CONTEXT
): RecorderDiffResult {
  return diffDocumentsToCommands(before, after, context)
}

function firstLayer(document: AnimatorDocument, index = 0): ObjectLayer {
  return document.layers[index] as ObjectLayer
}

describe('diffDocumentsToCommands', () => {
  it('emits nothing for identical documents', () => {
    const before = doc([objectLayer('l1', [{ frame: 0, nodes: [rect('n1')] }])])
    expect(diff(before, structuredClone(before))).toEqual({ commands: [], unsupported: [] })
  })

  it('emits one minimal updateNode for several changed node fields', () => {
    const before = doc([objectLayer('l1', [{ frame: 0, nodes: [rect('n1')] }])])
    const after = structuredClone(before)
    const node = firstLayer(after).keyframes[0].nodes[0] as PrimitiveNode
    node.name = 'Hero'
    node.center = { x: 60, y: 30 }
    node.opacity = 0.5
    node.fill = { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff', alpha: 0.5 }] }
    node.stroke = '#ffffff'
    node.strokeWidth = 4
    node.strokeDasharray = [6, 3]

    expect(diff(before, after).commands).toEqual([
      {
        op: 'updateNode',
        nodeId: 'n1',
        layerId: 'l1',
        frame: 0,
        patch: {
          name: 'Hero',
          center: { x: 60, y: 30 },
          opacity: 0.5,
          fill: { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff', alpha: 0.5 }] },
          stroke: '#ffffff',
          strokeWidth: 4,
          strokeDasharray: [6, 3]
        }
      }
    ])
  })

  it('clears removed optional node fields with null patches', () => {
    const before = doc([
      objectLayer('l1', [{ frame: 0, nodes: [rect('n1', { name: 'Hero', stroke: '#ffffff', strokeWidth: 2 })] }])
    ])
    const after = structuredClone(before)
    const node = firstLayer(after).keyframes[0].nodes[0] as PrimitiveNode
    delete node.name
    delete node.stroke
    delete node.strokeWidth

    expect(diff(before, after).commands).toEqual([
      {
        op: 'updateNode',
        nodeId: 'n1',
        layerId: 'l1',
        frame: 0,
        patch: { name: null, stroke: null, strokeWidth: null }
      }
    ])
  })

  it('patches path geometry and text layout fields', () => {
    const before = doc([
      objectLayer('l1', [
        { frame: 0, nodes: [pathN('p1'), textN('t1', { letterSpacing: 2, ligatures: true })] }
      ])
    ])
    const after = structuredClone(before)
    const [path, text] = firstLayer(after).keyframes[0].nodes as [PathNode, TextNode]
    path.d = 'M0 0L20 0L20 20Z'
    path.fill = '#00ff00'
    text.text = 'Bye'
    delete text.letterSpacing
    text.lineHeight = 1.2

    expect(diff(before, after).commands).toEqual([
      { op: 'updateNode', nodeId: 'p1', layerId: 'l1', frame: 0, patch: { d: 'M0 0L20 0L20 20Z', fill: '#00ff00' } },
      { op: 'updateNode', nodeId: 't1', layerId: 'l1', frame: 0, patch: { text: 'Bye', letterSpacing: null, lineHeight: 1.2 } }
    ])
  })

  it('adds a brand-new node via addNode and further poses via full-patch setKeyframe', () => {
    const before = doc([objectLayer('l1', [{ frame: 0, nodes: [rect('n1')] }])])
    const after = structuredClone(before)
    const layer = firstLayer(after)
    layer.keyframes.push({
      frame: 5,
      nodes: [pathN('p2', { center: { x: 50, y: 50 } }), structuredClone(layer.keyframes[0].nodes[0])]
    })
    layer.keyframes.push({
      frame: 9,
      nodes: [structuredClone(layer.keyframes[0].nodes[0]), pathN('p2', { center: { x: 80, y: 20 } })]
    })
    // n1 also gained poses at 5 and 9 (clone of its frame-0 pose).
    const fullRectPatch = {
      name: null,
      center: { x: 100, y: 100 },
      width: 100,
      height: 100,
      rotation: 0,
      opacity: 1,
      fill: '#ff5252',
      stroke: null,
      strokeWidth: null,
      strokeLinecap: null,
      strokeLinejoin: null,
      strokeDasharray: null,
      strokeDashoffset: null
    }

    expect(diff(before, after).commands).toEqual([
      { op: 'addNode', node: pathN('p2', { center: { x: 50, y: 50 } }), layerId: 'l1', frame: 5 },
      { op: 'setKeyframe', nodeId: 'n1', layerId: 'l1', frame: 5, patch: fullRectPatch },
      { op: 'setKeyframe', nodeId: 'n1', layerId: 'l1', frame: 9, patch: fullRectPatch },
      {
        op: 'setKeyframe',
        nodeId: 'p2',
        layerId: 'l1',
        frame: 9,
        patch: {
          name: null,
          center: { x: 80, y: 20 },
          width: 10,
          height: 10,
          rotation: 0,
          opacity: 1,
          d: 'M0 0L10 0L10 10Z',
          fill: null,
          stroke: null,
          strokeWidth: null,
          strokeLinecap: null,
          strokeLinejoin: null,
          strokeDasharray: null,
          strokeDashoffset: null
        }
      }
    ])
  })

  it('deletes a node removed from every keyframe', () => {
    const before = doc([
      objectLayer('l1', [
        { frame: 0, nodes: [rect('n1')] },
        { frame: 5, nodes: [rect('n1'), rect('n2', { center: { x: 300, y: 300 } })] }
      ])
    ])
    const after = structuredClone(before)
    const layer = firstLayer(after)
    layer.keyframes = [{ frame: 5, nodes: [layer.keyframes[1].nodes[1]] }]

    expect(diff(before, after).commands).toEqual([{ op: 'deleteNode', nodeId: 'n1', layerId: 'l1' }])
  })

  it('removes a single keyframe entry with removeNodeKeyframe', () => {
    const before = doc([
      objectLayer('l1', [
        { frame: 0, nodes: [rect('n1')] },
        { frame: 5, nodes: [rect('n1')] }
      ])
    ])
    const after = structuredClone(before)
    firstLayer(after).keyframes = [firstLayer(after).keyframes[1]]

    expect(diff(before, after).commands).toEqual([
      { op: 'removeNodeKeyframe', nodeId: 'n1', layerId: 'l1', frame: 0 }
    ])
  })

  it('moves a single keyframe with an unchanged pose via moveKeyframe', () => {
    const before = doc([
      objectLayer('l1', [
        { frame: 0, nodes: [rect('n1'), rect('n2', { center: { x: 300, y: 300 } })] },
        { frame: 5, nodes: [rect('n1'), rect('n2', { center: { x: 300, y: 300 } })] }
      ])
    ])
    const after = structuredClone(before)
    const layer = firstLayer(after)
    layer.keyframes[1].nodes = [rect('n2', { center: { x: 300, y: 300 } })]
    layer.keyframes.push({ frame: 7, nodes: [rect('n1')] })

    expect(diff(before, after).commands).toEqual([
      { op: 'moveKeyframe', nodeId: 'n1', layerId: 'l1', fromFrame: 5, toFrame: 7 }
    ])
  })

  it('reports a node stacking-order change as unsupported', () => {
    const before = doc([objectLayer('l1', [{ frame: 0, nodes: [rect('n1'), rect('n2', { center: { x: 300, y: 300 } })] }])])
    const after = structuredClone(before)
    firstLayer(after).keyframes[0].nodes.reverse()

    const result = diff(before, after)
    expect(result.commands).toEqual([])
    expect(result.unsupported).toEqual([
      'layer "l1": node stacking order cannot be replayed exactly (no reorder command exists)'
    ])
  })

  it('reports an added node inserted before existing nodes as unsupported', () => {
    const before = doc([objectLayer('l1', [{ frame: 5, nodes: [rect('n1')] }])])
    const after = structuredClone(before)
    firstLayer(after).keyframes[0].nodes = [rect('p2', { center: { x: 7, y: 7 } }), rect('n1')]

    const result = diff(before, after)
    expect(result.commands).toEqual([
      { op: 'addNode', node: rect('p2', { center: { x: 7, y: 7 } }), layerId: 'l1', frame: 5 }
    ])
    expect(result.unsupported).toEqual([
      'layer "l1": node stacking order cannot be replayed exactly (no reorder command exists)'
    ])
  })

  it('reports non-patchable field changes but still patches the rest', () => {
    const before = doc([objectLayer('l1', [{ frame: 0, nodes: [imageN('img1')] }])])
    const after = structuredClone(before)
    const node = firstLayer(after).keyframes[0].nodes[0] as ImageNode
    node.resourceId = 'res-2'
    node.smoothing = false
    node.center = { x: 10, y: 20 }

    const result = diff(before, after)
    expect(result.commands).toEqual([
      { op: 'updateNode', nodeId: 'img1', layerId: 'l1', frame: 0, patch: { center: { x: 10, y: 20 } } }
    ])
    expect(result.unsupported).toEqual([
      'layer "l1": node img1 resourceId, smoothing change at frame 0 is not recorded'
    ])
  })

  it('reports group children edits as unsupported', () => {
    const before = doc([objectLayer('l1', [{ frame: 0, nodes: [groupN('g1', [rect('c1')])] }])])
    const after = structuredClone(before)
    const node = firstLayer(after).keyframes[0].nodes[0] as GroupNode
    ;(node.children[0] as PrimitiveNode).opacity = 0.5

    const result = diff(before, after)
    expect(result.commands).toEqual([])
    expect(result.unsupported).toEqual(['layer "l1": node g1 children change at frame 0 is not recorded'])
  })

  it('reports poses that cannot be recreated exactly on a new node', () => {
    const before = doc([objectLayer('l1', [{ frame: 0, nodes: [] }])])
    const after = structuredClone(before)
    const layer = firstLayer(after)
    layer.keyframes[0].nodes = [symbolN('s1', 'asset-a')]
    layer.keyframes.push({ frame: 10, nodes: [symbolN('s1', 'asset-b', { center: { x: 40, y: 40 } })] })

    // The pose at frame 10 is still emitted (closest possible replay) but the
    // non-patchable divergence is reported.
    const result = diff(before, after)
    expect(result.commands).toEqual([
      { op: 'addNode', node: symbolN('s1', 'asset-a'), layerId: 'l1', frame: 0 },
      {
        op: 'setKeyframe',
        nodeId: 's1',
        layerId: 'l1',
        frame: 10,
        patch: { name: null, center: { x: 40, y: 40 }, width: 50, height: 50, rotation: 0, opacity: 1 }
      }
    ])
    expect(result.unsupported).toEqual([
      'layer "l1": node s1 pose at frame 10 cannot be replayed exactly (non-patchable fields differ)'
    ])
  })

  describe('tweens', () => {
    it('adds, changes, moves and removes object tweens', () => {
      const before = doc([
        objectLayer('l1', [
          { frame: 0, nodes: [rect('n1')] },
          { frame: 10, nodes: [rect('n1')] }
        ])
      ])
      const after = structuredClone(before)
      firstLayer(after).keyframes[0].tween = { easing: 'ease-in-out' }
      firstLayer(after).keyframes[1].tween = { easing: 'linear', path: 'smooth' }

      expect(diff(before, after).commands).toEqual([
        { op: 'setTween', layerId: 'l1', frame: 0, easing: 'ease-in-out' },
        { op: 'setTween', layerId: 'l1', frame: 10, easing: 'linear', path: 'smooth' }
      ])

      const cleared = structuredClone(after)
      delete firstLayer(cleared).keyframes[1].tween
      expect(diff(after, cleared).commands).toEqual([
        { op: 'setTween', layerId: 'l1', frame: 10, easing: null }
      ])

      const retimed = structuredClone(after)
      firstLayer(retimed).keyframes[0].tween = { easing: 'ease-in', path: 'smooth' }
      expect(diff(after, retimed).commands).toEqual([
        { op: 'setTween', layerId: 'l1', frame: 0, easing: 'ease-in', path: 'smooth' }
      ])
    })

    it('adds, changes and clears per-channel easings', () => {
      const before = doc([
        objectLayer('l1', [{ frame: 0, nodes: [rect('n1')], tween: { easing: 'linear' } }])
      ])
      const added = structuredClone(before)
      firstLayer(added).keyframes[0].tween = { easing: 'linear', easings: { opacity: 'ease-in' } }
      expect(diff(before, added).commands).toEqual([
        { op: 'setTween', layerId: 'l1', frame: 0, easing: 'linear', easings: { opacity: 'ease-in' } }
      ])

      const cleared = structuredClone(added)
      firstLayer(cleared).keyframes[0].tween = { easing: 'linear' }
      expect(diff(added, cleared).commands).toEqual([
        { op: 'setTween', layerId: 'l1', frame: 0, easing: 'linear', easings: { opacity: null } }
      ])

      const channelCleared = structuredClone(before)
      firstLayer(channelCleared).keyframes[0].tween = {
        easing: 'linear',
        easings: { transform: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 }, opacity: 'ease-out' }
      }
      const partial = structuredClone(channelCleared)
      firstLayer(partial).keyframes[0].tween = { easing: 'ease-in-out', easings: { opacity: 'ease-out' } }
      expect(diff(channelCleared, partial).commands).toEqual([
        { op: 'setTween', layerId: 'l1', frame: 0, easing: 'ease-in-out', easings: { transform: null } }
      ])
    })

    it('keeps the target keyframe tween untouched when a node moves away', () => {
      const before = doc([
        objectLayer('l1', [
          { frame: 0, nodes: [rect('n1'), rect('n2', { center: { x: 300, y: 300 } })] },
          { frame: 5, nodes: [rect('n1'), rect('n2', { center: { x: 300, y: 300 } })], tween: { easing: 'linear' } }
        ])
      ])
      const after = structuredClone(before)
      const layer = firstLayer(after)
      layer.keyframes[1].nodes = [rect('n2', { center: { x: 300, y: 300 } })]
      layer.keyframes.push({ frame: 7, nodes: [rect('n1')] })

      // The remaining keyframe keeps its own tween: no tween command needed.
      expect(diff(before, after).commands).toEqual([
        { op: 'moveKeyframe', nodeId: 'n1', layerId: 'l1', fromFrame: 5, toFrame: 7 }
      ])
    })
  })

  describe('camera layers', () => {
    it('sets, removes and re-poses camera keyframes', () => {
      const before = doc(
        [
          cameraLayer('c1', [
            { frame: 0, pose: pose(480) },
            { frame: 10, pose: pose(600, 270, 2) }
          ])
        ],
        { frames: 12 }
      )
      const added = structuredClone(before)
      ;(added.layers[0] as CameraLayer).keyframes.push({ frame: 20, pose: pose(700, 300, 3, 15) })
      expect(diff(before, added).commands).toEqual([
        { op: 'setCameraKeyframe', frame: 20, center: { x: 700, y: 300 }, zoom: 3, rotation: 15 }
      ])

      const repose = structuredClone(before)
      ;(repose.layers[0] as CameraLayer).keyframes[1].pose = pose(650, 270, 2)
      expect(diff(before, repose).commands).toEqual([
        { op: 'setCameraKeyframe', frame: 10, center: { x: 650, y: 270 }, zoom: 2, rotation: 0 }
      ])

      const removed = structuredClone(before)
      ;(removed.layers[0] as CameraLayer).keyframes.pop()
      expect(diff(before, removed).commands).toEqual([{ op: 'removeCameraKeyframe', frame: 10 }])
    })

    it('sets camera tweens and reports per-channel easings as unsupported', () => {
      const before = doc([cameraLayer('c1', [{ frame: 0, pose: pose(480) }, { frame: 10, pose: pose(600) }])])
      const tweened = structuredClone(before)
      ;(tweened.layers[0] as CameraLayer).keyframes[0].tween = { easing: 'linear', path: 'smooth' }
      expect(diff(before, tweened).commands).toEqual([
        { op: 'setTween', layerId: 'c1', frame: 0, easing: 'linear', path: 'smooth' }
      ])

      const plain = structuredClone(before)
      ;(plain.layers[0] as CameraLayer).keyframes[0].tween = { easing: 'linear' }
      const withChannels = structuredClone(plain)
      ;(withChannels.layers[0] as CameraLayer).keyframes[0].tween = {
        easing: 'linear',
        easings: { transform: 'ease-in' }
      }
      // The base easing/path are unchanged, so nothing is expressible as a
      // command: the channel overrides are reported instead.
      const result = diff(plain, withChannels)
      expect(result.commands).toEqual([])
      expect(result.unsupported).toEqual([
        'layer "c1": camera per-channel easing change at frame 0 is not recorded'
      ])

      const cleared = structuredClone(plain)
      delete (cleared.layers[0] as CameraLayer).keyframes[0].tween
      expect(diff(plain, cleared).commands).toEqual([{ op: 'setTween', layerId: 'c1', frame: 0, easing: null }])
    })
  })

  describe('drawing layers', () => {
    it('sets, replaces and adds cells', () => {
      const before = doc([drawingLayer('dl1', [{ frame: 0, resourceId: 'r1' }])])
      const replaced = structuredClone(before)
      ;(replaced.layers[0] as DrawingLayer).cells = [{ frame: 0, resourceId: 'r2' }]
      expect(diff(before, replaced).commands).toEqual([
        { op: 'setCell', layerId: 'dl1', frame: 0, resourceId: 'r2' }
      ])

      const added = structuredClone(before)
      ;(added.layers[0] as DrawingLayer).cells.push({ frame: 5, resourceId: 'r2' })
      expect(diff(before, added).commands).toEqual([
        { op: 'setCell', layerId: 'dl1', frame: 5, resourceId: 'r2' }
      ])
    })

    it('pairs a removed and an added cell with the same resource as moveCell', () => {
      const before = doc([
        drawingLayer('dl1', [
          { frame: 0, resourceId: 'r1' },
          { frame: 4, resourceId: 'r2' }
        ]),
        drawingLayer('dl2', [{ frame: 5, resourceId: 'r9' }])
      ], { frames: 6 })
      const after = structuredClone(before)
      ;(after.layers[0] as DrawingLayer).cells = [
        { frame: 0, resourceId: 'r1' },
        { frame: 5, resourceId: 'r2' }
      ]

      expect(diff(before, after, { frame: 2, layerId: 'dl1' }).commands).toEqual([
        { op: 'moveCell', layerId: 'dl1', fromFrame: 4, toFrame: 5 }
      ])
    })

    it('reports cell removals and resolution changes as unsupported', () => {
      const before = doc([
        drawingLayer('dl1', [
          { frame: 0, resourceId: 'r1' },
          { frame: 5, resourceId: 'r2' }
        ])
      ], { frames: 6 })
      const after = structuredClone(before)
      ;(after.layers[0] as DrawingLayer).cells = [{ frame: 0, resourceId: 'r1' }]
      ;(after.layers[0] as DrawingLayer).resolutionScale = 2

      const result = diff(before, after)
      expect(result.commands).toEqual([])
      expect(result.unsupported).toEqual([
        'layer "dl1": drawing resolution change is not recorded',
        'layer "dl1": cell at frame 5 removed — no remove-cell command exists'
      ])
    })
  })

  describe('audio layers', () => {
    it('sets changed clip fields and maps visibility to mute', () => {
      const before = doc([audioLayer('a1')])
      const after = structuredClone(before)
      const layer = after.layers[0] as AudioLayer
      layer.startFrame = 3
      layer.volume = 0.5
      layer.visible = false

      expect(diff(before, after).commands).toEqual([
        { op: 'setAudio', layerId: 'a1', startFrame: 3, volume: 0.5, muted: true }
      ])

      const unmuted = structuredClone(before)
      unmuted.layers[0].visible = true
      const muted = structuredClone(before)
      muted.layers[0].visible = false
      expect(diff(muted, unmuted).commands).toEqual([{ op: 'setAudio', layerId: 'a1', muted: false }])
    })

    it('reports a clip resource change as unsupported', () => {
      const before = doc([audioLayer('a1')])
      const after = structuredClone(before)
      ;(after.layers[0] as AudioLayer).resourceId = 'clip-2'

      const result = diff(before, after)
      expect(result.commands).toEqual([])
      expect(result.unsupported).toEqual(['layer "a1": audio clip resource change is not recorded'])
    })
  })

  describe('layers', () => {
    it('adds a layer with its real id and records its content against the fresh baseline', () => {
      const before = doc([objectLayer('l1', [{ frame: 0, nodes: [rect('n1')] }])])
      const after = structuredClone(before)
      after.layers.push(objectLayer('l2', [{ frame: 0, nodes: [rect('n2', { center: { x: 20, y: 20 } })] }], 'Layer 2'))

      expect(diff(before, after).commands).toEqual([
        { op: 'addLayer', kind: 'object', name: 'Layer 2', layerId: 'l2' },
        { op: 'addNode', node: rect('n2', { center: { x: 20, y: 20 } }), layerId: 'l2', frame: 0 }
      ])
    })

    it('records an audio layer add with its clip and start frame', () => {
      const before = doc([objectLayer('l1', [{ frame: 0, nodes: [] }])])
      const after = structuredClone(before)
      after.layers.push(audioLayer('a1', { name: 'Sound', resourceId: 'clip-2', startFrame: 2 }))

      expect(diff(before, after).commands).toEqual([
        { op: 'addLayer', kind: 'audio', name: 'Sound', resourceId: 'clip-2', startFrame: 2, layerId: 'a1' }
      ])
    })

    it('records layer removal and renaming', () => {
      const twoLayers = doc([
        objectLayer('l1', [{ frame: 0, nodes: [rect('n1')] }], 'Layer 1'),
        objectLayer('l2', [{ frame: 0, nodes: [] }], 'Layer 2')
      ])
      const removed = structuredClone(twoLayers)
      removed.layers.pop()
      expect(diff(twoLayers, removed).commands).toEqual([{ op: 'removeLayer', layerId: 'l2' }])

      const renamed = structuredClone(twoLayers)
      renamed.layers[0].name = 'Background'
      expect(diff(twoLayers, renamed).commands).toEqual([
        { op: 'renameLayer', layerId: 'l1', name: 'Background' }
      ])
    })

    it('reports reordering, visibility and lock changes as unsupported', () => {
      const before = doc([
        objectLayer('l1', [{ frame: 0, nodes: [] }], 'Layer 1'),
        objectLayer('l2', [{ frame: 0, nodes: [] }], 'Layer 2')
      ])
      const reordered = structuredClone(before)
      reordered.layers.reverse()
      expect(diff(before, reordered).unsupported).toEqual([
        'layer order change is not recorded (no reorder command exists)'
      ])

      const toggled = structuredClone(before)
      toggled.layers[0].visible = false
      toggled.layers[0].locked = true
      expect(diff(before, toggled).unsupported).toEqual([
        'layer "Layer 1": visibility toggle is not recorded (no command exists)',
        'layer "Layer 1": lock toggle is not recorded (no command exists)'
      ])
    })
  })

  describe('frame operations', () => {
    it('detects an insert via the gesture frame and verifies it against the real document op', () => {
      const before = doc([
        objectLayer('l1', [
          { frame: 0, nodes: [rect('n1')] },
          { frame: 5, nodes: [rect('n1')] }
        ])
      ], { frames: 6 })
      const after = structuredClone(before)
      insertFrame(after, 'l1', 2)

      expect(diff(before, after, { frame: 2, layerId: 'l1' }).commands).toEqual([
        { op: 'insertFrames', layerId: 'l1', frame: 2, count: 1 }
      ])

      // Any frame in [0, 4] yields the same document; the recorder keeps the
      // recorded gesture frame instead of inventing a canonical one.
      const aliased = structuredClone(before)
      insertFrame(aliased, 'l1', 3)
      expect(diff(before, aliased, { frame: 3, layerId: 'l1' }).commands).toEqual([
        { op: 'insertFrames', layerId: 'l1', frame: 3, count: 1 }
      ])
    })

    it('detects repeated removals and mirrors the editor playhead clamp', () => {
      const before = doc([
        objectLayer('l1', [
          { frame: 0, nodes: [rect('n1')] },
          { frame: 5, nodes: [rect('n1')] },
          { frame: 9, nodes: [rect('n1')] }
        ])
      ], { frames: 12 })
      const after = structuredClone(before)
      // Mirrors two `removeFrameHere` presses at frame 6 (the playhead is
      // clamped between removals, as in the editor).
      let playhead = 6
      for (let press = 0; press < 2; press += 1) {
        removeFrame(after, playhead)
        playhead = Math.min(playhead, Math.max(0, documentDuration(after) - 1))
      }

      expect(diff(before, after, { frame: 6, layerId: 'l1' }).commands).toEqual([
        { op: 'removeFrames', layerId: 'l1', frame: 6, count: 2 }
      ])
    })

    it('reconstructs duration changes without a shift via setDuration', () => {
      const before = doc([objectLayer('l1', [{ frame: 0, nodes: [rect('n1')] }])], { frames: 6 })
      const grown = structuredClone(before)
      while (documentDuration(grown) < 10) insertFrame(grown, 'l1', documentDuration(grown) - 1)
      expect(diff(before, grown).commands).toEqual([{ op: 'setDuration', frames: 10 }])

      const shrinkBefore = doc([
        objectLayer('l1', [
          { frame: 0, nodes: [rect('n1')] },
          { frame: 6, nodes: [rect('n1')] }
        ])
      ], { frames: 8 })
      const shrunk = structuredClone(shrinkBefore)
      while (documentDuration(shrunk) > 5) removeFrame(shrunk, documentDuration(shrunk) - 1)
      expect(diff(shrinkBefore, shrunk).commands).toEqual([{ op: 'setDuration', frames: 5 }])
    })

    it('reports an authored-length change that keeps the duration as unsupported', () => {
      const before = doc([objectLayer('l1', [{ frame: 0, nodes: [rect('n1')] }, { frame: 10, nodes: [rect('n1')] }])], {
        frames: 3
      })
      const after = structuredClone(before)
      after.frames = 5

      const result = diff(before, after)
      expect(result.commands).toEqual([])
      expect(result.unsupported).toEqual(['authored length change is not recorded'])
    })
  })

  describe('document scalars', () => {
    it('records fps, palette and hold-step changes', () => {
      const before = doc([objectLayer('l1', [{ frame: 0, nodes: [rect('n1')] }])])
      const after = structuredClone(before)
      after.fps = 30
      after.palette = ['#112233', '#445566']
      after.holdStep = 3

      expect(diff(before, after).commands).toEqual([
        { op: 'setFps', fps: 30 },
        { op: 'setPalette', colors: ['#112233', '#445566'] },
        { op: 'setHoldStep', step: 3 }
      ])

      const reset = structuredClone(after)
      delete reset.holdStep
      expect(diff(after, reset).commands).toEqual([{ op: 'setHoldStep', step: 1 }])
    })

    it('reports document-level changes without commands as unsupported', () => {
      const before = doc([objectLayer('l1', [{ frame: 0, nodes: [rect('n1')] }])])
      const after = structuredClone(before)
      after.name = 'Renamed'
      after.width = 800
      after.background = '#000000'
      after.assets = [
        { id: 'as1', name: 'Star', kind: 'image', resourceId: 'res-1', createdAt: 1 }
      ]
      after.fonts = [
        { id: 'f1', family: 'Inter', weight: 400, resourceId: 'font-1', glyphs: ['a'], license: 'OFL' }
      ]

      const result = diff(before, after)
      expect(result.commands).toEqual([])
      expect(result.unsupported).toEqual([
        'document name change is not recorded (no command exists)',
        'stage size change is not recorded (no command exists)',
        'background change is not recorded (no command exists)',
        'asset library change is not recorded (no command exists)',
        'embedded font change is not recorded (no command exists)'
      ])
    })
  })
})
