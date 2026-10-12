/**
 * Deterministic 500-node / 120-frame project for the performance benchmark:
 * 10 object layers × 50 nodes (rectangles and ellipses plus a few paths and
 * texts), every node keyed at frames 0/30/60/90/119 with linear tweens
 * between the poses, fps 30 — so tween evaluation, key reconciliation and
 * rendering costs are all exercised for the full document.
 *
 * Layout comes from a seeded LCG: every run measures the exact same
 * document, which keeps the before/after numbers comparable. Playwright
 * transpiles these files without the app's `@shared` alias, so everything is
 * imported relatively — and only from modules that exist on the pre-change
 * baseline (the benchmark must also run against `main`).
 */
import { packProject } from '../src/main/projectContainer'
import { migrateDocument } from '../src/shared/migrate'
import type { Vec2 } from '../src/shared/geometry'
import type { AnimatorDocument, Keyframe, ObjectLayer, SceneNode } from '../src/shared/model'

export const PERF_WIDTH = 1920
export const PERF_HEIGHT = 1080
export const PERF_FPS = 30
export const PERF_FRAMES = 120
export const PERF_LAYER_COUNT = 10
export const PERF_NODES_PER_LAYER = 50
export const PERF_KEYFRAME_FRAMES = [0, 30, 60, 90, 119]

/** The stage-space size of one timeline frame in the app; used by the spec
 * to translate track clicks back into frames. */
export const PERF_FRAME_WIDTH = 14

/**
 * Node the drag benchmark grabs: the last (topmost) node of the first layer
 * — the layer the app makes current when a document opens — parked at the
 * stage center at every keyframe so its screen position is deterministic.
 */
export const PERF_PROBE_ID = 'perf-node-0-49'
export const PERF_PROBE_CENTER: Vec2 = { x: PERF_WIDTH / 2, y: PERF_HEIGHT / 2 }
export const PERF_PROBE_LAYER_INDEX = 0

interface NodePlan {
  id: string
  kind: 'rect' | 'ellipse' | 'path' | 'text'
  width: number
  height: number
  base: Vec2
  drift: Vec2
  rotation: number
  rotationDrift: number
  fill: string
  stroke?: string
  isProbe: boolean
}

/** Seeded 32-bit LCG (Numerical Recipes constants); `>>> 0` keeps it in
 * uint32 arithmetic so results are identical across engines. */
function createRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function hexColor(rng: () => number): string {
  return `#${Math.floor(rng() * 0xffffff).toString(16).padStart(6, '0')}`
}

function planNode(rng: () => number, layerIndex: number, nodeIndex: number): NodePlan {
  const isProbe = layerIndex === PERF_PROBE_LAYER_INDEX && nodeIndex === PERF_NODES_PER_LAYER - 1
  const width = isProbe ? 240 : Math.round(40 + rng() * 160)
  const height = isProbe ? 170 : Math.round(30 + rng() * 120)
  const kind: NodePlan['kind'] = isProbe
    ? 'rect'
    : nodeIndex % 16 === 7
      ? 'path'
      : nodeIndex % 16 === 11
        ? 'text'
        : nodeIndex % 2 === 0
          ? 'rect'
          : 'ellipse'
  const fill = isProbe ? '#ff8800' : hexColor(rng)
  return {
    id: `perf-node-${layerIndex}-${nodeIndex}`,
    kind,
    width,
    height,
    base: isProbe
      ? { ...PERF_PROBE_CENTER }
      : { x: Math.round(60 + rng() * (PERF_WIDTH - 120)), y: Math.round(60 + rng() * (PERF_HEIGHT - 120)) },
    drift: isProbe ? { x: 0, y: 0 } : { x: (rng() * 2 - 1) * 30, y: (rng() * 2 - 1) * 30 },
    rotation: isProbe ? 0 : Math.round((rng() * 2 - 1) * 20),
    rotationDrift: isProbe ? 0 : Math.round((rng() * 2 - 1) * 8),
    fill,
    stroke: nodeIndex % 5 === 0 ? hexColor(rng) : undefined,
    isProbe
  }
}

function buildNode(plan: NodePlan, keyframeIndex: number): SceneNode {
  const center: Vec2 = {
    x: plan.base.x + plan.drift.x * keyframeIndex,
    y: plan.base.y + plan.drift.y * keyframeIndex
  }
  const rotation = plan.rotation + plan.rotationDrift * keyframeIndex
  const base = {
    id: plan.id,
    center,
    width: plan.width,
    height: plan.height,
    rotation,
    opacity: 1
  }
  if (plan.kind === 'path') {
    const halfW = plan.width / 2
    const halfH = plan.height / 2
    return {
      ...base,
      type: 'path',
      d: `M ${-halfW} 0 L ${halfW} ${-halfH} L ${halfW} ${halfH} Z`,
      fill: plan.fill,
      ...(plan.stroke !== undefined ? { stroke: plan.stroke, strokeWidth: 2 } : {})
    }
  }
  if (plan.kind === 'text') {
    return {
      ...base,
      type: 'text',
      text: plan.id,
      fontFamily: 'Noto Sans',
      fontSize: 28,
      fontWeight: 400,
      fill: plan.fill,
      align: 'left'
    }
  }
  return {
    ...base,
    type: 'primitive',
    primitive: plan.kind,
    fill: plan.fill,
    ...(plan.stroke !== undefined ? { stroke: plan.stroke, strokeWidth: 2 } : {})
  }
}

export function generatePerfDocument(): AnimatorDocument {
  const rng = createRng(0x5eed5eed)
  const layers: ObjectLayer[] = []
  for (let layerIndex = 0; layerIndex < PERF_LAYER_COUNT; layerIndex++) {
    const plans: NodePlan[] = []
    for (let nodeIndex = 0; nodeIndex < PERF_NODES_PER_LAYER; nodeIndex++) {
      plans.push(planNode(rng, layerIndex, nodeIndex))
    }
    const keyframes: Keyframe[] = PERF_KEYFRAME_FRAMES.map((frame, keyframeIndex) => ({
      frame,
      nodes: plans.map((plan) => buildNode(plan, keyframeIndex)),
      ...(keyframeIndex < PERF_KEYFRAME_FRAMES.length - 1
        ? { tween: { easing: 'linear' as const } }
        : {})
    }))
    layers.push({
      kind: 'object',
      id: `perf-layer-${layerIndex}`,
      name: `Layer ${layerIndex + 1}`,
      visible: true,
      locked: false,
      keyframes
    })
  }
  return migrateDocument({
    schemaVersion: 9,
    name: 'perf-benchmark',
    width: PERF_WIDTH,
    height: PERF_HEIGHT,
    fps: PERF_FPS,
    background: '#10151b',
    frames: PERF_FRAMES,
    layers,
    assets: [],
    palette: [],
    fonts: []
  })
}

/** Packs the generated document into `.oanim` bytes for the app to open. */
export function generatePerfProject(): Uint8Array {
  return packProject(generatePerfDocument(), new Map())
}
