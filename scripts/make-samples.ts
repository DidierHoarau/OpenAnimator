import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { packProject } from '../src/main/projectContainer'
import { createResourceResolver, renderToFile } from '../src/cli/render'
import { defaultExportOptions } from '../src/shared/exportOptions'
import type { AnimatorDocument, PathNode, PrimitiveNode } from '../src/shared/model'

/**
 * Regenerates the gallery samples committed under `docs/samples/`: one
 * `.oanim` project per sample plus a GIF preview, rendered through the same
 * shared pipeline as the app's exporter. Everything is deterministic —
 * literal ids instead of `createId`, a pinned ZIP timestamp, no fonts — so
 * `npm run samples:build && git diff --exit-code docs/samples` is a valid
 * freshness gate in CI.
 *
 * tsx runs this file as CommonJS: `__dirname`, no `import.meta`.
 */

const ROOT = join(__dirname, '..')
const OUT_DIR = join(ROOT, 'docs/samples')

const FIXED_MTIME = new Date('2026-01-01T00:00:00Z')

/** Mirrors `createDocument('Untitled', 960, 540, 24)` from a fresh studio. */
const WIDTH = 960
const HEIGHT = 540
const FPS = 24
const BACKGROUND = '#10151b'

/** GIF preview scale: half size keeps the committed files small. */
const PREVIEW_SCALE = 0.5

/** The bouncing-ball sample: the scripted example's document, hand-built. */
function bouncingBallDocument(): AnimatorDocument {
  const ball = (y: number): PrimitiveNode => ({
    type: 'primitive',
    id: 'ball',
    primitive: 'ellipse',
    name: 'Ball',
    width: 90,
    height: 90,
    center: { x: 480, y },
    rotation: 0,
    opacity: 1,
    fill: '#ff5252'
  })
  return {
    schemaVersion: 8,
    name: 'Bouncing Ball',
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    background: BACKGROUND,
    layers: [
      {
        kind: 'object',
        id: 'ball-layer',
        name: 'Ball',
        visible: true,
        locked: false,
        keyframes: [
          // Falls: ease-in accelerates toward the floor.
          { frame: 0, nodes: [ball(100)], tween: { easing: 'ease-in' } },
          // Rises: ease-out decelerates toward the apex.
          { frame: 11, nodes: [ball(450)], tween: { easing: 'ease-out' } },
          { frame: 23, nodes: [ball(100)] }
        ]
      }
    ],
    frames: 24,
    assets: [],
    palette: [],
    fonts: []
  }
}

/** One walk-cycle pose: limb rotations (degrees) and the body center. */
interface WalkPose {
  frame: number
  legLeft: number
  legRight: number
  armLeft: number
  armRight: number
  bodyY: number
}

const WALK_POSES: WalkPose[] = [
  { frame: 0, legLeft: 0, legRight: 0, armLeft: 0, armRight: 0, bodyY: 290 },
  { frame: 6, legLeft: 0, legRight: 0, armLeft: 0, armRight: 0, bodyY: 278 },
  { frame: 12, legLeft: -25, legRight: 25, armLeft: 20, armRight: -20, bodyY: 290 },
  { frame: 18, legLeft: 0, legRight: 0, armLeft: 0, armRight: 0, bodyY: 278 },
  { frame: 23, legLeft: 25, legRight: -25, armLeft: -20, armRight: 20, bodyY: 290 }
]

/** Limbs are straight paths whose local origin (0,0) is the hip/shoulder:
 * the node center places the joint, rotation swings the limb around it. */
function limb(id: string, name: string, length: number, strokeWidth: number, x: number, y: number, rotation: number): PathNode {
  return {
    type: 'path',
    id,
    name,
    d: `M 0 0 L 0 ${length}`,
    width: 20,
    height: length,
    center: { x, y },
    rotation,
    opacity: 1,
    stroke: '#94a3b8',
    strokeWidth
  }
}

/** The walk-cycle sample: five flip-book poses (no tween), 24 frames. */
function walkCycleDocument(): AnimatorDocument {
  return {
    schemaVersion: 8,
    name: 'Walk Cycle',
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    background: BACKGROUND,
    layers: [
      {
        kind: 'object',
        id: 'walk-layer',
        name: 'Walk',
        visible: true,
        locked: false,
        keyframes: WALK_POSES.map((pose) => ({
          frame: pose.frame,
          nodes: [
            {
              type: 'primitive' as const,
              id: 'body',
              primitive: 'ellipse' as const,
              name: 'Body',
              width: 70,
              height: 130,
              center: { x: 480, y: pose.bodyY },
              rotation: 0,
              opacity: 1,
              fill: '#fde68a',
              stroke: '#f59e0b',
              strokeWidth: 4
            },
            limb('leg-left', 'Leg L', 90, 10, 466, 350, pose.legLeft),
            limb('leg-right', 'Leg R', 90, 10, 494, 350, pose.legRight),
            limb('arm-left', 'Arm L', 60, 8, 452, 240, pose.armLeft),
            limb('arm-right', 'Arm R', 60, 8, 508, 240, pose.armRight)
          ]
        }))
      }
    ],
    frames: 24,
    assets: [],
    palette: [],
    fonts: []
  }
}

async function writeSample(name: string, document: AnimatorDocument): Promise<void> {
  const project = packProject(document, new Map(), { mtime: FIXED_MTIME })
  await writeFile(join(OUT_DIR, `${name}.oanim`), project)
  const options = { ...defaultExportOptions(document), format: 'gif' as const, scale: PREVIEW_SCALE }
  await renderToFile(
    document,
    options,
    createResourceResolver(new Map()),
    join(OUT_DIR, `${name}.gif`)
  )
  console.log(`docs/samples/${name}.oanim (${project.length} bytes)`)
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })
  await writeSample('bouncing-ball', bouncingBallDocument())
  await writeSample('walk-cycle', walkCycleDocument())
}

void main()
