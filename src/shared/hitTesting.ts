import type { Vec2 } from './geometry'
import type { GroupNode, SceneNode } from './model'

/**
 * Tests whether a stage-space point hits a node, taking rotation into
 * account by transforming the point into the node's local space. Groups test
 * their placed box first, then their children in group-local space.
 */
export function hitTestNode(node: SceneNode, point: Vec2): boolean {
  if (node.type === 'group') return hitTestGroup(node, point)
  const radians = (-node.rotation * Math.PI) / 180
  const dx = point.x - node.center.x
  const dy = point.y - node.center.y
  const x = dx * Math.cos(radians) - dy * Math.sin(radians)
  const y = dx * Math.sin(radians) + dy * Math.cos(radians)

  if (node.type === 'primitive' && node.primitive === 'ellipse') {
    const rx = node.width / 2
    const ry = node.height / 2
    if (rx <= 0 || ry <= 0) return false
    return (x / rx) ** 2 + (y / ry) ** 2 <= 1
  }

  return Math.abs(x) <= node.width / 2 && Math.abs(y) <= node.height / 2
}

function hitTestGroup(group: GroupNode, point: Vec2): boolean {
  // Placed-box pre-test: misses never reach the children walk.
  const radians = (-group.rotation * Math.PI) / 180
  const dx = point.x - group.center.x
  const dy = point.y - group.center.y
  const x = dx * Math.cos(radians) - dy * Math.sin(radians)
  const y = dx * Math.sin(radians) + dy * Math.cos(radians)
  if (Math.abs(x) > group.width / 2 || Math.abs(y) > group.height / 2) return false

  // Inside the placed box: inverse-transform the point into the group-local
  // frame — undo the rotation around the group center, then undo the placed
  // size fold (placed → natural content scale) — and test the children.
  const natural = unionNodeBounds(group.children)
  const sx = natural.width === 0 ? 1 : group.width / natural.width
  const sy = natural.height === 0 ? 1 : group.height / natural.height
  return hitTestNodes(group.children, { x: x / sx, y: y / sy }) !== undefined
}

/** Topmost node of `nodes` (later entries win) containing `point`. */
export function hitTestNodes(nodes: SceneNode[], point: Vec2): SceneNode | undefined {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (hitTestNode(nodes[i], point)) return nodes[i]
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
 * Axis-aligned bounding box of a node in stage coordinates, taking rotation
 * into account (the box of the rotated bounding rectangle). Used by the
 * selection overlay, the rubber-band marquee and group bounding computation.
 */
export function nodeBounds(node: SceneNode): Rect {
  const radians = (node.rotation * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  const width = node.width * cos + node.height * sin
  const height = node.width * sin + node.height * cos
  return {
    x: node.center.x - width / 2,
    y: node.center.y - height / 2,
    width,
    height
  }
}

/**
 * Union of the bounds of `nodes`. Returns a zero-size box at the origin for
 * an empty list. This is the natural content size of a group's children in
 * group-local space.
 */
export function unionNodeBounds(nodes: SceneNode[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    const box = nodeBounds(node)
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Tests whether two axis-aligned rectangles intersect (edges touching count). */
export function rectIntersectsRect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
  )
}
