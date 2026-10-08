import { clamp01, easeInOutCubic, lerp } from './geometry'
import type { Vec2 } from './geometry'
import type { Easing, Keyframe, Scene, Shape } from './scene'

/** Snapshot of a shape's animated state at a given point in time. */
export interface EvaluatedShape {
  id: string
  center: Vec2
  width: number
  height: number
  rotation: number
  opacity: number
}

export function evaluateEasing(easing: Easing, t: number): number {
  return easing === 'linear' ? t : easeInOutCubic(t)
}

/**
 * Resolves the value of one property at time `t`: holds the shape's static
 * value before the first keyframe and the last `to` value after the final one.
 */
function propertyValue(keyframes: Keyframe[], property: Keyframe['property'], t: number, fallback: number): number {
  let active: Keyframe | undefined
  for (const keyframe of keyframes) {
    if (keyframe.property === property && keyframe.startMs <= t) {
      active = keyframe
    }
  }
  if (!active) return fallback
  if (t >= active.endMs) return active.to
  const progress = (t - active.startMs) / (active.endMs - active.startMs)
  return lerp(active.from, active.to, evaluateEasing(active.easing, clamp01(progress)))
}

/** Evaluates a single shape at `timeMs`, looping over the scene duration. */
export function evaluateShape(scene: Scene, shape: Shape, timeMs: number): EvaluatedShape {
  const t =
    scene.durationMs > 0 ? ((timeMs % scene.durationMs) + scene.durationMs) % scene.durationMs : timeMs
  return {
    id: shape.id,
    center: {
      x: propertyValue(shape.keyframes, 'center.x', t, shape.center.x),
      y: propertyValue(shape.keyframes, 'center.y', t, shape.center.y)
    },
    width: shape.width,
    height: shape.height,
    rotation: propertyValue(shape.keyframes, 'rotation', t, shape.rotation),
    opacity: propertyValue(shape.keyframes, 'opacity', t, shape.opacity)
  }
}

/** Evaluates every shape of the scene at `timeMs`. */
export function evaluateScene(scene: Scene, timeMs: number): EvaluatedShape[] {
  return scene.shapes.map((shape) => evaluateShape(scene, shape, timeMs))
}
