import { lerpHexColor } from './color'
import { lerp } from './geometry'
import type { Shape } from './model'
import { cloneShape } from './model'

/**
 * Interpolates a shape between two keyframe contents matched by id. Shapes
 * whose kind differs between keyframes snap from `from` to `to` at the ends.
 */
export function tweenShape(from: Shape, to: Shape, t: number): Shape {
  if (from.kind !== to.kind) {
    return t < 1 ? cloneShape(from) : cloneShape(to)
  }
  return {
    id: from.id,
    kind: from.kind,
    ...(from.name !== undefined ? { name: from.name } : {}),
    center: {
      x: lerp(from.center.x, to.center.x, t),
      y: lerp(from.center.y, to.center.y, t)
    },
    width: lerp(from.width, to.width, t),
    height: lerp(from.height, to.height, t),
    rotation: lerp(from.rotation, to.rotation, t),
    opacity: lerp(from.opacity, to.opacity, t),
    fill: lerpHexColor(from.fill, to.fill, t) ?? (t < 1 ? from.fill : to.fill),
    stroke: lerpHexColor(from.stroke ?? '', to.stroke ?? '', t) ?? (from.stroke ?? to.stroke),
    strokeWidth:
      from.strokeWidth !== undefined && to.strokeWidth !== undefined
        ? lerp(from.strokeWidth, to.strokeWidth, t)
        : (to.strokeWidth ?? from.strokeWidth)
  }
}

/**
 * Interpolates a span of content: every `from` shape with an id present in
 * `to` is tweened; shapes only present in `from` hold static. Shapes only
 * present in `to` belong to the next span and are not rendered here.
 */
export function tweenShapes(from: Shape[], to: Shape[], t: number): Shape[] {
  const targets = new Map(to.map((shape) => [shape.id, shape]))
  return from.map((shape) => {
    const target = targets.get(shape.id)
    return target ? tweenShape(shape, target, t) : cloneShape(shape)
  })
}
