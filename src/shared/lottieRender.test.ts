// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest'

import { createCameraLayer, createDocument, insertCameraKeyframe, insertKeyframe } from './document'
import type { LottieBuildDeps } from './lottieExport'
import { buildLottieAnimation } from './lottieExport'
import type { AnimatorDocument, PrimitiveNode } from './model'

/**
 * CI render gate: the exported Lottie JSON is fed to the real lottie-web
 * player (the same 5.13 light build) and the rendered SVG transforms are
 * compared against the shared evaluator. This proves the structural
 * conventions the exporter relies on (layer/item order, key easing
 * placement, hold keys, camera precomp decomposition) actually render as
 * the document plays.
 */

const deps: LottieBuildDeps = { resolveResourceDataUrl: () => Promise.resolve(null) }

interface LottiePlayer {
  loadAnimation(options: {
    container: HTMLElement
    renderer: string
    autoplay: boolean
    animationData: Record<string, unknown>
  }): { goToAndStop(frame: number, isFrame: boolean): void; destroy(): void }
}

let player: LottiePlayer

beforeAll(async () => {
  stubCanvas()
  player = (await import('lottie-web/build/player/lottie_light')).default as unknown as LottiePlayer
})

/** lottie-web's light build probes a canvas 2D context even for the SVG
 * renderer; happy-dom implements none, so a minimal stub keeps it happy. */
function stubCanvas(): void {
  const proto = window.HTMLCanvasElement.prototype as unknown as { getContext: unknown }
  proto.getContext = function getContext(this: HTMLCanvasElement) {
    return {
      canvas: this,
      fillRect: () => {},
      clearRect: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData: () => {},
      createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      setTransform: () => {},
      drawImage: () => {},
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      bezierCurveTo: () => {},
      quadraticCurveTo: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      clip: () => {},
      measureText: () => ({ width: 0 }),
      fillText: () => {},
      strokeText: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createPattern: () => null,
      scale: () => {},
      rotate: () => {},
      translate: () => {},
      transform: () => {},
      rect: () => {},
      ellipse: () => {},
      isPointInPath: () => false
    }
  }
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
  const container = window.document.createElement('div')
  window.document.body.appendChild(container)
  const animation = player.loadAnimation({
    container,
    renderer: 'svg',
    autoplay: false,
    animationData: lottie
  })
  animation.goToAndStop(frame, true)
  const markup = container.innerHTML
  animation.destroy()
  container.remove()
  return markup
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
})
