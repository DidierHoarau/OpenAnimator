import type { Vec2 } from './geometry'

/**
 * Grid snapping helpers (pure). A non-positive or non-finite step disables
 * snapping, so callers can pass `editor.gridSnapSize` unconditionally and
 * "grid off" simply becomes step 0.
 */

/** Rounds `value` to the nearest multiple of `step`. */
export function snapValue(value: number, step: number): number {
  if (!Number.isFinite(value)) return value
  if (!Number.isFinite(step) || step <= 0) return value
  return Math.round(value / step) * step
}

export function snapPoint(point: Vec2, step: number): Vec2 {
  return { x: snapValue(point.x, step), y: snapValue(point.y, step) }
}

/**
 * Delta adjustment for a drag: snapping the resulting position (origin +
 * delta) keeps the grabbed point on the grid while preserving every other
 * selection member's relative offset.
 */
export function snappedDelta(origin: Vec2, delta: Vec2, step: number): Vec2 {
  const target = snapPoint({ x: origin.x + delta.x, y: origin.y + delta.y }, step)
  return { x: target.x - origin.x, y: target.y - origin.y }
}
