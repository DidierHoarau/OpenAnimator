import type { Vec2 } from './geometry'
import type { EasingName } from './easing'

export type ShapeKind = 'rect' | 'ellipse'

/** A vector shape positioned in stage coordinates, centered on `center`. */
export interface Shape {
  id: string
  kind: ShapeKind
  /** Display name shown in the timeline tree; falls back to the kind label. */
  name?: string
  center: Vec2
  width: number
  height: number
  /** Rotation in degrees around the shape center. */
  rotation: number
  fill: string
  stroke?: string
  strokeWidth?: number
  opacity: number
}

/** Classic tween attached to a keyframe: interpolates toward the next keyframe. */
export interface KeyframeTween {
  easing: EasingName
}

/** A keyframe holds layer content starting at its `frame` until the next keyframe. */
export interface Keyframe {
  frame: number
  shapes: Shape[]
  tween?: KeyframeTween
}

export interface Layer {
  id: string
  name: string
  visible: boolean
  locked: boolean
  /** Keyframes sorted by ascending `frame`. */
  keyframes: Keyframe[]
}

/** The authoring document. `layers[0]` is the topmost layer. */
export interface AnimatorDocument {
  name: string
  width: number
  height: number
  fps: number
  background: string
  layers: Layer[]
  /**
   * Authored timeline length in frames. Optional for documents saved before
   * this field existed; when absent the duration is derived from keyframes.
   */
  frames?: number
}

/** Independent copy of a shape, including nested objects like `center`. */
export function cloneShape(shape: Shape): Shape {
  return { ...shape, center: { ...shape.center } }
}
