import type { ScriptCommand } from './commands'

/**
 * Ready-made command payloads for the script console and the scripting docs.
 * Each example is a complete, self-contained script that runs against a
 * fresh 960x540 document (the starter layout) and doubles as the canonical
 * reference for how commands compose: layers first, then nodes, then poses
 * and tweens.
 */
export interface ScriptExample {
  name: string
  description: string
  commands: ScriptCommand[]
}

/** A ball drops from the top, hits the floor and bounces back up: two tweens
 * with opposite easing around the impact keyframe. */
const bouncingBall: ScriptExample = {
  name: 'Bouncing ball',
  description: 'A red ball falls from the top of the stage and bounces off the floor.',
  commands: [
    { op: 'addLayer', kind: 'object', name: 'Ball' },
    {
      op: 'addNode',
      frame: 0,
      node: {
        type: 'primitive',
        id: 'ball',
        primitive: 'ellipse',
        name: 'Ball',
        width: 90,
        height: 90,
        center: { x: 480, y: 100 },
        rotation: 0,
        opacity: 1,
        fill: '#ff5252'
      }
    },
    // Falls: ease-in accelerates toward the floor.
    { op: 'setTween', frame: 0, easing: 'ease-in' },
    {
      op: 'updateNode',
      nodeId: 'ball',
      frame: 11,
      patch: { center: { x: 480, y: 450 } }
    },
    // Rises: ease-out decelerates toward the apex.
    { op: 'setTween', frame: 11, easing: 'ease-out' },
    {
      op: 'updateNode',
      nodeId: 'ball',
      frame: 23,
      patch: { center: { x: 480, y: 100 } }
    },
    { op: 'setDuration', frames: 24 }
  ]
}

/** A centered title starts fully transparent and fades in over one second. */
const titleCardFadeIn: ScriptExample = {
  name: 'Title card fade-in',
  description: 'A centered title fades in from transparent over one second.',
  commands: [
    { op: 'addLayer', kind: 'object', name: 'Title' },
    {
      op: 'addNode',
      frame: 0,
      node: {
        type: 'text',
        id: 'title',
        text: 'OPENANIMATOR',
        fontFamily: 'Noto Sans',
        fontSize: 72,
        fontWeight: 700,
        align: 'center',
        fill: '#ffffff',
        width: 720,
        height: 90,
        center: { x: 480, y: 270 },
        rotation: 0,
        opacity: 0
      }
    },
    { op: 'setTween', frame: 0, easing: 'linear' },
    {
      op: 'updateNode',
      nodeId: 'title',
      frame: 23,
      patch: { opacity: 1 }
    },
    { op: 'setDuration', frames: 24 }
  ]
}

/** A three-pose slide retimed after the fact: the middle pose is moved,
 * the arc along the path is smoothed and playback runs on twos. */
const retimedSlide: ScriptExample = {
  name: 'Retimed slide (moved keyframe + hold step)',
  description:
    'A square slides across with a smooth arc; the middle pose is retimed and playback runs on twos.',
  commands: [
    { op: 'addLayer', kind: 'object', name: 'Square' },
    {
      op: 'addNode',
      frame: 0,
      node: {
        type: 'primitive',
        id: 'square',
        primitive: 'rect',
        name: 'Square',
        width: 80,
        height: 80,
        center: { x: 120, y: 270 },
        rotation: 0,
        opacity: 1,
        fill: '#38bdf8'
      }
    },
    // A custom ease plus a smooth motion path through the three poses.
    { op: 'setTween', frame: 0, easing: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 }, path: 'smooth' },
    { op: 'updateNode', nodeId: 'square', frame: 11, patch: { center: { x: 480, y: 150 } } },
    { op: 'updateNode', nodeId: 'square', frame: 23, patch: { center: { x: 840, y: 270 } } },
    { op: 'moveKeyframe', nodeId: 'square', fromFrame: 11, toFrame: 9 },
    { op: 'setHoldStep', step: 2 },
    { op: 'setDuration', frames: 24 }
  ]
}

/** One walk-cycle pose: limb rotations (degrees) and the body center. Limbs
 * pivot around their joint because each path's local origin sits on the hip
 * or shoulder, so a rotation patch alone animates the swing. */
function walkPose(
  frame: number,
  legLeft: number,
  legRight: number,
  armLeft: number,
  armRight: number,
  bodyY: number
): ScriptCommand[] {
  return [
    { op: 'updateNode', nodeId: 'leg-left', frame, patch: { rotation: legLeft } },
    { op: 'updateNode', nodeId: 'leg-right', frame, patch: { rotation: legRight } },
    { op: 'updateNode', nodeId: 'arm-left', frame, patch: { rotation: armLeft } },
    { op: 'updateNode', nodeId: 'arm-right', frame, patch: { rotation: armRight } },
    { op: 'updateNode', nodeId: 'body', frame, patch: { center: { x: 480, y: bodyY } } }
  ]
}

/**
 * A stick figure walks in place: five flip-book poses (no tween — the poses
 * hold like a real walk cycle on twos) swing the four limbs around their
 * joints while the body bobs up and down over 24 frames.
 */
const walkCycle: ScriptExample = {
  name: 'Walk cycle',
  description:
    'A stick figure walks in place: five flip-book limb/body poses over 24 frames, no tween.',
  commands: [
    { op: 'addLayer', kind: 'object', name: 'Walk' },
    {
      op: 'addNode',
      frame: 0,
      node: {
        type: 'primitive',
        id: 'body',
        primitive: 'ellipse',
        name: 'Body',
        width: 70,
        height: 130,
        center: { x: 480, y: 290 },
        rotation: 0,
        opacity: 1,
        fill: '#fde68a',
        stroke: '#f59e0b',
        strokeWidth: 4
      }
    },
    // Limbs are straight paths whose local origin (0,0) is the hip/shoulder:
    // the node center places the joint, rotation swings the limb around it.
    {
      op: 'addNode',
      frame: 0,
      node: {
        type: 'path',
        id: 'leg-left',
        name: 'Leg L',
        d: 'M 0 0 L 0 90',
        width: 20,
        height: 90,
        center: { x: 466, y: 350 },
        rotation: 0,
        opacity: 1,
        stroke: '#94a3b8',
        strokeWidth: 10
      }
    },
    {
      op: 'addNode',
      frame: 0,
      node: {
        type: 'path',
        id: 'leg-right',
        name: 'Leg R',
        d: 'M 0 0 L 0 90',
        width: 20,
        height: 90,
        center: { x: 494, y: 350 },
        rotation: 0,
        opacity: 1,
        stroke: '#94a3b8',
        strokeWidth: 10
      }
    },
    {
      op: 'addNode',
      frame: 0,
      node: {
        type: 'path',
        id: 'arm-left',
        name: 'Arm L',
        d: 'M 0 0 L 0 60',
        width: 20,
        height: 60,
        center: { x: 452, y: 240 },
        rotation: 0,
        opacity: 1,
        stroke: '#94a3b8',
        strokeWidth: 8
      }
    },
    {
      op: 'addNode',
      frame: 0,
      node: {
        type: 'path',
        id: 'arm-right',
        name: 'Arm R',
        d: 'M 0 0 L 0 60',
        width: 20,
        height: 60,
        center: { x: 508, y: 240 },
        rotation: 0,
        opacity: 1,
        stroke: '#94a3b8',
        strokeWidth: 8
      }
    },
    ...walkPose(6, 0, 0, 0, 0, 278),
    ...walkPose(12, -25, 25, 20, -20, 290),
    ...walkPose(18, 0, 0, 0, 0, 278),
    ...walkPose(23, 25, -25, -20, 20, 290),
    { op: 'setDuration', frames: 24 }
  ]
}

/** The mouth shapes of the lip-sync example: each spends a fixed 60 px width
 * and its paired `height` keeps the drawn scale at 1:1 across the swap. */
const MOUTH_CLOSED = { d: 'M -30 0 Q 0 6 30 0 Q 0 -6 -30 0 Z', height: 6 }
const MOUTH_MID = { d: 'M -30 0 Q 0 24 30 0 Q 0 -12 -30 0 Z', height: 18 }
const MOUTH_OPEN = { d: 'M -30 0 Q 0 44 30 0 Q 0 -20 -30 0 Z', height: 32 }

/**
 * A talking face: the mouth path swaps between closed, mid and open shapes
 * every one or two frames over 12 frames — a plain audition cadence that is
 * ready to be retimed against a real audio track (setFrame/setDuration over
 * an imported audio layer), plus a caption text node.
 */
const lipSyncText: ScriptExample = {
  name: 'Lip-sync-ready talking face',
  description:
    'A face whose mouth cycles closed/mid/open every 1–2 frames over 12 frames, plus a caption.',
  commands: [
    { op: 'addLayer', kind: 'object', name: 'Face' },
    {
      op: 'addNode',
      frame: 0,
      node: {
        type: 'primitive',
        id: 'face',
        primitive: 'ellipse',
        name: 'Face',
        width: 240,
        height: 280,
        center: { x: 480, y: 260 },
        rotation: 0,
        opacity: 1,
        fill: '#fcd9a8',
        stroke: '#c98a3d',
        strokeWidth: 4
      }
    },
    {
      op: 'addNode',
      frame: 0,
      node: {
        type: 'path',
        id: 'mouth',
        name: 'Mouth',
        d: MOUTH_CLOSED.d,
        width: 60,
        height: MOUTH_CLOSED.height,
        center: { x: 480, y: 330 },
        rotation: 0,
        opacity: 1,
        fill: '#7c2d12'
      }
    },
    // The cadence: closed → mid → open → mid → closed → mid → open → closed.
    { op: 'updateNode', nodeId: 'mouth', frame: 2, patch: { d: MOUTH_MID.d, height: MOUTH_MID.height } },
    { op: 'updateNode', nodeId: 'mouth', frame: 4, patch: { d: MOUTH_OPEN.d, height: MOUTH_OPEN.height } },
    { op: 'updateNode', nodeId: 'mouth', frame: 5, patch: { d: MOUTH_MID.d, height: MOUTH_MID.height } },
    { op: 'updateNode', nodeId: 'mouth', frame: 7, patch: { d: MOUTH_CLOSED.d, height: MOUTH_CLOSED.height } },
    { op: 'updateNode', nodeId: 'mouth', frame: 9, patch: { d: MOUTH_MID.d, height: MOUTH_MID.height } },
    { op: 'updateNode', nodeId: 'mouth', frame: 10, patch: { d: MOUTH_OPEN.d, height: MOUTH_OPEN.height } },
    { op: 'updateNode', nodeId: 'mouth', frame: 11, patch: { d: MOUTH_CLOSED.d, height: MOUTH_CLOSED.height } },
    {
      op: 'addNode',
      frame: 0,
      node: {
        type: 'text',
        id: 'caption',
        name: 'Caption',
        text: 'Hello!',
        fontFamily: 'Noto Sans',
        fontSize: 48,
        fontWeight: 700,
        align: 'center',
        fill: '#f8fafc',
        width: 200,
        height: 60,
        center: { x: 480, y: 470 },
        rotation: 0,
        opacity: 1
      }
    },
    { op: 'setDuration', frames: 12 }
  ]
}

export const SCRIPT_EXAMPLES: readonly ScriptExample[] = [
  bouncingBall,
  titleCardFadeIn,
  retimedSlide,
  walkCycle,
  lipSyncText
]
