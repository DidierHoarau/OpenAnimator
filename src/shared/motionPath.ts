import type { Vec2 } from './geometry'
import type { ObjectLayer } from './model'

/** Samples taken per motion-path segment for the stage overlay. */
const SEGMENT_SAMPLES = 24

/** One point on a cubic bezier at parameter `t`. */
export function cubicBezierPoint(p0: Vec2, c1: Vec2, c2: Vec2, p1: Vec2, t: number): Vec2 {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y
  }
}

/**
 * Catmull-Rom derived bezier handles for the segment from `points[index]` to
 * `points[index + 1]`, with clamped ends so the first and last segments stay
 * inside the polyline (`c1 = p[i] + (p[i+1] − p[i−1]) / 6`, mirrored for c2).
 */
export function segmentControls(
  points: readonly Vec2[],
  index: number
): { c1: Vec2; c2: Vec2 } {
  const p1 = points[index]
  const p2 = points[index + 1]
  const p0 = points[index - 1] ?? p1
  const p3 = points[index + 2] ?? p2
  return {
    c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
    c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
  }
}

/** Spatial trajectory of one tweened node, in document coordinates. */
export interface MotionPath {
  /** One waypoint per keyframe holding the node (ascending frame). */
  waypoints: { frame: number; point: Vec2 }[]
  /** Sampled polyline for the stage overlay (tweened segments only). */
  polyline: Vec2[]
  /** True when at least one segment follows a smooth (curved) path. */
  smooth: boolean
}

/**
 * Trajectory of `nodeId` on an object layer: sampled control points derived
 * from the node's keyframe centers (no persisted handles). Only segments
 * whose source keyframe carries a tween are traversed in time, so they alone
 * form the polyline; `null` when the node never moves through a tween (< 2
 * keyframes or no tween at all).
 */
export function motionPathForNode(layer: ObjectLayer, nodeId: string): MotionPath | null {
  const waypoints: { frame: number; point: Vec2; tween: boolean; smooth: boolean }[] = []
  for (const keyframe of layer.keyframes) {
    const node = keyframe.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) continue
    waypoints.push({
      frame: keyframe.frame,
      point: { x: node.center.x, y: node.center.y },
      tween: keyframe.tween !== undefined,
      smooth: keyframe.tween?.path === 'smooth'
    })
  }
  if (waypoints.length < 2 || !waypoints.some((waypoint) => waypoint.tween)) return null
  const points = waypoints.map((waypoint) => waypoint.point)
  const polyline: Vec2[] = []
  let smooth = false
  for (let i = 0; i < waypoints.length - 1; i++) {
    // Segments whose source keyframe has no tween are never traversed in
    // time (the object jumps at the next keyframe), so they carry no path.
    if (!waypoints[i].tween) continue
    if (polyline.length === 0) polyline.push({ ...points[i] })
    const to = points[i + 1]
    if (waypoints[i].smooth) {
      smooth = true
      const { c1, c2 } = segmentControls(points, i)
      for (let sample = 1; sample <= SEGMENT_SAMPLES; sample++) {
        polyline.push(cubicBezierPoint(points[i], c1, c2, to, sample / SEGMENT_SAMPLES))
      }
    } else {
      polyline.push({ ...to })
    }
  }
  return {
    waypoints: waypoints.map(({ frame, point }) => ({ frame, point })),
    polyline,
    smooth
  }
}
