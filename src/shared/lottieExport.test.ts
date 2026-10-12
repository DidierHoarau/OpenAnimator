import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  createAudioLayer,
  createCameraLayer,
  createDocument,
  createDrawingLayer,
  createLayer,
  evaluateLayerAtFrame,
  insertCameraKeyframe,
  insertKeyframe
} from './document'
import type { Easing } from './easing'
import { buildLottieAnimation, packDotLottie, serializeLottie, type LottieBuildDeps } from './lottieExport'
import type {
  AnimatorDocument,
  GroupNode,
  ImageNode,
  ObjectLayer,
  PathNode,
  PrimitiveNode,
  TextNode
} from './model'

/**
 * Structural tests of the Lottie exporter against the conventions verified
 * with lottie-web 5.13: layer/item paint order, key times, easing placement
 * and shape value formats. The render gate lives in lottieRender.test.ts.
 */

type L = Record<string, unknown>

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

function objectLayer(document: AnimatorDocument): ObjectLayer {
  const [layer] = document.layers
  if (!layer || layer.kind !== 'object') throw new Error('expected an object layer')
  return layer
}

function rectNode(overrides: Partial<PrimitiveNode> = {}): PrimitiveNode {
  return {
    id: 'r1',
    type: 'primitive',
    primitive: 'rect',
    center: { x: 40, y: 40 },
    width: 20,
    height: 10,
    rotation: 0,
    opacity: 1,
    fill: '#ff0000',
    ...overrides
  }
}

function imageNode(overrides: Partial<ImageNode> = {}): ImageNode {
  return {
    id: 'img1',
    type: 'image',
    center: { x: 100, y: 100 },
    width: 40,
    height: 20,
    rotation: 0,
    opacity: 1,
    resourceId: 'res-1',
    naturalWidth: 200,
    naturalHeight: 100,
    smoothing: true,
    ...overrides
  }
}

function pathNode(overrides: Partial<PathNode> = {}): PathNode {
  return {
    id: 'p1',
    name: 'tri',
    type: 'path',
    center: { x: 10, y: 5 },
    width: 20,
    height: 10,
    rotation: 0,
    opacity: 1,
    d: 'M0 0 L20 0 L20 10 Z',
    fill: '#0000ff',
    ...overrides
  }
}

/** A document with one path tweening from `TRIANGLE_D` toward `toD` over 0..10. */
function morphedPathDocument(toD: string, endFrame = 10): AnimatorDocument {
  const document = createDocument('demo', 320, 180, 12)
  const layer = objectLayer(document)
  layer.keyframes[0].nodes.push(pathNode())
  layer.keyframes[0].tween = { easing: 'ease-in' }
  const final = insertKeyframe(layer, endFrame)
  if (!final) throw new Error('expected the keyframe to be inserted')
  ;(final.nodes[0] as PathNode).d = toD
  return document
}

const TRIANGLE_SHAPE = {
  i: [
    [0, 0],
    [0, 0],
    [0, 0]
  ],
  o: [
    [0, 0],
    [0, 0],
    [0, 0]
  ],
  v: [
    [0, 0],
    [20, 0],
    [20, 10]
  ],
  c: true
}

/** A document with one rect tweening from (40,40) to (200,100) over 0..10. */
function tweenedDocument(easing: Easing = 'linear'): AnimatorDocument {
  const document = createDocument('demo', 320, 180, 12)
  const layer = objectLayer(document)
  layer.keyframes[0].nodes.push(rectNode())
  layer.keyframes[0].tween = { easing }
  const final = insertKeyframe(layer, 10)
  if (!final) throw new Error('expected the keyframe to be inserted')
  ;(final.nodes[0] as PrimitiveNode).center = { x: 200, y: 100 }
  return document
}

function deps(resolve: (resourceId: string) => string | null = () => DATA_URL): LottieBuildDeps {
  return { resolveResourceDataUrl: (resourceId) => Promise.resolve(resolve(resourceId)) }
}

function layersOf(lottie: Record<string, unknown>): L[] {
  return lottie.layers as L[]
}

function itemsOf(layer: L): L[] {
  const shapes = layer.shapes as L[]
  if (!shapes || shapes.length === 0) throw new Error('layer has no shapes group')
  return shapes[0].it as L[]
}

function itemOf(layer: L, ty: string): L {
  const item = itemsOf(layer).find((candidate) => candidate.ty === ty)
  if (!item) throw new Error(`no "${ty}" item in layer`)
  return item
}

function propOf(item: L, key: string): L {
  return item[key] as L
}

function keyedOf(item: L, key: string): Array<Record<string, unknown>> {
  const prop = propOf(item, key)
  if (prop.a !== 1 || !Array.isArray(prop.k)) throw new Error(`${String(item.ty)}.${key} is not keyed`)
  return prop.k as Array<Record<string, unknown>>
}

function staticKOf(item: L, key: string): unknown[] {
  const prop = propOf(item, key)
  if (prop.a !== 0 || !Array.isArray(prop.k)) throw new Error(`${String(item.ty)}.${key} is not a static array`)
  return prop.k as unknown[]
}

function assetsOf(lottie: Record<string, unknown>): L[] {
  return lottie.assets as L[]
}

describe('buildLottieAnimation — structure', () => {
  it('builds a root, a shape layer and property channels for a tweened rect', async () => {
    const { lottie, diagnostics } = await buildLottieAnimation(
      tweenedDocument(),
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([])
    expect(lottie.v).toBe('5.7.4')
    expect(lottie.fr).toBe(12)
    expect(lottie.ip).toBe(0)
    expect(lottie.op).toBe(11)
    expect(lottie.w).toBe(320)
    expect(lottie.h).toBe(180)
    expect(lottie.nm).toBe('demo')
    expect(lottie.ddd).toBe(0)
    expect(lottie.assets).toEqual([])

    const layers = layersOf(lottie)
    expect(layers).toHaveLength(1)
    const layer = layers[0]
    expect(layer.ty).toBe(4)
    expect(layer.ind).toBe(1)
    expect(layer.nm).toBe('Layer 1')
    expect(layer.ip).toBe(0)
    expect(layer.op).toBe(11)
    expect(layer.sr).toBe(1)

    expect(itemsOf(layer).map((item) => item.ty)).toEqual(['rc', 'fl', 'tr'])

    const rect = itemOf(layer, 'rc')
    expect(rect.nm).toBe('Layer 1')
    expect(rect.d).toBe(1)
    expect(propOf(rect, 'p')).toEqual({ a: 0, k: [0, 0] })
    expect(propOf(rect, 's')).toEqual({ a: 0, k: [20, 10] })
    expect(propOf(rect, 'r')).toEqual({ a: 0, k: 0 })

    expect(propOf(itemOf(layer, 'fl'), 'c')).toEqual({ a: 0, k: [1, 0, 0, 1] })

    const transform = itemOf(layer, 'tr')
    expect(propOf(transform, 'p')).toEqual({
      a: 1,
      k: [
        { t: 0, s: [40, 40], o: { x: 0, y: 0 }, i: { x: 1, y: 1 } },
        { t: 10, s: [200, 100], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } }
      ]
    })
    expect(staticKOf(transform, 'r')).toEqual([0])
    expect(staticKOf(transform, 's')).toEqual([100, 100])
    expect(staticKOf(transform, 'o')).toEqual([100])
    expect(staticKOf(transform, 'a')).toEqual([0, 0])
  })

  it('maps named easings to canonical beziers and custom beziers exactly', async () => {
    const easeIn = await buildLottieAnimation(
      tweenedDocument('ease-in'),
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    const easeInKeys = keyedOf(itemOf(layersOf(easeIn.lottie)[0], 'tr'), 'p')
    expect(easeInKeys[0]).toEqual({ t: 0, s: [40, 40], o: { x: 0.32, y: 0 }, i: { x: 0.67, y: 0 } })

    const custom = await buildLottieAnimation(
      tweenedDocument({ x1: 0.2, y1: 0.4, x2: 0.8, y2: 0.1 }),
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    const customKeys = keyedOf(itemOf(layersOf(custom.lottie)[0], 'tr'), 'p')
    expect(customKeys[0]).toEqual({ t: 0, s: [40, 40], o: { x: 0.2, y: 0.4 }, i: { x: 0.8, y: 0.1 } })
  })

  it('splits the easing and adds a successor key when the range starts mid-segment', async () => {
    const { lottie } = await buildLottieAnimation(
      tweenedDocument(),
      { fromFrame: 5, toFrame: 10, fps: 12 },
      deps()
    )
    expect(lottie.op).toBe(6)
    const keys = keyedOf(itemOf(layersOf(lottie)[0], 'tr'), 'p')
    expect(keys.map((key) => key.t)).toEqual([0, 5])
    // The first key samples the eased pose at doc frame 5, where the clip starts.
    expect(keys[0].s).toEqual([120, 70])
    expect(keys[0].o).toBeDefined()
    expect(keys[0].i).toBeDefined()
    expect(keys[1].s).toEqual([200, 100])
  })

  it('bakes hold keys sampled through the evaluator when the document uses a hold step', async () => {
    const document = tweenedDocument()
    document.holdStep = 2
    const { lottie } = await buildLottieAnimation(document, { fromFrame: 0, toFrame: 10, fps: 12 }, deps())
    const layer = layersOf(lottie)[0]
    expect(layer.ip).toBe(0)
    expect(layer.op).toBe(11)
    const keys = keyedOf(itemOf(layer, 'tr'), 'p')
    expect(keys.map((key) => key.t)).toEqual([0, 2, 4, 6, 8, 10])
    expect(keys.every((key) => key.h === 1)).toBe(true)
    expect(keys[3].s).toEqual([136, 76])
    expect(keys[5].s).toEqual([200, 100])
  })

  it('frames layer presence spans with ip/op and clips them to the export range', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const layer = objectLayer(document)
    layer.keyframes[0].nodes.push(rectNode({ id: 'early', name: 'early' }))
    layer.keyframes.push({
      frame: 4,
      nodes: [rectNode({ id: 'late', name: 'late', center: { x: 40, y: 40 } })]
    })
    layer.keyframes.push({
      frame: 7,
      nodes: [rectNode({ id: 'late', name: 'late', center: { x: 200, y: 100 } })]
    })
    layer.keyframes.sort((a, b) => a.frame - b.frame)

    const full = await buildLottieAnimation(document, { fromFrame: 0, toFrame: 10, fps: 12 }, deps())
    const fullLayers = layersOf(full.lottie)
    // lottie layer 0 is the topmost: the later node paints on top.
    expect(fullLayers.map((entry) => entry.nm)).toEqual(['late', 'early'])
    expect(fullLayers[1].ip).toBe(0)
    expect(fullLayers[1].op).toBe(1)
    expect(fullLayers[0].ip).toBe(4)
    expect(fullLayers[0].op).toBe(8)
    const lateKeys = keyedOf(itemOf(fullLayers[0], 'tr'), 'p')
    expect(lateKeys[0]).toEqual({ t: 4, s: [40, 40], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } })
    expect(lateKeys[1]).toEqual({ t: 7, s: [200, 100], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } })

    const clipped = await buildLottieAnimation(document, { fromFrame: 5, toFrame: 10, fps: 12 }, deps())
    const clippedLayers = layersOf(clipped.lottie)
    expect(clippedLayers).toHaveLength(1)
    expect(clippedLayers[0].nm).toBe('late')
    expect(clippedLayers[0].ip).toBe(0)
    expect(clippedLayers[0].op).toBe(3)
    const clippedKeys = keyedOf(itemOf(clippedLayers[0], 'tr'), 'p')
    expect(clippedKeys.map((key) => key.t)).toEqual([0, 2])
  })

  it('emits strokes before fills so strokes paint over fills', async () => {
    const document = createDocument('demo', 320, 180, 12)
    objectLayer(document).keyframes[0].nodes.push(
      rectNode({ primitive: 'ellipse', fill: '#00ff00', stroke: '#0000ff', strokeWidth: 3 })
    )
    const { lottie } = await buildLottieAnimation(document, { fromFrame: 0, toFrame: 0, fps: 12 }, deps())
    const layer = layersOf(lottie)[0]
    expect(itemsOf(layer).map((item) => item.ty)).toEqual(['el', 'st', 'fl', 'tr'])
    expect(propOf(itemOf(layer, 'st'), 'c')).toEqual({ a: 0, k: [0, 0, 1, 1] })
    expect(staticKOf(itemOf(layer, 'st'), 'w')).toEqual([3])
    expect(propOf(itemOf(layer, 'fl'), 'c')).toEqual({ a: 0, k: [0, 1, 0, 1] })
  })

  it('encodes path nodes as shape items with anchors and closed flags', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const path: PathNode = {
      id: 'p1',
      name: 'tri',
      type: 'path',
      center: { x: 10, y: 5 },
      width: 20,
      height: 10,
      rotation: 0,
      opacity: 1,
      d: 'M0 0 L20 0 L20 10 Z',
      fill: '#0000ff'
    }
    objectLayer(document).keyframes[0].nodes.push(path)
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 0, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([])
    const layer = layersOf(lottie)[0]
    expect(itemsOf(layer).map((item) => item.ty)).toEqual(['sh', 'fl', 'tr'])
    const shape = itemOf(layer, 'sh')
    expect(shape.d).toBe(1)
    expect(shape.nm).toBe('tri')
    expect(propOf(shape, 'ks')).toEqual({
      a: 0,
      k: {
        i: [
          [0, 0],
          [0, 0],
          [0, 0]
        ],
        o: [
          [0, 0],
          [0, 0],
          [0, 0]
        ],
        v: [
          [0, 0],
          [20, 0],
          [20, 10]
        ],
        c: true
      }
    })
  })

  it('emits group children reversed so the first child stays on top', async () => {
    const child = (id: string, x: number): PrimitiveNode =>
      rectNode({ id, center: { x, y: 10 }, width: 10, height: 10 })
    const group: GroupNode = {
      id: 'g1',
      name: 'group',
      type: 'group',
      center: { x: 20, y: 10 },
      width: 30,
      height: 10,
      rotation: 0,
      opacity: 1,
      children: [child('c1', 10), child('c2', 30)]
    }
    const document = createDocument('demo', 320, 180, 12)
    objectLayer(document).keyframes[0].nodes.push(group)
    const { lottie } = await buildLottieAnimation(document, { fromFrame: 0, toFrame: 0, fps: 12 }, deps())
    const items = itemsOf(layersOf(lottie)[0])
    expect(items.map((item) => item.nm)).toEqual(['c2', 'c1', 'transform'])
    expect(items.map((item) => item.ty)).toEqual(['gr', 'gr', 'tr'])
    expect((items[0].it as L[])[0].nm).toBe('c2')
    expect((items[1].it as L[])[0].nm).toBe('c1')
  })

  it('keeps the first pose plus a diagnostic when a node changes its object type', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const layer = objectLayer(document)
    layer.keyframes[0].nodes.push(rectNode())
    layer.keyframes[0].tween = { easing: 'linear' }
    const final = insertKeyframe(layer, 10)
    if (!final) throw new Error('expected the keyframe to be inserted')
    // Same id, different node type at the target key.
    final.nodes[0] = pathNode({ id: 'r1' })
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([
      '"Layer 1" changes its object type across keyframes; the Lottie file keeps the first pose.'
    ])
    // The node collapses to the first key: the rect stays static, no path
    // shape is emitted.
    expect(itemsOf(layersOf(lottie)[0]).map((item) => item.ty)).toEqual(['rc', 'fl', 'tr'])
  })

  it('keeps the first content plus a diagnostic when group children change', async () => {
    const child = (id: string, x: number): PrimitiveNode =>
      rectNode({ id, center: { x, y: 10 }, width: 10, height: 10 })
    const group: GroupNode = {
      id: 'g1',
      name: 'group',
      type: 'group',
      center: { x: 20, y: 10 },
      width: 30,
      height: 10,
      rotation: 0,
      opacity: 1,
      children: [child('c1', 10)]
    }
    const document = createDocument('demo', 320, 180, 12)
    const layer = objectLayer(document)
    layer.keyframes[0].nodes.push(group)
    layer.keyframes[0].tween = { easing: 'linear' }
    const final = insertKeyframe(layer, 10)
    if (!final) throw new Error('expected the keyframe to be inserted')
    ;(final.nodes[0] as GroupNode).children = [child('c1', 10), child('c2', 30)]
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([
      'Group "group" changes its children across keyframes; the Lottie file keeps the first content.'
    ])
    expect(itemsOf(layersOf(lottie)[0]).map((item) => item.nm)).toEqual(['c1', 'transform'])
  })
})

describe('buildLottieAnimation — path morphing', () => {
  const morphedShape = {
    i: [
      [0, 0],
      [0, 0],
      [0, 0]
    ],
    o: [
      [0, 0],
      [0, 0],
      [0, 0]
    ],
    v: [
      [0, 0],
      [30, 0],
      [30, 10]
    ],
    c: true
  }

  it('morphs a compatible path with s/e keys and the segment easing', async () => {
    const { lottie, diagnostics } = await buildLottieAnimation(
      morphedPathDocument('M0 0 L30 0 L30 10 Z'),
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([])
    const layer = layersOf(lottie)[0]
    expect(itemsOf(layer).map((item) => item.ty)).toEqual(['sh', 'fl', 'tr'])
    const shape = itemOf(layer, 'sh')
    expect(shape.d).toBe(1)
    expect(shape.nm).toBe('tri')
    const keys = keyedOf(shape, 'ks')
    expect(keys).toEqual([
      { t: 0, s: [TRIANGLE_SHAPE], e: [morphedShape], o: { x: 0.32, y: 0 }, i: { x: 0.67, y: 0 } },
      { t: 10, s: [morphedShape], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } }
    ])
  })

  it('holds the outline with a diagnostic when the anchor structures differ', async () => {
    const { lottie, diagnostics } = await buildLottieAnimation(
      morphedPathDocument('M0 0 L30 0'),
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([
      'The path data of "tri" cannot morph between keyframes (the anchor structure differs); the Lottie file holds the outline over those segments.'
    ])
    const shape = itemOf(layersOf(lottie)[0], 'sh')
    const open = {
      i: [
        [0, 0],
        [0, 0]
      ],
      o: [
        [0, 0],
        [0, 0]
      ],
      v: [
        [0, 0],
        [30, 0]
      ],
      c: false
    }
    expect(keyedOf(shape, 'ks')).toEqual([
      { t: 0, s: [TRIANGLE_SHAPE], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } },
      { t: 10, s: [open], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } }
    ])
  })

  it('keeps the first outline plus a diagnostic when the subpath count changes', async () => {
    const { lottie, diagnostics } = await buildLottieAnimation(
      morphedPathDocument('M0 0 L30 0 L30 10 Z M50 50 L60 50 L60 60 Z'),
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([
      'The path data of "tri" changes shape across keyframes; the Lottie file keeps the first outline.'
    ])
    const shape = itemOf(layersOf(lottie)[0], 'sh')
    expect(propOf(shape, 'ks')).toEqual({ a: 0, k: TRIANGLE_SHAPE })
  })

  it('morphs the clipped final segment through the successor key', async () => {
    const { lottie, diagnostics } = await buildLottieAnimation(
      morphedPathDocument('M0 0 L30 0 L30 10 Z', 20),
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([])
    const shape = itemOf(layersOf(lottie)[0], 'sh')
    expect(keyedOf(shape, 'ks')).toEqual([
      { t: 0, s: [TRIANGLE_SHAPE], e: [morphedShape], o: { x: 0.32, y: 0 }, i: { x: 0.67, y: 0 } },
      { t: 20, s: [morphedShape], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } }
    ])
  })
})

describe('buildLottieAnimation — images and drawing cells', () => {
  it('flattens image nodes into image layers with composed placement channels', async () => {
    const document = createDocument('demo', 320, 180, 12)
    objectLayer(document).keyframes[0].nodes.push(imageNode({ name: 'photo' }))
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 0, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([])
    expect(assetsOf(lottie)).toEqual([{ id: 'img_1', w: 200, h: 100, u: '', p: DATA_URL, e: 1 }])
    const layer = layersOf(lottie)[0]
    expect(layer.ty).toBe(2)
    expect(layer.nm).toBe('photo')
    expect(layer.refId).toBe('img_1')
    expect(layer.ip).toBe(0)
    expect(layer.op).toBe(1)
    expect(propOf(layer.ks as L, 'a')).toEqual({ a: 0, k: [100, 50] })
    expect(propOf(layer.ks as L, 'p')).toEqual({ a: 0, k: [100, 100] })
    expect(propOf(layer.ks as L, 's')).toEqual({ a: 0, k: [20, 20] })
  })

  it('reuses one asset for repeated resources and falls back to a placeholder when missing', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const nodes = objectLayer(document).keyframes[0].nodes
    nodes.push(imageNode({ id: 'i2', name: 'photo2' }))
    nodes.push(imageNode({ id: 'i1', name: 'photo1' }))
    nodes.push(imageNode({ id: 'i3', name: 'gone', resourceId: 'missing' }))
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 0, fps: 12 },
      deps((resourceId) => (resourceId === 'missing' ? null : DATA_URL))
    )
    expect(diagnostics).toEqual(['Image resource "missing" could not be resolved; a placeholder is exported.'])
    expect(assetsOf(lottie)).toHaveLength(1)
    const layers = layersOf(lottie)
    expect(layers).toHaveLength(3)
    expect(layers.map((layer) => layer.nm)).toEqual(['gone', 'photo1', 'photo2'])
    expect(layers[1].refId).toBe('img_1')
    expect(layers[2].refId).toBe('img_1')
    // The missing-resource node degrades to a dashed placeholder shape layer.
    expect(layers[0].ty).toBe(4)
    expect(itemsOf(layers[0]).map((item) => item.ty)).toEqual(['rc', 'fl', 'st', 'tr'])
    expect(propOf(itemOf(layers[0], 'rc'), 's')).toEqual({ a: 0, k: [200, 100] })
  })

  it('approximates image motion under rotated, non-uniformly scaled groups', async () => {
    const image = imageNode({ rotation: 45 })
    const group: GroupNode = {
      id: 'g1',
      name: 'group',
      type: 'group',
      center: { x: 50, y: 50 },
      width: 80,
      height: 20,
      rotation: 30,
      opacity: 1,
      children: [image]
    }
    const document = createDocument('demo', 320, 180, 12)
    objectLayer(document).keyframes[0].nodes.push(group)
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 0, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([
      'Image "Layer 1" sits under rotated, non-uniformly scaled groups; its motion is approximated in the Lottie file.'
    ])
    // The group shape layer plus the flattened image layer still export.
    expect(layersOf(lottie).map((layer) => layer.ty)).toEqual([2, 4])
  })

  it('exports drawing cells as full-stage image layers spanning their frame ranges', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const drawing = createDrawingLayer('paint')
    drawing.cells.push({ frame: 0, resourceId: 'res-1' })
    drawing.cells.push({ frame: 5, resourceId: 'res-2' })
    document.layers = [drawing]
    const { lottie } = await buildLottieAnimation(document, { fromFrame: 0, toFrame: 10, fps: 12 }, deps())
    expect(assetsOf(lottie).map((asset) => asset.id)).toEqual(['img_1', 'img_2'])
    expect(assetsOf(lottie)[0].w).toBe(320)
    expect(assetsOf(lottie)[0].h).toBe(180)
    const layers = layersOf(lottie)
    // The later cell paints on top: lottie layer 0.
    expect(layers[0].refId).toBe('img_2')
    expect(layers[0].ip).toBe(5)
    expect(layers[0].op).toBe(11)
    expect(layers[1].refId).toBe('img_1')
    expect(layers[1].ip).toBe(0)
    expect(layers[1].op).toBe(5)
    expect(propOf(layers[0].ks as L, 'a')).toEqual({ a: 0, k: [160, 90] })
    expect(propOf(layers[0].ks as L, 'p')).toEqual({ a: 0, k: [160, 90] })
    expect(propOf(layers[0].ks as L, 's')).toEqual({ a: 0, k: [100, 100] })
  })
})

describe('buildLottieAnimation — camera', () => {
  it('wraps content into a precomp with keyed camera channels', async () => {
    const document = createDocument('demo', 320, 180, 12)
    objectLayer(document).keyframes[0].nodes.push(rectNode())
    const camera = createCameraLayer('Camera')
    document.layers.push(camera)
    const first = insertCameraKeyframe(document, 0, { center: { x: 160, y: 90 }, zoom: 1.2, rotation: 30 })
    if (!first) throw new Error('expected the camera keyframe to be inserted')
    first.tween = { easing: 'linear' }
    insertCameraKeyframe(document, 10, { center: { x: 200, y: 100 }, zoom: 2, rotation: 90 })

    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([])
    const layers = layersOf(lottie)
    expect(layers).toHaveLength(1)
    const entry = layers[0]
    expect(entry.ty).toBe(0)
    expect(entry.nm).toBe('Camera')
    expect(entry.refId).toBe('precomp_main')
    expect(entry.w).toBe(320)
    expect(entry.h).toBe(180)
    expect(entry.ind).toBe(1)
    expect(entry.ip).toBe(0)
    expect(entry.op).toBe(11)
    const ks = entry.ks as L
    expect(propOf(ks, 'p')).toEqual({ a: 0, k: [160, 90] })
    expect(propOf(ks, 'a')).toEqual({
      a: 1,
      k: [
        { t: 0, s: [160, 90], o: { x: 0, y: 0 }, i: { x: 1, y: 1 } },
        { t: 10, s: [200, 100], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } }
      ]
    })
    expect(propOf(ks, 'r')).toEqual({
      a: 1,
      k: [
        { t: 0, s: [-30], o: { x: 0, y: 0 }, i: { x: 1, y: 1 } },
        { t: 10, s: [-90], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } }
      ]
    })
    expect(propOf(ks, 's')).toEqual({
      a: 1,
      k: [
        { t: 0, s: [120, 120], o: { x: 0, y: 0 }, i: { x: 1, y: 1 } },
        { t: 10, s: [200, 200], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } }
      ]
    })

    const precomp = assetsOf(lottie).find((asset) => asset.id === 'precomp_main')
    expect(precomp).toBeDefined()
    const content = precomp!.layers as L[]
    expect(content).toHaveLength(1)
    expect(content[0].ty).toBe(4)
  })

  it('skips the camera wrapper when there is no content to transform', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const camera = createCameraLayer('Camera')
    document.layers.push(camera)
    insertCameraKeyframe(document, 0)
    const { lottie } = await buildLottieAnimation(document, { fromFrame: 0, toFrame: 0, fps: 12 }, deps())
    expect(layersOf(lottie)).toEqual([])
    expect(assetsOf(lottie)).toEqual([])
  })
})

describe('buildLottieAnimation — text, paints and diagnostics', () => {
  const outline: PathNode = {
    id: 't1',
    type: 'path',
    center: { x: 100, y: 90 },
    width: 50,
    height: 20,
    rotation: 0,
    opacity: 1,
    d: 'M0 0 L50 0 L50 20 Z M5 5 L10 5 L10 10 Z',
    fill: '#ffcc00'
  }

  function textDocument(overrides: Partial<TextNode> = {}): AnimatorDocument {
    const document = createDocument('demo', 320, 180, 12)
    const text: TextNode = {
      id: 't1',
      type: 'text',
      center: { x: 100, y: 90 },
      width: 60,
      height: 30,
      rotation: 0,
      opacity: 1,
      text: 'Hi',
      fontFamily: 'Noto Sans',
      fontSize: 48,
      fontWeight: 400,
      fill: '#ffcc00',
      align: 'left',
      ...overrides
    }
    objectLayer(document).keyframes[0].nodes.push(text)
    return document
  }

  it('outlines text through the provider and emits its stroke over the outline', async () => {
    const { lottie, diagnostics } = await buildLottieAnimation(
      textDocument({ stroke: '#333333', strokeWidth: 2 }),
      { fromFrame: 0, toFrame: 0, fps: 12 },
      { ...deps(), outlineText: () => Promise.resolve(outline) }
    )
    expect(diagnostics).toEqual([])
    const layer = layersOf(lottie)[0]
    // Stroke items precede fill items so they paint on top, like the SVG
    // renderer — and both follow the outline geometry items.
    expect(itemsOf(layer).map((item) => item.ty)).toEqual(['sh', 'sh', 'st', 'fl', 'tr'])
    const shape = itemOf(layer, 'sh')
    expect(shape.nm).toBe('Hi 1')
    expect(propOf(shape, 'ks')).toEqual({
      a: 0,
      k: {
        i: [
          [0, 0],
          [0, 0],
          [0, 0]
        ],
        o: [
          [0, 0],
          [0, 0],
          [0, 0]
        ],
        v: [
          [0, 0],
          [50, 0],
          [50, 20]
        ],
        c: true
      }
    })
    // The outline maps 1:1 onto its natural glyph box, so the stage-space
    // stroke width passes through unchanged.
    const stroke = itemOf(layer, 'st')
    expect(staticKOf(stroke, 'w')).toEqual([2])
    expect(staticKOf(stroke, 'c')).toEqual([0.2, 0.2, 0.2, 1])
    expect(propOf(itemOf(layer, 'fl'), 'c')).toEqual({ a: 0, k: [1, 0.8, 0, 1] })
    expect(staticKOf(itemOf(layer, 'tr'), 's')).toEqual([100, 100])
  })

  it('degrades to a dashed placeholder plus a diagnostic when no outline is available', async () => {
    const { lottie, diagnostics } = await buildLottieAnimation(
      textDocument({ fontFamily: 'Missing Font' }),
      { fromFrame: 0, toFrame: 0, fps: 12 },
      { ...deps(), outlineText: () => Promise.resolve(null) }
    )
    expect(diagnostics).toEqual([
      'No font could be loaded for "Missing Font"; a placeholder box replaces "Hi" in the Lottie file.'
    ])
    const layer = layersOf(lottie)[0]
    expect(itemsOf(layer).map((item) => item.ty)).toEqual(['rc', 'fl', 'st', 'tr'])
    expect(propOf(itemOf(layer, 'rc'), 's')).toEqual({ a: 0, k: [60, 30] })
  })

  it('keeps the first outline plus a diagnostic when the text changes across keyframes', async () => {
    const document = textDocument()
    const layer = objectLayer(document)
    layer.keyframes[0].tween = { easing: 'linear' }
    const final = insertKeyframe(layer, 10)
    if (!final) throw new Error('expected the keyframe to be inserted')
    ;(final.nodes[0] as TextNode).text = 'Ho'
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 10, fps: 12 },
      { ...deps(), outlineText: () => Promise.resolve(outline) }
    )
    expect(diagnostics).toEqual([
      'Text "Hi" changes across keyframes; the Lottie file outlines the first pose.'
    ])
    expect(itemsOf(layersOf(lottie)[0])[0].nm).toBe('Hi 1')
  })

  it('emits gradient fills as gf items with box-space geometry and stops', async () => {
    const document = createDocument('demo', 320, 180, 12)
    objectLayer(document).keyframes[0].nodes.push(
      rectNode({
        fill: {
          type: 'linear',
          angle: 90,
          stops: [
            { offset: 0, color: '#ff0000' },
            { offset: 1, color: '#0000ff' }
          ]
        }
      })
    )
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 0, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([])
    const gf = itemOf(layersOf(lottie)[0], 'gf')
    expect(gf.t).toBe(1)
    expect(gf.nm).toBe('fill')
    expect(propOf(gf, 'o')).toEqual({ a: 0, k: 100 })
    // Rect 20×10, angle 90° (the renderer's y-down clockwise convention):
    // the axis spans the box height.
    expect(propOf(gf, 's')).toEqual({ a: 0, k: [0, -5] })
    expect(propOf(gf, 'e')).toEqual({ a: 0, k: [0, 5] })
    expect(propOf(gf, 'g')).toEqual({ p: 2, k: { a: 0, k: [0, 1, 0, 0, 1, 0, 0, 1] } })
  })

  it('folds radial stop alpha into the mirrored opacity section', async () => {
    const document = createDocument('demo', 320, 180, 12)
    objectLayer(document).keyframes[0].nodes.push(
      rectNode({
        fill: {
          type: 'radial',
          cx: 0.5,
          cy: 0.5,
          r: 0.5,
          stops: [
            { offset: 0, color: '#ffffff', alpha: 0.5 },
            { offset: 1, color: '#000000' }
          ]
        }
      })
    )
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 0, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([
      'The radial gradient of "Layer 1" sits on a non-square box; the Lottie file approximates its radius.'
    ])
    const gf = itemOf(layersOf(lottie)[0], 'gf')
    expect(gf.t).toBe(2)
    // Rect 20×10: center at the box middle, radius (20+10)/2 · 0.5 = 7.5.
    expect(propOf(gf, 's')).toEqual({ a: 0, k: [0, 0] })
    expect(propOf(gf, 'e')).toEqual({ a: 0, k: [7.5, 0] })
    // Colors [offset, r, g, b] × 2, then the mirrored [offset, alpha] × 2.
    expect(propOf(gf, 'g')).toEqual({
      p: 2,
      k: { a: 0, k: [0, 1, 1, 1, 1, 0, 0, 0, 0, 0.5, 1, 1] }
    })
  })

  it('bakes a tweened gradient per output frame', async () => {
    const document = tweenedDocument('linear')
    const layer = objectLayer(document)
    ;(layer.keyframes[0].nodes[0] as PrimitiveNode).fill = {
      type: 'linear',
      angle: 0,
      stops: [
        { offset: 0, color: '#000000' },
        { offset: 1, color: '#ffffff' }
      ]
    }
    ;(layer.keyframes[1]!.nodes[0] as PrimitiveNode).fill = {
      type: 'linear',
      angle: 90,
      stops: [
        { offset: 0, color: '#ff0000' },
        { offset: 1, color: '#0000ff' }
      ]
    }
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([])
    const gf = itemOf(layersOf(lottie)[0], 'gf')
    const startKeys = keyedOf(gf, 's')
    expect(startKeys).toHaveLength(11)
    expect(startKeys[0]).toEqual({ t: 0, s: [-10, 0], o: { x: 0, y: 0 }, i: { x: 1, y: 1 } })
    // Frame 10: angle 90° → s (0, −5); the final key holds.
    expect(startKeys[10]).toEqual({ t: 10, s: [0, -5], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } })
    const stopsProp = propOf(gf, 'g').k as L
    expect(stopsProp.a).toBe(1)
    const stopKeys = stopsProp.k as Array<Record<string, unknown>>
    expect(stopKeys).toHaveLength(11)
    expect(stopKeys[0].s).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
    expect(stopKeys[10].s).toEqual([0, 1, 0, 0, 1, 0, 0, 1])
  })

  it('keeps the first gradient with a diagnostic when the stop count changes', async () => {
    const document = tweenedDocument('linear')
    const layer = objectLayer(document)
    ;(layer.keyframes[0].nodes[0] as PrimitiveNode).fill = {
      type: 'linear',
      angle: 0,
      stops: [
        { offset: 0, color: '#000000' },
        { offset: 1, color: '#ffffff' }
      ]
    }
    ;(layer.keyframes[1]!.nodes[0] as PrimitiveNode).fill = {
      type: 'linear',
      angle: 0,
      stops: [
        { offset: 0, color: '#ff0000' },
        { offset: 0.5, color: '#00ff00' },
        { offset: 1, color: '#0000ff' }
      ]
    }
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([
      'The gradient of "Layer 1" changes its stop count across keyframes; the Lottie file keeps the first gradient.'
    ])
    const gf = itemOf(layersOf(lottie)[0], 'gf')
    expect(propOf(gf, 'g')).toEqual({ p: 2, k: { a: 0, k: [0, 0, 0, 0, 1, 1, 1, 1] } })
  })

  it('keeps the first paint with a diagnostic when the paint kind changes', async () => {
    const document = tweenedDocument('linear')
    const layer = objectLayer(document)
    ;(layer.keyframes[1]!.nodes[0] as PrimitiveNode).fill = {
      type: 'linear',
      angle: 0,
      stops: [
        { offset: 0, color: '#ff0000' },
        { offset: 1, color: '#0000ff' }
      ]
    }
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([
      'The paint of "Layer 1" changes between solid and gradient across keyframes; the Lottie file keeps the first paint.'
    ])
    // The first keyframe's solid fill holds statically.
    expect(propOf(itemOf(layersOf(lottie)[0], 'fl'), 'c')).toEqual({ a: 0, k: [1, 0, 0, 1] })
  })

  it('emits gradient strokes as gs items with the width channel', async () => {
    const document = createDocument('demo', 320, 180, 12)
    objectLayer(document).keyframes[0].nodes.push(
      rectNode({
        stroke: {
          type: 'linear',
          angle: 0,
          stops: [
            { offset: 0, color: '#111111' },
            { offset: 1, color: '#eeeeee' }
          ]
        },
        strokeWidth: 4
      })
    )
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 0, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([])
    const layer = layersOf(lottie)[0]
    expect(itemsOf(layer).map((item) => item.ty)).toEqual(['rc', 'gs', 'fl', 'tr'])
    const gs = itemOf(layer, 'gs')
    expect(staticKOf(gs, 'w')).toEqual([4])
    expect(propOf(gs, 's')).toEqual({ a: 0, k: [-10, 0] })
    expect(propOf(gs, 'e')).toEqual({ a: 0, k: [10, 0] })
  })

  it('bakes a smooth tween path per output frame from the evaluator', async () => {
    const document = tweenedDocument('ease-out')
    objectLayer(document).keyframes[0].tween = { easing: 'ease-out', path: 'smooth' }
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([])
    const keys = keyedOf(itemOf(layersOf(lottie)[0], 'tr'), 'p')
    expect(keys).toHaveLength(11)
    expect(keys[0]).toEqual({ t: 0, s: [40, 40], o: { x: 0, y: 0 }, i: { x: 1, y: 1 } })
    expect(keys[10]).toEqual({ t: 10, s: [200, 100], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } })
    // Every baked key equals the evaluator's pose at that frame.
    const pose = evaluateLayerAtFrame(objectLayer(document), 5)[0]
    const round = (value: number): number => Math.round(value * 1e4) / 1e4
    expect(keys[5].s).toEqual([round(pose.center.x), round(pose.center.y)])
  })

  it('emits audio layers with an embedded asset and a seconds time-remap ramp', async () => {
    const document = createDocument('demo', 320, 180, 12)
    objectLayer(document).keyframes[0].nodes.push(rectNode())
    const audio = createAudioLayer('res-audio', 'Music')
    audio.volume = 0.5
    document.layers.push(audio)
    const bytes = new Uint8Array([1, 2, 3, 4])
    const { lottie, diagnostics, files } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 4, fps: 12 },
      { ...deps(), resolveResourceBytes: () => Promise.resolve({ bytes, ext: 'mp3' }) }
    )
    expect(diagnostics).toEqual([])
    expect(files).toBeUndefined()
    const layers = layersOf(lottie)
    expect(layers.map((layer) => layer.ty)).toEqual([4, 6])
    const audioLayer = layers[1]
    expect(audioLayer.nm).toBe('Music')
    expect(audioLayer.ind).toBe(2)
    expect(audioLayer.refId).toBe('aud_1')
    expect(audioLayer.ip).toBe(0)
    expect(audioLayer.op).toBe(5)
    expect(audioLayer.st).toBe(0)
    expect(audioLayer.au).toEqual({ lv: { a: 0, k: [50] } })
    // `tm` is the clip position in SECONDS: 0 → 4/12 across the comp.
    expect(propOf(audioLayer, 'tm')).toEqual({
      a: 1,
      k: [
        { t: 0, s: [0], o: { x: 0, y: 0 }, i: { x: 1, y: 1 } },
        { t: 4, s: [0.3333], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } }
      ]
    })
    expect(assetsOf(lottie).find((asset) => asset.id === 'aud_1')).toEqual({
      id: 'aud_1',
      u: '',
      p: 'data:audio/mpeg;base64,AQIDBA==',
      e: 1
    })
  })

  it('offsets a clip that starts before the export range into the time remap', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const audio = createAudioLayer('res-audio', 'Music')
    audio.startFrame = 0
    document.layers.push(audio)
    const { lottie } = await buildLottieAnimation(
      document,
      { fromFrame: 2, toFrame: 4, fps: 12 },
      { ...deps(), resolveResourceBytes: () => Promise.resolve({ bytes: new Uint8Array([9]), ext: 'wav' }) }
    )
    const audioLayer = layersOf(lottie)[0]
    expect(audioLayer.ty).toBe(6)
    expect(audioLayer.ip).toBe(0)
    expect(propOf(audioLayer, 'tm')).toEqual({
      a: 1,
      k: [
        { t: 0, s: [0.1667], o: { x: 0, y: 0 }, i: { x: 1, y: 1 } },
        { t: 2, s: [0.3333], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } }
      ]
    })
  })

  it("ships audio as side files in 'files' mode with the bytes in the result", async () => {
    const document = createDocument('demo', 320, 180, 12)
    objectLayer(document).keyframes[0].nodes.push(rectNode())
    const audio = createAudioLayer('res-audio', 'Music')
    audio.startFrame = 2
    document.layers.push(audio)
    const bytes = new Uint8Array([7, 7])
    const { lottie, diagnostics, files } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 4, fps: 12, audio: 'files' },
      { ...deps(), resolveResourceBytes: () => Promise.resolve({ bytes, ext: 'MP3' }) }
    )
    expect(diagnostics).toEqual([])
    expect(files).toEqual({ 'audio/aud_1.mp3': bytes })
    const audioLayer = layersOf(lottie).find((layer) => layer.ty === 6)!
    expect(audioLayer.refId).toBe('aud_1')
    expect(audioLayer.ip).toBe(2)
    expect(assetsOf(lottie).find((asset) => asset.id === 'aud_1')).toEqual({
      id: 'aud_1',
      u: 'audio/',
      p: 'aud_1.mp3',
      e: 0
    })
  })

  it('reports an unresolvable audio resource once and stays silent', async () => {
    const document = createDocument('demo', 320, 180, 12)
    objectLayer(document).keyframes[0].nodes.push(rectNode())
    document.layers.push(createAudioLayer('res-audio', 'Music'))
    document.layers.push(createAudioLayer('res-audio', 'Music copy'))
    const { lottie, diagnostics } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 0, fps: 12 },
      deps()
    )
    expect(diagnostics).toEqual([
      'Audio resource "res-audio" could not be embedded; the exported animation is silent.'
    ])
    expect(layersOf(lottie).map((layer) => layer.ty)).toEqual([4])
  })
})

describe('serializeLottie and packDotLottie', () => {
  it('serializes deterministically as pretty-printed UTF-8 JSON', async () => {
    const { lottie } = await buildLottieAnimation(
      tweenedDocument(),
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    const first = serializeLottie(lottie)
    const second = serializeLottie(lottie)
    expect(first).toEqual(second)
    const text = strFromU8(first)
    expect(text).toBe(JSON.stringify(lottie, null, 2))
    expect(JSON.parse(text)).toEqual(lottie)
  })

  it('packs a dotLottie archive with the manifest and animation entry', async () => {
    const { lottie } = await buildLottieAnimation(
      tweenedDocument(),
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    const entries = unzipSync(packDotLottie(lottie, '0.18.0'))
    expect(Object.keys(entries).sort()).toEqual(['animations/animation.json', 'manifest.json'])
    expect(JSON.parse(strFromU8(entries['animations/animation.json']))).toEqual(lottie)
    expect(JSON.parse(strFromU8(entries['manifest.json']))).toEqual({
      version: '1.0',
      generator: 'OpenAnimator 0.18.0',
      animations: [{ id: 'openanimator', loop: true }]
    })

    const unnamed = unzipSync(packDotLottie(lottie))
    expect(JSON.parse(strFromU8(unnamed['manifest.json'])).generator).toBe('OpenAnimator')
  })

  it('merges side files into the dotLottie archive', async () => {
    const { lottie } = await buildLottieAnimation(
      tweenedDocument(),
      { fromFrame: 0, toFrame: 10, fps: 12 },
      deps()
    )
    const files = { 'audio/aud_1.mp3': new Uint8Array([1, 2, 3]) }
    const entries = unzipSync(packDotLottie(lottie, '0.26.0', files))
    expect(Object.keys(entries).sort()).toEqual([
      'animations/animation.json',
      'audio/aud_1.mp3',
      'manifest.json'
    ])
    expect(entries['audio/aud_1.mp3']).toEqual(files['audio/aud_1.mp3'])
  })
})

// ---------------------------------------------------------------------------
// Golden file
// ---------------------------------------------------------------------------

const GOLDEN_PATH = fileURLToPath(new URL('./fixtures/export/lottie-basic.golden.json', import.meta.url))

const PHOTO_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
const DRAW_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgABAA=='

function goldenDocument(): AnimatorDocument {
  const document = createDocument('golden', 320, 180, 12)

  const layer = objectLayer(document)
  layer.keyframes[0].nodes.push(rectNode({ id: 'r1', name: 'hero' }))
  layer.keyframes[0].nodes.push(imageNode({ id: 'img1', name: 'photo', resourceId: 'res-photo' }))
  layer.keyframes[0].tween = { easing: 'ease-in' }
  const mid = insertKeyframe(layer, 6)
  const final = insertKeyframe(layer, 10)
  if (!mid || !final) throw new Error('expected the keyframes to be inserted')
  ;(mid.nodes[0] as PrimitiveNode).center = { x: 200, y: 100 }
  mid.tween = { easing: { x1: 0.2, y1: 0.4, x2: 0.8, y2: 0.1 } }
  ;(final.nodes[0] as PrimitiveNode).center = { x: 250, y: 50 }

  const holdLayer = createLayer('Hold')
  holdLayer.keyframes.push(
    {
      frame: 0,
      nodes: [
        rectNode({ id: 'e1', name: 'badge', primitive: 'ellipse', width: 30, height: 30, center: { x: 80, y: 120 } })
      ]
    },
    {
      frame: 2,
      nodes: [
        rectNode({ id: 'e1', name: 'badge', primitive: 'ellipse', width: 30, height: 30, center: { x: 100, y: 120 } })
      ]
    }
  )
  document.layers.push(holdLayer)

  const drawing = createDrawingLayer('paint')
  drawing.cells.push({ frame: 3, resourceId: 'res-draw' })
  document.layers.push(drawing)

  // A gradient that interpolates across keyframes (baked per output frame,
  // with a fading stop alpha) and an audio layer (embedded data URI).
  const gradientLayer = createLayer('Grad')
  const gradientNode = (fill: PrimitiveNode['fill']): PrimitiveNode =>
    rectNode({ id: 'g1', name: 'grading', center: { x: 60, y: 40 }, width: 40, height: 40, fill })
  gradientLayer.keyframes.push(
    {
      frame: 0,
      nodes: [
        gradientNode({
          type: 'linear',
          angle: 0,
          stops: [
            { offset: 0, color: '#38bdf8' },
            { offset: 1, color: '#1e3a8a', alpha: 0.5 }
          ]
        })
      ],
      tween: { easing: 'ease-in-out' }
    },
    {
      frame: 10,
      nodes: [
        gradientNode({
          type: 'linear',
          angle: 180,
          stops: [
            { offset: 0, color: '#f97316' },
            { offset: 1, color: '#7c2d12' }
          ]
        })
      ]
    }
  )
  document.layers.push(gradientLayer)

  const audio = createAudioLayer('res-song', 'song')
  audio.volume = 0.8
  document.layers.push(audio)

  const camera = createCameraLayer('Camera')
  document.layers.push(camera)
  const camFirst = insertCameraKeyframe(document, 0, { center: { x: 160, y: 90 }, zoom: 1.2, rotation: 30 })
  if (!camFirst) throw new Error('expected the camera keyframe to be inserted')
  camFirst.tween = { easing: 'linear' }
  insertCameraKeyframe(document, 10, { center: { x: 200, y: 100 }, zoom: 2, rotation: 90 })

  return document
}

describe('lottie golden file', () => {
  it('matches the checked-in fixture (regenerate with UPDATE_GOLDEN=1)', async () => {
    const { lottie, diagnostics } = await buildLottieAnimation(
      goldenDocument(),
      { fromFrame: 0, toFrame: 10, fps: 12 },
      {
        ...deps((resourceId) => (resourceId === 'res-draw' ? DRAW_URL : PHOTO_URL)),
        resolveResourceBytes: () =>
          Promise.resolve({ bytes: new Uint8Array([82, 73, 70, 70]), ext: 'wav' })
      }
    )
    expect(diagnostics).toEqual([])
    const text = strFromU8(serializeLottie(lottie))
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true })
      writeFileSync(GOLDEN_PATH, text)
    }
    const golden = readFileSync(GOLDEN_PATH, 'utf8')
    expect(text).toBe(golden)
  })
})
