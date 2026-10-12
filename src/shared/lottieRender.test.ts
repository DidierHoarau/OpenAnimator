// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest'

import type { AudioStub, LottieRenderHarness } from '../../test-utils/lottieRender'
import { createLottieRenderHarness } from '../../test-utils/lottieRender'

import {
  createAudioLayer,
  createCameraLayer,
  createDocument,
  evaluateLayerAtFrame,
  insertCameraKeyframe,
  insertKeyframe
} from './document'
import type { LottieBuildDeps } from './lottieExport'
import { buildLottieAnimation } from './lottieExport'
import type { AnimatorDocument, PathNode, PrimitiveNode } from './model'
import { pathDataToSubpathAnchors } from './pathModel'

/**
 * CI render gate: the exported Lottie JSON is fed to the real lottie-web
 * player (the same 5.13 light build) and the rendered SVG transforms are
 * compared against the shared evaluator. This proves the structural
 * conventions the exporter relies on (layer/item order, key easing
 * placement, hold keys, camera precomp decomposition, gradient stops with
 * folded alpha, audio playback) actually render as the document plays.
 */

const deps: LottieBuildDeps = { resolveResourceDataUrl: () => Promise.resolve(null) }

let harness: LottieRenderHarness

beforeAll(async () => {
  harness = await createLottieRenderHarness()
})

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

function tweenedDocument(): AnimatorDocument {
  const document = createDocument('demo', 320, 180, 12)
  const layer = document.layers[0]
  if (layer.kind !== 'object') throw new Error('expected an object layer')
  layer.keyframes[0].nodes.push(rectNode())
  layer.keyframes[0].tween = { easing: 'linear' }
  const final = insertKeyframe(layer, 10)
  if (!final) throw new Error('expected the keyframe to be inserted')
  ;(final.nodes[0] as PrimitiveNode).center = { x: 200, y: 100 }
  return document
}

async function renderAt(document: AnimatorDocument, frame: number): Promise<string> {
  const { lottie } = await buildLottieAnimation(document, { fromFrame: 0, toFrame: 10, fps: 12 }, deps)
  return harness.renderAt(lottie, frame)
}

function matrices(markup: string): number[][] {
  const result: number[][] = []
  const re = /matrix\(([^)]+)\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(markup)) !== null) {
    result.push(match[1].split(',').map(Number))
  }
  return result
}

function expectMatrix(list: number[][], expected: number[], tolerance = 0.01): void {
  const found = list.find((matrix) => matrix.every((value, index) => Math.abs(value - expected[index]) <= tolerance))
  expect(
    found,
    `no matrix within ${tolerance} of [${expected.join(', ')}] among ${JSON.stringify(list)}`
  ).toBeDefined()
}

function attrOf(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return match ? match[1] : null
}

/** Attribute chunks of every `<stop ...>` in the markup, self-closing or not. */
function stopTags(markup: string): string[] {
  return markup
    .split('<stop ')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf('>')))
}

/** translate(position) · rotate(rotationDeg) · scale(scale) · translate(-anchor) */
function composedMatrix(
  position: { x: number; y: number },
  rotationDeg: number,
  scale: number,
  anchor: { x: number; y: number }
): number[] {
  const radians = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const a = cos * scale
  const b = sin * scale
  const c = -sin * scale
  const d = cos * scale
  return [a, b, c, d, position.x + a * -anchor.x + c * -anchor.y, position.y + b * -anchor.x + d * -anchor.y]
}

describe('lottie-web render gate', () => {
  it('renders the tweened shape at the evaluator pose and fill color', async () => {
    const document = tweenedDocument()

    const atStart = await renderAt(document, 0)
    expect(atStart).toContain('fill="rgb(255,0,0)"')
    expectMatrix(matrices(atStart), [1, 0, 0, 1, 40, 40])

    const mid = await renderAt(document, 5)
    expectMatrix(matrices(mid), [1, 0, 0, 1, 120, 70])

    const end = await renderAt(document, 10)
    expectMatrix(matrices(end), [1, 0, 0, 1, 200, 100])
  })

  it('holds keyed values until the next hold key', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const layer = document.layers[0]
    if (layer.kind !== 'object') throw new Error('expected an object layer')
    layer.keyframes.push(
      {
        frame: 0,
        nodes: [rectNode({ id: 'e1', primitive: 'ellipse', center: { x: 80, y: 120 }, fill: '#00ff00' })]
      },
      {
        frame: 2,
        nodes: [rectNode({ id: 'e1', primitive: 'ellipse', center: { x: 100, y: 120 }, fill: '#00ff00' })]
      }
    )
    layer.keyframes.sort((a, b) => a.frame - b.frame)

    const before = await renderAt(document, 1)
    expect(before).toContain('fill="rgb(0,255,0)"')
    expectMatrix(matrices(before), [1, 0, 0, 1, 80, 120])

    const at = await renderAt(document, 2)
    expectMatrix(matrices(at), [1, 0, 0, 1, 100, 120])
  })

  it('morphs a compatible path outline between keyframes', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const layer = document.layers[0]
    if (layer.kind !== 'object') throw new Error('expected an object layer')
    const polyline: PathNode = {
      id: 'p1',
      name: 'poly',
      type: 'path',
      center: { x: 0, y: 0 },
      width: 20,
      height: 20,
      rotation: 0,
      opacity: 1,
      d: 'M-10 -10 L10 -10 L0 10',
      fill: '#0000ff'
    }
    layer.keyframes[0].nodes.push(polyline)
    layer.keyframes[0].tween = { easing: 'linear' }
    const final = insertKeyframe(layer, 10)
    if (!final) throw new Error('expected the keyframe to be inserted')
    ;(final.nodes[0] as PathNode).d = 'M-20 -5 L20 -5 L0 5'

    const anchorsAt = async (frame: number): Promise<Array<{ x: number; y: number }>> => {
      const markup = await renderAt(document, frame)
      const attributes = markup.match(/ d="([^"]+)"/g) ?? []
      for (const attribute of attributes) {
        const subpaths = pathDataToSubpathAnchors(attribute.slice(4, -1))
        if (subpaths && subpaths.length === 1 && subpaths[0].anchors.length === 3) {
          return subpaths[0].anchors.map((anchor) => ({ x: anchor.x, y: anchor.y }))
        }
      }
      throw new Error(`no 3-anchor path rendered: ${markup}`)
    }

    const at0 = await anchorsAt(0)
    expect(at0[0].x).toBeCloseTo(-10, 2)
    expect(at0[0].y).toBeCloseTo(-10, 2)
    expect(at0[1].x).toBeCloseTo(10, 2)
    expect(at0[2].y).toBeCloseTo(10, 2)

    const at5 = await anchorsAt(5)
    expect(at5[0].x).toBeCloseTo(-15, 2)
    expect(at5[0].y).toBeCloseTo(-7.5, 2)
    expect(at5[1].x).toBeCloseTo(15, 2)
    expect(at5[1].y).toBeCloseTo(-7.5, 2)
    expect(at5[2].x).toBeCloseTo(0, 2)
    expect(at5[2].y).toBeCloseTo(7.5, 2)

    const at10 = await anchorsAt(10)
    expect(at10[0].x).toBeCloseTo(-20, 2)
    expect(at10[0].y).toBeCloseTo(-5, 2)
    expect(at10[1].x).toBeCloseTo(20, 2)
    expect(at10[2].y).toBeCloseTo(5, 2)
  })

  it('renders the camera precomp with the decomposed keyed transform', async () => {
    const document = tweenedDocument()
    const camera = createCameraLayer('Camera')
    document.layers.push(camera)
    const first = insertCameraKeyframe(document, 0, { center: { x: 160, y: 90 }, zoom: 1.2, rotation: 30 })
    if (!first) throw new Error('expected the camera keyframe to be inserted')
    first.tween = { easing: 'linear' }
    insertCameraKeyframe(document, 10, { center: { x: 200, y: 100 }, zoom: 2, rotation: 90 })

    // Frame 5: center (180,95), zoom 1.6, rotation 60 → layer transform is
    // translate(160,90) rotate(-60) scale(1.6) translate(-180,-95).
    const at5 = await renderAt(document, 5)
    const outer5 = matrices(at5)[0]
    expect(outer5).toBeDefined()
    const expected5 = composedMatrix({ x: 160, y: 90 }, -60, 1.6, { x: 180, y: 95 })
    expected5.forEach((value, index) => {
      expect(Math.abs(outer5[index] - value)).toBeLessThan(0.01)
    })

    const at0 = await renderAt(document, 0)
    const outer0 = matrices(at0)[0]
    const expected0 = composedMatrix({ x: 160, y: 90 }, -30, 1.2, { x: 160, y: 90 })
    expected0.forEach((value, index) => {
      expect(Math.abs(outer0[index] - value)).toBeLessThan(0.01)
    })
  })

  it('renders a linear gradient with the alpha folded onto the stops', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const layer = document.layers[0]
    if (layer.kind !== 'object') throw new Error('expected an object layer')
    layer.keyframes[0].nodes.push(
      rectNode({
        fill: {
          type: 'linear',
          angle: 0,
          stops: [
            { offset: 0, color: '#ff0000' },
            { offset: 1, color: '#0000ff', alpha: 0.5 }
          ]
        }
      })
    )

    const markup = await renderAt(document, 0)
    const gradient = markup.match(/<linearGradient[^>]*>/)?.[0]
    expect(gradient).toBeDefined()
    expect(gradient).toContain('gradientUnits="userSpaceOnUse"')
    expect(gradient).toContain('spreadMethod="pad"')
    expect(attrOf(gradient!, 'x1')).toBe('-10')
    expect(attrOf(gradient!, 'y1')).toBe('0')
    expect(attrOf(gradient!, 'x2')).toBe('10')
    expect(attrOf(gradient!, 'y2')).toBe('0')

    const stops = stopTags(markup)
    expect(stops).toHaveLength(2)
    expect(attrOf(stops[0], 'offset')).toBe('0%')
    expect(attrOf(stops[0], 'stop-color')).toBe('rgb(255,0,0)')
    expect(attrOf(stops[0], 'stop-opacity')).toBe('1')
    expect(attrOf(stops[1], 'offset')).toBe('100%')
    expect(attrOf(stops[1], 'stop-color')).toBe('rgb(0,0,255)')
    expect(attrOf(stops[1], 'stop-opacity')).toBe('0.5')

    expect(markup).toMatch(/<path[^>]* fill="url\([^"]*#/)
  })

  it('renders a radial gradient centered on the shape box', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const layer = document.layers[0]
    if (layer.kind !== 'object') throw new Error('expected an object layer')
    layer.keyframes[0].nodes.push(
      rectNode({
        fill: {
          type: 'radial',
          cx: 0.5,
          cy: 0.5,
          r: 0.5,
          stops: [
            { offset: 0, color: '#ff0000' },
            { offset: 1, color: '#0000ff' }
          ]
        }
      })
    )

    const markup = await renderAt(document, 0)
    const gradient = markup.match(/<radialGradient[^>]*>/)?.[0]
    expect(gradient).toBeDefined()
    expect(gradient).toContain('gradientUnits="userSpaceOnUse"')
    // 20x10 box: r = 0.5 · (20 + 10) / 2 = 7.5 around the box center.
    expect(attrOf(gradient!, 'cx')).toBe('0')
    expect(attrOf(gradient!, 'cy')).toBe('0')
    expect(attrOf(gradient!, 'r')).toBe('7.5')
    expect(attrOf(gradient!, 'fx')).toBe('0')
    expect(attrOf(gradient!, 'fy')).toBe('0')
  })

  it('renders a tweened gradient at its baked mid-frame geometry', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const layer = document.layers[0]
    if (layer.kind !== 'object') throw new Error('expected an object layer')
    const stops = [
      { offset: 0, color: '#ff0000' },
      { offset: 1, color: '#0000ff' }
    ]
    layer.keyframes[0].nodes.push(rectNode({ fill: { type: 'linear', angle: 0, stops } }))
    layer.keyframes[0].tween = { easing: 'linear' }
    const final = insertKeyframe(layer, 10)
    if (!final) throw new Error('expected the keyframe to be inserted')
    ;(final.nodes[0] as PrimitiveNode).fill = { type: 'linear', angle: 180, stops }

    // Frame 5: angle 0 → 180 lerps to 90, so the axis runs top to bottom.
    const markup = await renderAt(document, 5)
    const gradient = markup.match(/<linearGradient[^>]*>/)?.[0]
    expect(gradient).toBeDefined()
    expect(attrOf(gradient!, 'x1')).toBe('0')
    expect(attrOf(gradient!, 'y1')).toBe('-5')
    expect(attrOf(gradient!, 'x2')).toBe('0')
    expect(attrOf(gradient!, 'y2')).toBe('5')
  })

  it('renders smooth-tweened nodes at the evaluator pose between keys', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const layer = document.layers[0]
    if (layer.kind !== 'object') throw new Error('expected an object layer')
    layer.keyframes[0].nodes.push(rectNode())
    layer.keyframes[0].tween = { easing: 'linear', path: 'smooth' }
    const second = insertKeyframe(layer, 4)
    if (!second) throw new Error('expected the keyframe to be inserted')
    ;(second.nodes[0] as PrimitiveNode).center = { x: 160, y: 40 }
    second.tween = { easing: 'linear', path: 'smooth' }
    const third = insertKeyframe(layer, 8)
    if (!third) throw new Error('expected the keyframe to be inserted')
    ;(third.nodes[0] as PrimitiveNode).center = { x: 160, y: 120 }

    const poseAt = (frame: number): PrimitiveNode => {
      const pose = evaluateLayerAtFrame(layer, frame).find((node) => node.id === 'r1')
      if (!pose || pose.type !== 'primitive') throw new Error('expected the evaluated node')
      return pose
    }

    const pose2 = poseAt(2)
    // The Catmull-Rom curve bows off the straight line between the keys.
    expect(Math.abs(pose2.center.y - 40)).toBeGreaterThan(1)
    const at2 = await renderAt(document, 2)
    expectMatrix(matrices(at2), [1, 0, 0, 1, pose2.center.x, pose2.center.y])

    const pose6 = poseAt(6)
    const at6 = await renderAt(document, 6)
    expectMatrix(matrices(at6), [1, 0, 0, 1, pose6.center.x, pose6.center.y])
  })

  it('drives the embedded audio through the player audio pipeline', async () => {
    const document = tweenedDocument()
    const audio = createAudioLayer('res-song', 'song')
    audio.volume = 0.5
    document.layers.push(audio)

    const { lottie } = await buildLottieAnimation(
      document,
      { fromFrame: 0, toFrame: 10, fps: 12, audio: 'embed' },
      {
        resolveResourceDataUrl: () => Promise.resolve(null),
        resolveResourceBytes: () => Promise.resolve({ bytes: new Uint8Array([1, 2, 3, 4]), ext: 'mp3' })
      }
    )

    let createdPath: string | null = null
    const volumeCalls: number[] = []
    const seekCalls: number[] = []
    let playCount = 0
    const stub: AudioStub = {
      volume: (value) => {
        volumeCalls.push(value)
      },
      play: () => {
        playCount += 1
      },
      seek: (value) => {
        if (value !== undefined) seekCalls.push(value)
        return seekCalls[seekCalls.length - 1] ?? 0
      },
      playing: () => true,
      rate: () => {},
      setVolume: () => {},
      pause: () => {}
    }

    const animation = harness.load(lottie, {
      audioFactory: (assetPath) => {
        createdPath = assetPath
        return stub
      }
    })

    expect(createdPath).toBe('data:audio/mpeg;base64,AQIDBA==')

    // Preparing a frame applies the layer volume, but playback stays armed
    // until the animation is played.
    animation.goToAndStop(0, true)
    expect(volumeCalls[0]).toBeCloseTo(0.5, 5)
    expect(playCount).toBe(0)

    // Frame 5 of 12fps with the clip starting at 0: lottie seeks to the tm
    // keyframe value in seconds (5/12 ≈ 0.4167).
    animation.play()
    animation.goToAndStop(5, true)
    expect(playCount).toBeGreaterThan(0)
    expect(seekCalls.length).toBeGreaterThan(0)
    expect(Math.abs(seekCalls[0] - 5 / 12)).toBeLessThan(0.01)

    animation.destroy()
    animation.container.remove()
  })
})
