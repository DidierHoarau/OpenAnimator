import type { Vec2 } from './geometry'
import type { Shape } from './model'

/**
 * Tests whether a stage-space point hits a shape, taking rotation into
 * account by transforming the point into the shape's local space.
 */
export function hitTestShape(shape: Shape, point: Vec2): boolean {
  const radians = (-shape.rotation * Math.PI) / 180
  const dx = point.x - shape.center.x
  const dy = point.y - shape.center.y
  const x = dx * Math.cos(radians) - dy * Math.sin(radians)
  const y = dx * Math.sin(radians) + dy * Math.cos(radians)

  if (shape.kind === 'ellipse') {
    const rx = shape.width / 2
    const ry = shape.height / 2
    if (rx <= 0 || ry <= 0) return false
    return (x / rx) ** 2 + (y / ry) ** 2 <= 1
  }

  return Math.abs(x) <= shape.width / 2 && Math.abs(y) <= shape.height / 2
}

/** Topmost shape of `shapes` (later entries win) containing `point`. */
export function hitTestShapes(shapes: Shape[], point: Vec2): Shape | undefined {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (hitTestShape(shapes[i], point)) return shapes[i]
  }
  return undefined
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Axis-aligned bounding box of a shape in stage coordinates, taking rotation
 * into account (the box of the rotated bounding rectangle). Used by the
 * selection overlay and the rubber-band marquee.
 */
export function shapeBounds(shape: Shape): Rect {
  const radians = (shape.rotation * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  const width = shape.width * cos + shape.height * sin
  const height = shape.width * sin + shape.height * cos
  return {
    x: shape.center.x - width / 2,
    y: shape.center.y - height / 2,
    width,
    height
  }
}

/** Tests whether two axis-aligned rectangles intersect (edges touching count). */
export function rectIntersectsRect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
  )
}
