import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  createAudioLayer,
  createCameraLayer,
  createDocument,
  createDrawingLayer,
  createLayer,
  insertCameraKeyframe,
  insertKeyframe
} from './document'
import type { SvgAnimationDeps, SvgAnimationOptions } from './exportSvgAnimation'
import { exportAnimatedSvg } from './exportSvgAnimation'
import type { AnimatorDocument, GroupNode, ImageNode, PathNode, PrimitiveNode, TextNode } from './model'

/**
 * Animated-SVG exporter tests: baked CSS-keyframes output — percentages and
 * sampled values against the shared evaluator, static-document passthrough,
 * backdrop/scale options, text outlines, image embedding, the camera wrapper
 * and the degradation diagnostics. A golden file pins the full markup.
 */

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

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

function objectLayerOf(document: AnimatorDocument) {
  const [layer] = document.layers
  if (!layer || layer.kind !== 'object') throw new Error('expected an object layer')
  return layer
}

function tweenedDocument(): AnimatorDocument {
  const document = createDocument('demo', 320, 180, 12)
  const layer = objectLayerOf(document)
  layer.keyframes[0].nodes.push(rectNode())
  layer.keyframes[0].tween = { easing: 'linear' }
  const final = insertKeyframe(layer, 10)
  if (!final) throw new Error('expected the keyframe to be inserted')
  ;(final.nodes[0] as PrimitiveNode).center = { x: 200, y: 100 }
  return document
}

function deps(overrides: Partial<SvgAnimationDeps> = {}): SvgAnimationDeps {
  return {
    resolveResourceDataUrl: () => Promise.resolve(DATA_URL),
    ...overrides
  }
}

const RANGE: SvgAnimationOptions = { fromFrame: 0, toFrame: 10, fps: 12, scale: 1, transparent: false }

describe('exportAnimatedSvg', () => {
  it('bakes per-frame keyframes and the animation rule for a tweened rect', async () => {
    const { svg, diagnostics } = await exportAnimatedSvg(tweenedDocument(), RANGE, deps())
    expect(diagnostics).toEqual([])
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('viewBox="0 0 320 180"')
    expect(svg).toContain('<rect x="0" y="0" width="320" height="180" fill="#10151b"/>')
    expect(svg).toContain('<rect x="-10" y="-5" width="20" height="10" fill="#ff0000" transform="translate(40 40) rotate(0)" opacity="1" id="oa-i-1"/>')
    expect(svg).toContain('#oa-i-1{animation:oa-k-1 0.9167s linear infinite;transform-box:view-box;transform-origin:0 0}')
    expect(svg).toContain('@keyframes oa-k-1{')
    expect(svg).toContain('0%{transform:translate(40px, 40px) rotate(0deg) scale(1, 1)}')
    expect(svg).toContain('45.4545%{transform:translate(120px, 70px) rotate(0deg) scale(1, 1)}')
    expect(svg).toContain('90.9091%{transform:translate(200px, 100px) rotate(0deg) scale(1, 1)}')
    expect(svg).toContain(
      '100%{transform:translate(200px, 100px) rotate(0deg) scale(1, 1)}}'
    )
  })

  it('emits no style block at all for a static document', async () => {
    const document = createDocument('demo', 320, 180, 12)
    objectLayerOf(document).keyframes[0].nodes.push(rectNode())
    const { svg } = await exportAnimatedSvg(
      document,
      { ...RANGE, toFrame: 0 },
      deps()
    )
    expect(svg).not.toContain('<style>')
    expect(svg).not.toContain('id="oa-i-')
    expect(svg).toContain('<rect x="-10" y="-5" width="20" height="10" fill="#ff0000" transform="translate(40 40) rotate(0)" opacity="1"/>')
  })

  it('omits the backdrop when transparent and scales the outer size', async () => {
    const document = tweenedDocument()
    const hidden = await exportAnimatedSvg(document, { ...RANGE, transparent: true }, deps())
    expect(hidden.svg).not.toContain('fill="#10151b"')

    const scaled = await exportAnimatedSvg(document, { ...RANGE, scale: 2 }, deps())
    expect(scaled.svg).toContain('width="640"')
    expect(scaled.svg).toContain('height="360"')
    expect(scaled.svg).toContain('viewBox="0 0 320 180"')
  })

  it('outlines text through the provider and degrades to a placeholder without one', async () => {
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
    const withText = (fontFamily: string): AnimatorDocument => {
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
        fontFamily,
        fontSize: 48,
        fontWeight: 400,
        fill: '#ffcc00',
        align: 'left'
      }
      objectLayerOf(document).keyframes[0].nodes.push(text)
      return document
    }

    const outlined = await exportAnimatedSvg(
      withText('Noto Sans'),
      { ...RANGE, toFrame: 0 },
      deps({ outlineText: () => Promise.resolve(outline) })
    )
    expect(outlined.diagnostics).toEqual([])
    expect(outlined.svg).toContain('<path d="M0 0 L50 0 L50 20 Z M5 5 L10 5 L10 10 Z"')
    expect(outlined.svg).toContain('fill="#ffcc00"')

    const missing = await exportAnimatedSvg(
      withText('Missing Font'),
      { ...RANGE, toFrame: 0 },
      deps({ outlineText: () => Promise.resolve(null) })
    )
    expect(missing.diagnostics).toEqual([
      'No font could be loaded for "Missing Font"; a placeholder box replaces "Hi" in the animated SVG.'
    ])
    expect(missing.svg).toContain('stroke-dasharray="4 4"')
    expect(missing.svg).toContain('fill="none"')
  })

  it('embeds resolved image resources and reports missing ones', async () => {
    const withImage = (resourceId: string, smoothing: boolean): AnimatorDocument => {
      const document = createDocument('demo', 320, 180, 12)
      const image: ImageNode = {
        id: 'i1',
        type: 'image',
        center: { x: 100, y: 100 },
        width: 40,
        height: 20,
        rotation: 0,
        opacity: 1,
        resourceId,
        naturalWidth: 200,
        naturalHeight: 100,
        smoothing
      }
      objectLayerOf(document).keyframes[0].nodes.push(image)
      return document
    }

    const resolved = await exportAnimatedSvg(
      withImage('res-1', false),
      { ...RANGE, toFrame: 0 },
      deps()
    )
    expect(resolved.diagnostics).toEqual([])
    expect(resolved.svg).toContain('href="data:image/png;base64,iVBORw0KGgo="')
    expect(resolved.svg).toContain('width="40" height="20"')
    expect(resolved.svg).toContain('preserveAspectRatio="none"')
    expect(resolved.svg).toContain('image-rendering: pixelated')

    const missing = await exportAnimatedSvg(
      withImage('gone', true),
      { ...RANGE, toFrame: 0 },
      deps({ resolveResourceDataUrl: () => Promise.resolve(null) })
    )
    expect(missing.diagnostics).toEqual([
      'The resource of "Layer 1" is missing; a placeholder box is shown in the animated SVG.'
    ])
    expect(missing.svg).toContain('stroke-dasharray="4 4"')
  })

  it('wraps the output in an animated camera group', async () => {
    const document = tweenedDocument()
    const camera = createCameraLayer('Camera')
    document.layers.push(camera)
    const first = insertCameraKeyframe(document, 0, { center: { x: 160, y: 90 }, zoom: 1.2, rotation: 30 })
    if (!first) throw new Error('expected the camera keyframe to be inserted')
    first.tween = { easing: 'linear' }
    insertCameraKeyframe(document, 10, { center: { x: 200, y: 100 }, zoom: 2, rotation: 90 })

    const { svg, diagnostics } = await exportAnimatedSvg(document, RANGE, deps())
    expect(diagnostics).toEqual([])
    expect(svg).toContain('<g id="oa-i-2" transform="translate(160 90) rotate(-30) scale(1.2) translate(-160 -90)">')
    expect(svg).toContain('#oa-i-2{animation:oa-k-2 0.9167s linear infinite;transform-box:view-box;transform-origin:0 0}')
    expect(svg).toContain('45.4545%{transform:translate(160px, 90px) rotate(-60deg) scale(1.6) translate(-180px, -95px)}')
    expect(svg).toMatch(/<g id="oa-i-2"[^>]*>.*<\/g><\/svg>/)
  })

  it('freezes changing gradients at their first appearance with a diagnostic', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const layer = objectLayerOf(document)
    layer.keyframes[0].nodes.push(
      rectNode({
        name: 'tint',
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
    layer.keyframes[0].tween = { easing: 'linear' }
    const final = insertKeyframe(layer, 10)
    if (!final) throw new Error('expected the keyframe to be inserted')
    final.nodes[0] = rectNode({
      name: 'tint',
      center: { x: 200, y: 100 },
      fill: {
        type: 'linear',
        angle: 0,
        stops: [
          { offset: 0, color: '#00ff00' },
          { offset: 1, color: '#000000' }
        ]
      }
    })

    const { svg, diagnostics } = await exportAnimatedSvg(document, RANGE, deps())
    expect(diagnostics).toEqual([
      'A gradient paint in "tint" changes over time; the animated SVG keeps its first appearance.'
    ])
    expect(svg).toContain('<linearGradient ')
    expect(svg).toMatch(/fill="url\(#oa-grad-[0-9a-z]+\)"/)
  })

  it('keeps the first paint order with a diagnostic when group children reorder', async () => {
    const child = (id: string, x: number): PrimitiveNode =>
      rectNode({ id, center: { x, y: 10 }, width: 10, height: 10 })
    const group: GroupNode = {
      id: 'g1',
      name: 'stack',
      type: 'group',
      center: { x: 20, y: 10 },
      width: 30,
      height: 10,
      rotation: 0,
      opacity: 1,
      children: [child('c1', 10), child('c2', 30)]
    }
    const document = createDocument('demo', 320, 180, 12)
    const layer = objectLayerOf(document)
    layer.keyframes[0].nodes.push(group)
    layer.keyframes[0].tween = { easing: 'linear' }
    const final = insertKeyframe(layer, 10)
    if (!final) throw new Error('expected the keyframe to be inserted')
    ;(final.nodes[0] as GroupNode).children = [child('c2', 30), child('c1', 10)]

    const { svg, diagnostics } = await exportAnimatedSvg(document, RANGE, deps())
    expect(diagnostics).toEqual([
      'The paint order of "stack" changes across frames; the animated SVG keeps the first order.'
    ])
    const c1 = svg.indexOf('translate(10 10)')
    const c2 = svg.indexOf('translate(30 10)')
    expect(c1).toBeGreaterThan(-1)
    expect(c1).toBeLessThan(c2)
  })

  it('keeps the first appearance with a diagnostic when a node changes its object type', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const layer = objectLayerOf(document)
    layer.keyframes[0].nodes.push(rectNode())
    layer.keyframes[0].tween = { easing: 'linear' }
    const final = insertKeyframe(layer, 10)
    if (!final) throw new Error('expected the keyframe to be inserted')
    // Same id, different node type at the target key.
    final.nodes[0] = {
      id: 'r1',
      type: 'path',
      center: { x: 40, y: 40 },
      width: 20,
      height: 10,
      rotation: 0,
      opacity: 1,
      d: 'M0 0 L20 0 L20 10 Z',
      fill: '#ff0000'
    }

    const { svg, diagnostics } = await exportAnimatedSvg(document, RANGE, deps())
    expect(diagnostics).toEqual([
      '"Layer 1" changes its object type across frames; the animated SVG keeps the first appearance.'
    ])
    // The rect keeps its first pose and hides at the last frame (the
    // replacement is not walked); no path data is recorded.
    expect(svg).toContain(
      '<rect x="-10" y="-5" width="20" height="10" fill="#ff0000" transform="translate(40 40) rotate(0)" opacity="1" id="oa-i-1"/>'
    )
    expect(svg).toContain('@keyframes oa-k-1{0%{visibility:visible}90.9091%{visibility:hidden}100%{visibility:hidden}}')
    expect(svg).not.toContain('d="M0 0 L20 0 L20 10 Z"')
  })

  it('keeps the first outline with a diagnostic when text changes across frames', async () => {
    const outline: PathNode = {
      id: 't1',
      type: 'path',
      center: { x: 100, y: 90 },
      width: 50,
      height: 20,
      rotation: 0,
      opacity: 1,
      d: 'M0 0 L50 0 L50 20 Z',
      fill: '#ffcc00'
    }
    const document = createDocument('demo', 320, 180, 12)
    const layer = objectLayerOf(document)
    layer.keyframes[0].nodes.push({
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
      align: 'left'
    })
    layer.keyframes[0].tween = { easing: 'linear' }
    const final = insertKeyframe(layer, 10)
    if (!final) throw new Error('expected the keyframe to be inserted')
    ;(final.nodes[0] as TextNode).text = 'Ho'

    const { svg, diagnostics } = await exportAnimatedSvg(
      document,
      RANGE,
      deps({ outlineText: () => Promise.resolve(outline) })
    )
    expect(diagnostics).toEqual([
      'Text "Hi" changes across frames; the animated SVG keeps the first outline.'
    ])
    expect(svg).toContain('d="M0 0 L50 0 L50 20 Z"')
  })

  it('reports a dropped text stroke when text exports as outlines', async () => {
    const outline: PathNode = {
      id: 't1',
      type: 'path',
      center: { x: 100, y: 90 },
      width: 50,
      height: 20,
      rotation: 0,
      opacity: 1,
      d: 'M0 0 L50 0 L50 20 Z',
      fill: '#ffcc00'
    }
    const document = createDocument('demo', 320, 180, 12)
    const layer = objectLayerOf(document)
    layer.keyframes[0].nodes.push({
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
      stroke: '#000000',
      strokeWidth: 2
    })

    const { svg, diagnostics } = await exportAnimatedSvg(
      document,
      { ...RANGE, toFrame: 0 },
      deps({ outlineText: () => Promise.resolve(outline) })
    )
    expect(diagnostics).toEqual([
      'A text stroke is dropped when text is exported as outlines in the animated SVG.'
    ])
    expect(svg).toContain('d="M0 0 L50 0 L50 20 Z"')
    expect(svg).not.toContain('stroke="#000000"')
  })

  it('morphs path data per frame and reports dropped audio', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const layer = objectLayerOf(document)
    const path = (d: string): PathNode => ({
      id: 'p1',
      name: 'blob',
      type: 'path',
      center: { x: 10, y: 5 },
      width: 20,
      height: 10,
      rotation: 0,
      opacity: 1,
      d,
      fill: '#0000ff'
    })
    layer.keyframes[0].nodes.push(path('M0 0 L20 0 L20 10 Z'))
    layer.keyframes[0].tween = { easing: 'linear' }
    const final = insertKeyframe(layer, 10)
    if (!final) throw new Error('expected the keyframe to be inserted')
    final.nodes[0] = path('M0 0 L30 0 L30 10 Z')
    document.layers.push(createAudioLayer('res-audio', 'Music'))

    const { svg, diagnostics } = await exportAnimatedSvg(document, RANGE, deps())
    expect(diagnostics).toEqual([
      'Audio is not included in animated SVG exports; the exported animation is silent.'
    ])
    // The first shape stays as the static fallback; the morph is a SMIL
    // series of canonical (centered, explicitly-closed) per-frame strings.
    expect(svg).toContain('d="M0 0 L20 0 L20 10 Z"')
    expect(svg).not.toContain('d="M0 0 L30 0 L30 10 Z"')
    expect(svg).toContain('<animate attributeName="d"')
    expect(svg).toContain('calcMode="linear"')
    const values = /<animate[^>]*values="([^"]+)"/.exec(svg)?.[1].split(';')
    expect(values).toHaveLength(11)
    expect(values?.[0]).toBe('M-10 -5L10 -5L10 5L-10 -5Z')
    expect(values?.[5]).toBe('M-12.5 -5L12.5 -5L12.5 5L-12.5 -5Z')
    expect(values?.[10]).toBe('M-15 -5L15 -5L15 5L-15 -5Z')
  })

  it('steps incompatible path changes discretely', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const layer = objectLayerOf(document)
    const path = (d: string): PathNode => ({
      id: 'p1',
      name: 'blob',
      type: 'path',
      center: { x: 10, y: 5 },
      width: 20,
      height: 10,
      rotation: 0,
      opacity: 1,
      d,
      fill: '#0000ff'
    })
    layer.keyframes[0].nodes.push(path('M0 0 L20 0 L20 10 Z'))
    layer.keyframes[0].tween = { easing: 'linear' }
    const final = insertKeyframe(layer, 10)
    if (!final) throw new Error('expected the keyframe to be inserted')
    final.nodes[0] = path('M0 0 L30 0')
    const { svg, diagnostics } = await exportAnimatedSvg(document, RANGE, deps())
    expect(diagnostics).toEqual([])
    expect(svg).toContain('calcMode="discrete"')
    const values = /<animate[^>]*values="([^"]+)"/.exec(svg)?.[1].split(';')
    expect(values).toHaveLength(11)
    // The snap fallback holds `from` through the tween and jumps at the end.
    expect(values?.[0]).toBe('M0 0 L20 0 L20 10 Z')
    expect(values?.[9]).toBe('M0 0 L20 0 L20 10 Z')
    expect(values?.[10]).toBe('M0 0 L30 0')
  })

  it('leaves static path documents without a SMIL element', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const layer = objectLayerOf(document)
    layer.keyframes[0].nodes.push({
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
    })
    const { svg, diagnostics } = await exportAnimatedSvg(document, RANGE, deps())
    expect(diagnostics).toEqual([])
    expect(svg).not.toContain('<animate')
    expect(svg).toContain('d="M0 0 L20 0 L20 10 Z"')
  })
})

// ---------------------------------------------------------------------------
// Golden file
// ---------------------------------------------------------------------------

const GOLDEN_PATH = fileURLToPath(new URL('./fixtures/export/svg-animation-basic.golden.svg', import.meta.url))

const PHOTO_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
const DRAW_A_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgABAA=='
const DRAW_B_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgACAA=='

function goldenDocument(): AnimatorDocument {
  const document = createDocument('golden', 320, 180, 12)

  const layer = objectLayerOf(document)
  layer.keyframes[0].nodes.push(rectNode({ id: 'r1', name: 'hero' }))
  layer.keyframes[0].nodes.push({
    id: 'img1',
    name: 'photo',
    type: 'image',
    center: { x: 100, y: 100 },
    width: 40,
    height: 20,
    rotation: 0,
    opacity: 1,
    resourceId: 'res-photo',
    naturalWidth: 200,
    naturalHeight: 100,
    smoothing: true
  })
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
        rectNode({ id: 'e1', name: 'badge', primitive: 'ellipse', width: 30, height: 30, center: { x: 80, y: 120 }, fill: '#22d3ee' })
      ]
    },
    {
      frame: 2,
      nodes: [
        rectNode({ id: 'e1', name: 'badge', primitive: 'ellipse', width: 30, height: 30, center: { x: 100, y: 120 }, fill: '#22d3ee' })
      ]
    }
  )
  document.layers.push(holdLayer)

  const drawing = createDrawingLayer('paint')
  drawing.cells.push({ frame: 0, resourceId: 'res-draw-a' })
  drawing.cells.push({ frame: 5, resourceId: 'res-draw-b' })
  document.layers.push(drawing)

  const camera = createCameraLayer('Camera')
  document.layers.push(camera)
  const camFirst = insertCameraKeyframe(document, 0, { center: { x: 160, y: 90 }, zoom: 1.2, rotation: 30 })
  if (!camFirst) throw new Error('expected the camera keyframe to be inserted')
  camFirst.tween = { easing: 'linear' }
  insertCameraKeyframe(document, 10, { center: { x: 200, y: 100 }, zoom: 2, rotation: 90 })

  return document
}

describe('animated-SVG golden file', () => {
  it('matches the checked-in fixture (regenerate with UPDATE_GOLDEN=1)', async () => {
    const { svg, diagnostics } = await exportAnimatedSvg(
      goldenDocument(),
      RANGE,
      deps({
        resolveResourceDataUrl: (resourceId) =>
          Promise.resolve(
            resourceId === 'res-draw-a'
              ? DRAW_A_URL
              : resourceId === 'res-draw-b'
                ? DRAW_B_URL
                : PHOTO_URL
          )
      })
    )
    expect(diagnostics).toEqual([])
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true })
      writeFileSync(GOLDEN_PATH, svg)
    }
    expect(svg).toBe(readFileSync(GOLDEN_PATH, 'utf8'))
  })
})
