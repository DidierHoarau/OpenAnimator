export interface Vec2 {
  x: number
  y: number
}

/** Linearly interpolates between `a` and `b` by `t` (0 = a, 1 = b). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Clamps a value to the [0, 1] range. */
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Cubic ease-in-out curve mapping t in [0, 1] to [0, 1]. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** Euclidean distance between two points. */
export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Tests whether a point lies inside an axis-aligned rectangle centered on `center`. */
export function pointInRect(point: Vec2, center: Vec2, width: number, height: number): boolean {
  return Math.abs(point.x - center.x) <= width / 2 && Math.abs(point.y - center.y) <= height / 2
}
