import { describe, expect, it } from 'vitest'

import { drawingCellNodeId, evaluateDocumentAtFrame } from './render'
import type { AnimatorDocument, Asset, GroupNode, ObjectLayer, PrimitiveNode, SceneNode, SymbolNode } from './model'

function rect(id: string, x = 0, overrides: Partial<PrimitiveNode> = {}): PrimitiveNode {
  return {
    type: 'primitive',
    primitive: 'rect',
    id,
    center: { x, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1,
    ...overrides
  }
}

function layer(id: string, overrides: Partial<ObjectLayer> = {}): ObjectLayer {
  return {
    kind: 'object',
    id,
    name: id,
    visible: true,
    locked: false,
    keyframes: [],
    ...overrides
  }
}

describe('evaluateDocumentAtFrame', () => {
  it('returns layers in paint order (bottom of the stack first)', () => {
    const doc: AnimatorDocument = {
      schemaVersion: 5,
      name: 't',
      palette: [],
      width: 100,
      height: 100,
      fps: 24,
      background: '#000',
      assets: [],
      layers: [
        layer('top', { keyframes: [{ frame: 0, nodes: [rect('a', 0)] }] }),
        layer('mid', { keyframes: [{ frame: 0, nodes: [rect('b', 1)] }] }),
        layer('bottom', { keyframes: [{ frame: 0, nodes: [rect('c', 2)] }] })
      ]
    }
    const rendered = evaluateDocumentAtFrame(doc, 0)
    expect(rendered.map((renderLayer) => renderLayer.layerId)).toEqual([
      'bottom',
      'mid',
      'top'
    ])
    expect(rendered.map((renderLayer) => renderLayer.nodes.map((node) => node.id))).toEqual([
      ['c'],
      ['b'],
      ['a']
    ])
  })

  it('skips hidden layers but keeps empty visible ones', () => {
    const doc: AnimatorDocument = {
      schemaVersion: 5,
      name: 't',
      palette: [],
      width: 100,
      height: 100,
      fps: 24,
      background: '#000',
      assets: [],
      layers: [
        layer('visible-empty', {}),
        layer('hidden', { visible: false, keyframes: [{ frame: 0, nodes: [rect('a', 0)] }] })
      ]
    }
    const rendered = evaluateDocumentAtFrame(doc, 0)
    expect(rendered).toHaveLength(1)
    expect(rendered[0].layerId).toBe('visible-empty')
    expect(rendered[0].nodes).toEqual([])
    expect(rendered[0].name).toBe('visible-empty')
  })

  it('hides a node after its last keyframe (per-object span)', () => {
    const doc: AnimatorDocument = {
      schemaVersion: 5,
      name: 't',
      palette: [],
      width: 100,
      height: 100,
      fps: 24,
      background: '#000',
      assets: [],
      layers: [
        layer('l', {
          keyframes: [
            { frame: 0, nodes: [rect('a', 0), rect('b', 1)] },
            { frame: 3, nodes: [rect('a', 2)] }
          ]
        })
      ]
    }
    // b's span ends at its keyframe on frame 0, so it is gone from frame 1 on;
    // a holds through.
    expect(evaluateDocumentAtFrame(doc, 0)[0].nodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(evaluateDocumentAtFrame(doc, 1)[0].nodes.map((node) => node.id)).toEqual(['a'])
    expect(evaluateDocumentAtFrame(doc, 2)[0].nodes.map((node) => node.id)).toEqual(['a'])
  })

  it('interpolates a tweened node toward the next keyframe containing it', () => {
    const doc: AnimatorDocument = {
      schemaVersion: 5,
      name: 't',
      palette: [],
      width: 100,
      height: 100,
      fps: 24,
      background: '#000',
      assets: [],
      layers: [
        layer('l', {
          keyframes: [
            {
              frame: 0,
              nodes: [rect('a', 0)],
              tween: { easing: 'linear' }
            },
            { frame: 10, nodes: [rect('a', 100)] }
          ]
        })
      ]
    }
    const node = evaluateDocumentAtFrame(doc, 5)[0].nodes[0]
    expect(node.id).toBe('a')
    expect(node.center.x).toBeCloseTo(50)
  })

  it('returns an empty tree for a document without layers', () => {
    const doc: AnimatorDocument = {
      schemaVersion: 5,
      name: 't',
      palette: [],
      width: 100,
      height: 100,
      fps: 24,
      background: '#000',
      assets: [],
      layers: []
    }
    expect(evaluateDocumentAtFrame(doc, 0)).toEqual([])
  })

  it('resolves symbol instances into groups carrying the asset content', () => {
    const asset: Asset = {
      id: 'asset-1',
      name: 'Rocket',
      kind: 'symbol',
      content: {
        type: 'group',
        id: 'content',
        center: { x: 0, y: 0 },
        width: 100,
        height: 50,
        rotation: 0,
        opacity: 1,
        children: [rect('leaf', 10)]
      },
      createdAt: 1
    }
    const instance: SymbolNode = {
      id: 's',
      type: 'symbol',
      assetId: 'asset-1',
      center: { x: 40, y: 30 },
      width: 200,
      height: 100,
      rotation: 15,
      opacity: 0.75
    }
    const doc: AnimatorDocument = {
      schemaVersion: 5,
      name: 't',
      palette: [],
      width: 100,
      height: 100,
      fps: 24,
      background: '#000',
      assets: [asset],
      layers: [layer('l', { keyframes: [{ frame: 0, nodes: [instance] }] })]
    }
    const nodes = evaluateDocumentAtFrame(doc, 0)[0].nodes
    expect(nodes).toHaveLength(1)
    const group = nodes[0] as GroupNode
    expect(group.type).toBe('group')
    expect(group.id).toBe('s')
    expect(group.center).toEqual({ x: 40, y: 30 })
    expect(group.width).toBe(200)
    expect(group.rotation).toBe(15)
    expect(group.children[0].id).toBe('leaf')
  })

  it('leaves unresolvable symbol instances in place (dashed placeholders)', () => {
    const instance: SceneNode = {
      id: 's',
      type: 'symbol',
      assetId: 'gone',
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1
    }
    const doc: AnimatorDocument = {
      schemaVersion: 5,
      name: 't',
      palette: [],
      width: 100,
      height: 100,
      fps: 24,
      background: '#000',
      assets: [],
      layers: [layer('l', { keyframes: [{ frame: 0, nodes: [instance] }] })]
    }
    expect(evaluateDocumentAtFrame(doc, 0)[0].nodes).toEqual([instance])
  })

  it('resolves nested symbol instances recursively', () => {
    const inner: Asset = {
      id: 'inner',
      name: 'inner',
      kind: 'symbol',
      content: {
        type: 'group',
        id: 'c1',
        center: { x: 0, y: 0 },
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1,
        children: [rect('leaf')]
      },
      createdAt: 1
    }
    const outer: Asset = {
      id: 'outer',
      name: 'outer',
      kind: 'symbol',
      content: {
        type: 'group',
        id: 'c2',
        center: { x: 0, y: 0 },
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1,
        children: [{ id: 's', type: 'symbol', assetId: 'inner', center: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0, opacity: 1 }]
      },
      createdAt: 1
    }
    const doc: AnimatorDocument = {
      schemaVersion: 5,
      name: 't',
      palette: [],
      width: 100,
      height: 100,
      fps: 24,
      background: '#000',
      assets: [inner, outer],
      layers: [
        layer('l', {
          keyframes: [
            {
              frame: 0,
              nodes: [{ id: 's', type: 'symbol', assetId: 'outer', center: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0, opacity: 1 }]
            }
          ]
        })
      ]
    }
    const group = evaluateDocumentAtFrame(doc, 0)[0].nodes[0] as GroupNode
    expect(group.children[0].type).toBe('group')
    expect(((group.children[0] as GroupNode).children[0] as PrimitiveNode).id).toBe('leaf')
  })

  it('still tweens resolved symbol content inside groups', () => {
    // The instance's own transform tweens; resolution preserves the tweened pose.
    const asset: Asset = {
      id: 'asset-1',
      name: 'Rocket',
      kind: 'symbol',
      content: {
        type: 'group',
        id: 'content',
        center: { x: 0, y: 0 },
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1,
        children: [rect('leaf')]
      },
      createdAt: 1
    }
    const doc: AnimatorDocument = {
      schemaVersion: 5,
      name: 't',
      palette: [],
      width: 100,
      height: 100,
      fps: 24,
      background: '#000',
      assets: [asset],
      layers: [
        layer('l', {
          keyframes: [
            {
              frame: 0,
              nodes: [{ id: 's', type: 'symbol', assetId: 'asset-1', center: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0, opacity: 1 }],
              tween: { easing: 'linear' }
            },
            { frame: 10, nodes: [{ id: 's', type: 'symbol', assetId: 'asset-1', center: { x: 100, y: 0 }, width: 10, height: 10, rotation: 0, opacity: 1 }] }
          ]
        })
      ]
    }
    const group = evaluateDocumentAtFrame(doc, 5)[0].nodes[0] as GroupNode
    expect(group.center.x).toBeCloseTo(50)
  })
})

describe('evaluateDocumentAtFrame — drawing layers', () => {
  const docWithDrawing = (): { doc: AnimatorDocument; drawingId: string } => {
    const doc: AnimatorDocument = {
      schemaVersion: 5,
      name: 't',
      palette: [],
      width: 100,
      height: 50,
      fps: 24,
      background: '#000',
      assets: [],
      layers: [
        layer('obj', { keyframes: [{ frame: 0, nodes: [rect('a', 5)] }] }),
        {
          kind: 'drawing',
          id: 'draw',
          name: 'Draw',
          visible: true,
          locked: false,
          resolutionScale: 2,
          cells: [{ frame: 3, resourceId: 'res-cell' }]
        }
      ]
    }
    return { doc, drawingId: 'draw' }
  }

  it('resolves the held cell into one synthetic full-stage image node', () => {
    const { doc, drawingId } = docWithDrawing()
    const rendered = evaluateDocumentAtFrame(doc, 7)
    const drawLayer = rendered.find((entry) => entry.layerId === drawingId)!
    expect(drawLayer.nodes).toHaveLength(1)
    const cellNode = drawLayer.nodes[0]
    expect(cellNode.type).toBe('image')
    if (cellNode.type !== 'image') throw new Error('expected an image node')
    expect(cellNode.id).toBe(drawingCellNodeId(drawingId))
    expect(cellNode.resourceId).toBe('res-cell')
    // Full-stage geometry with the buffer resolution baked in.
    expect(cellNode.center).toEqual({ x: 50, y: 25 })
    expect(cellNode.width).toBe(100)
    expect(cellNode.height).toBe(50)
    expect(cellNode.naturalWidth).toBe(200)
    expect(cellNode.naturalHeight).toBe(100)
    expect(cellNode.smoothing).toBe(true)
  })

  it('renders nothing for frames before the first cell', () => {
    const { doc, drawingId } = docWithDrawing()
    const rendered = evaluateDocumentAtFrame(doc, 2)
    expect(rendered.find((entry) => entry.layerId === drawingId)!.nodes).toEqual([])
  })

  it('keeps object layers and cells interleaved in paint order', () => {
    const { doc } = docWithDrawing()
    const rendered = evaluateDocumentAtFrame(doc, 5)
    // Paint order is bottom of the stack first: the drawing layer sits below
    // the object layer that was added above it.
    expect(rendered.map((entry) => entry.layerId)).toEqual(['draw', 'obj'])
    // Hidden layers drop out entirely, cells included.
    const hidden = docWithDrawing()
    ;(hidden.doc.layers[1] as { visible: boolean }).visible = false
    expect(evaluateDocumentAtFrame(hidden.doc, 5).map((entry) => entry.layerId)).toEqual(['obj'])
  })
})

describe('evaluateDocumentAtFrame — hold step', () => {
  const movingDoc = (holdStep?: number): AnimatorDocument => ({
    schemaVersion: 5,
    name: 't',
    width: 100,
    height: 100,
    fps: 24,
    background: '#000',
    palette: [],
    assets: [],
    ...(holdStep !== undefined ? { holdStep } : {}),
    layers: [
      layer('l', {
        keyframes: [
          { frame: 0, nodes: [rect('a', 0)], tween: { easing: 'linear' } },
          { frame: 10, nodes: [rect('a', 100)] }
        ]
      })
    ]
  })

  it('evaluates frames at frame - frame % holdStep', () => {
    const doc = movingDoc(2)
    // Stepped frames: 0, 2, 4, 6, 8, 10 — a tween at 50% per segment step.
    expect(evaluateDocumentAtFrame(doc, 0)[0].nodes[0].center.x).toBe(0)
    expect(evaluateDocumentAtFrame(doc, 1)[0].nodes[0].center.x).toBe(0)
    expect(evaluateDocumentAtFrame(doc, 3)[0].nodes[0].center.x).toBe(20)
    expect(evaluateDocumentAtFrame(doc, 5)[0].nodes[0].center.x).toBe(40)
    expect(evaluateDocumentAtFrame(doc, 10)[0].nodes[0].center.x).toBe(100)
  })

  it('steps further with larger hold values', () => {
    const doc = movingDoc(5)
    expect(evaluateDocumentAtFrame(doc, 4)[0].nodes[0].center.x).toBe(0)
    expect(evaluateDocumentAtFrame(doc, 7)[0].nodes[0].center.x).toBe(50)
  })

  it('is evaluation-time only: the document itself keeps every frame', () => {
    const doc = movingDoc(4)
    const snapshot = JSON.stringify(doc.layers)
    evaluateDocumentAtFrame(doc, 7)
    // No frames duplicated or rewritten: the same two keyframes remain.
    expect(JSON.stringify(doc.layers)).toBe(snapshot)
    expect((doc.layers[0] as ObjectLayer).keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 10])
  })

  it('leaves evaluation untouched when the step is absent or 1', () => {
    expect(evaluateDocumentAtFrame(movingDoc(), 5)[0].nodes[0].center.x).toBe(50)
    expect(evaluateDocumentAtFrame(movingDoc(1), 5)[0].nodes[0].center.x).toBe(50)
    // A zero/out-of-band step degrades to no stepping instead of dividing.
    const zeroStep = movingDoc()
    zeroStep.holdStep = 0
    expect(evaluateDocumentAtFrame(zeroStep, 5)[0].nodes[0].center.x).toBe(50)
  })

  it('steps drawing cells through the same evaluation', () => {
    const doc: AnimatorDocument = {
      schemaVersion: 5,
      name: 't',
      palette: [],
      width: 100,
      height: 50,
      fps: 24,
      background: '#000',
      assets: [],
      holdStep: 3,
      layers: [
        {
          kind: 'drawing',
          id: 'draw',
          name: 'Draw',
          visible: true,
          locked: false,
          resolutionScale: 1,
          cells: [
            { frame: 0, resourceId: 'res-a' },
            { frame: 4, resourceId: 'res-b' }
          ]
        }
      ]
    }
    // Frame 5 steps to 3: cell 'res-b' (frame 4) is not reached yet.
    const atThree = evaluateDocumentAtFrame(doc, 5)[0].nodes[0]
    expect(atThree.type === 'image' && atThree.resourceId).toBe('res-a')
    // Frame 6 steps to 6: now the second cell holds.
    const atSix = evaluateDocumentAtFrame(doc, 6)[0].nodes[0]
    expect(atSix.type === 'image' && atSix.resourceId).toBe('res-b')
  })
})
