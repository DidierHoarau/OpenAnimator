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

export const SCRIPT_EXAMPLES: readonly ScriptExample[] = [
  bouncingBall,
  titleCardFadeIn,
  retimedSlide
]
