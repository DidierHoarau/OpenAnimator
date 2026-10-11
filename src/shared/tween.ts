import { lerpHexColor } from './color'
import { lerp } from './geometry'
import type { SceneNode } from './model'
import { cloneNode } from './model'

/**
 * Interpolates a node between two keyframe contents matched by id. Every node
 * type lerps transform + opacity; primitives additionally lerp fill, stroke
 * and stroke width. Identity fields (id, name, type, resourceId, assetId,
 * children, …) never interpolate — they come from `from`. Nodes whose type
 * differs (or primitives of a different `primitive` kind) snap from `from` to
 * `to` at the ends.
 */
export function tweenNode(from: SceneNode, to: SceneNode, t: number): SceneNode {
  if (from.type !== to.type) {
    return t < 1 ? cloneNode(from) : cloneNode(to)
  }
  const base = {
    id: from.id,
    ...(from.name !== undefined ? { name: from.name } : {}),
    center: {
      x: lerp(from.center.x, to.center.x, t),
      y: lerp(from.center.y, to.center.y, t)
    },
    width: lerp(from.width, to.width, t),
    height: lerp(from.height, to.height, t),
    rotation: lerp(from.rotation, to.rotation, t),
    opacity: lerp(from.opacity, to.opacity, t)
  }
  if (from.type === 'image') {
    return {
      ...base,
      type: 'image',
      resourceId: from.resourceId,
      naturalWidth: from.naturalWidth,
      naturalHeight: from.naturalHeight,
      smoothing: from.smoothing
    }
  }
  if (from.type === 'group') {
    // Groups tween as one unit: children are never interpolated.
    return { ...base, type: 'group', children: from.children }
  }
  if (from.type === 'symbol') {
    return { ...base, type: 'symbol', assetId: from.assetId }
  }
  if (from.type === 'path') {
    // Path geometry and paints snap from `from`; the transform and stroke
    // width interpolate.
    return {
      ...base,
      type: 'path',
      d: from.d,
      fill: from.fill,
      stroke: from.stroke,
      strokeWidth:
        from.strokeWidth !== undefined && to.type === 'path' && to.strokeWidth !== undefined
          ? lerp(from.strokeWidth, to.strokeWidth, t)
          : from.strokeWidth
    }
  }
  if (from.type === 'text') {
    // Text content and font identity snap from `from`; the font size (and
    // with it the laid-out box) interpolates.
    return {
      ...base,
      type: 'text',
      text: from.text,
      fontFamily: from.fontFamily,
      fontSize: to.type === 'text' ? lerp(from.fontSize, to.fontSize, t) : from.fontSize,
      fontWeight: from.fontWeight,
      fill: from.fill,
      align: from.align
    }
  }
  if (to.type !== 'primitive' || from.primitive !== to.primitive) {
    // Unreachable at runtime (the types were matched above); snapping keeps
    // the interpolation total.
    return t < 1 ? cloneNode(from) : cloneNode(to)
  }
  return {
    ...base,
    type: 'primitive',
    primitive: from.primitive,
    fill: lerpHexColor(from.fill, to.fill, t) ?? (t < 1 ? from.fill : to.fill),
    stroke: lerpHexColor(from.stroke ?? '', to.stroke ?? '', t) ?? (from.stroke ?? to.stroke),
    strokeWidth:
      from.strokeWidth !== undefined && to.strokeWidth !== undefined
        ? lerp(from.strokeWidth, to.strokeWidth, t)
        : (to.strokeWidth ?? from.strokeWidth)
  }
}

/**
 * Interpolates a span of content: every `from` node with an id present in
 * `to` is tweened; nodes only present in `from` hold static. Nodes only
 * present in `to` belong to the next span and are not rendered here.
 */
export function tweenNodes(from: SceneNode[], to: SceneNode[], t: number): SceneNode[] {
  const targets = new Map(to.map((node) => [node.id, node]))
  return from.map((node) => {
    const target = targets.get(node.id)
    return target ? tweenNode(node, target, t) : cloneNode(node)
  })
}
