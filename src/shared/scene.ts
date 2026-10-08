import type { Vec2 } from './geometry'

/** Properties of a shape that can be keyframed over the scene timeline. */
export type AnimatableProperty = 'center.x' | 'center.y' | 'rotation' | 'opacity'

export type Easing = 'linear' | 'ease-in-out'

/** A single keyframe track animating one property of a shape. */
export interface Keyframe {
  property: AnimatableProperty
  from: number
  to: number
  /** Time in milliseconds, relative to the start of the scene timeline. */
  startMs: number
  /** Time in milliseconds, relative to the start of the scene timeline. */
  endMs: number
  easing: Easing
}

export type ShapeKind = 'rect' | 'ellipse'

/** A vector shape positioned in scene coordinates, centered on `center`. */
export interface Shape {
  id: string
  kind: ShapeKind
  center: Vec2
  width: number
  height: number
  /** Rotation in degrees around the shape center. */
  rotation: number
  fill: string
  stroke?: string
  strokeWidth?: number
  opacity: number
  keyframes: Keyframe[]
}

/** A vector scene: a fixed-size stage with shapes animated over a looping timeline. */
export interface Scene {
  width: number
  height: number
  /** Total duration of one timeline loop in milliseconds (0 disables looping). */
  durationMs: number
  shapes: Shape[]
}

/** Demo scene rendered by the scaffold until the editor UI is implemented. */
export function createDefaultScene(): Scene {
  return {
    width: 960,
    height: 540,
    durationMs: 4000,
    shapes: [
      {
        id: 'backdrop',
        kind: 'rect',
        center: { x: 480, y: 270 },
        width: 960,
        height: 540,
        rotation: 0,
        fill: '#10151b',
        opacity: 1,
        keyframes: []
      },
      {
        id: 'ball',
        kind: 'ellipse',
        center: { x: 160, y: 270 },
        width: 96,
        height: 96,
        rotation: 0,
        fill: '#f59e0b',
        stroke: '#fcd34d',
        strokeWidth: 4,
        opacity: 1,
        keyframes: [
          { property: 'center.x', from: 160, to: 800, startMs: 0, endMs: 2000, easing: 'ease-in-out' },
          { property: 'center.x', from: 800, to: 160, startMs: 2000, endMs: 4000, easing: 'ease-in-out' }
        ]
      },
      {
        id: 'spinner',
        kind: 'rect',
        center: { x: 480, y: 420 },
        width: 160,
        height: 24,
        rotation: 0,
        fill: '#38bdf8',
        opacity: 1,
        keyframes: [
          { property: 'rotation', from: 0, to: 360, startMs: 0, endMs: 4000, easing: 'linear' }
        ]
      }
    ]
  }
}
