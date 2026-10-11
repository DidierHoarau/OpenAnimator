import type { Vec2 } from './geometry'
import type { GroupNode, SceneNode } from './model'
import { cloneNode } from './model'
import { unionNodeBounds } from './hitTesting'

/**
 * Groups `nodes` into one group node: the group origin lands at the center of
 * the selection bounds and the children are re-expressed in the group-local
 * frame (origin = group center). The children are deep-cloned, so the input
 * nodes are never mutated. Throws on an empty selection.
 */
export function groupNodes(nodes: SceneNode[], id: string): GroupNode {
  if (nodes.length === 0) throw new Error('cannot group an empty selection')
  const bounds = unionNodeBounds(nodes)
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const children = nodes.map((node) => {
    const local = cloneNode(node)
    local.center = { x: local.center.x - center.x, y: local.center.y - center.y }
    return local
  })
  return {
    id,
    type: 'group',
    center,
    width: bounds.width,
    height: bounds.height,
    rotation: 0,
    opacity: 1,
    children
  }
}

/** Natural content size of a group's children (bounds in group-local space,
 * where the children live at scale 1). */
export function groupNaturalSize(children: SceneNode[]): { width: number; height: number } {
  const bounds = unionNodeBounds(children)
  return { width: bounds.width, height: bounds.height }
}

function rotate(point: Vec2, rotationDegrees: number): Vec2 {
  const radians = (rotationDegrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos
  }
}

/**
 * Dissolves a group: every child is composed back into the group's parent
 * space — the group's translation, rotation, scale (placed size over natural
 * content size) and opacity fold into the children, whose identity fields are
 * preserved. At creation-time transforms (rotation 0, scale 1, opacity 1)
 * this is an exact identity. The input group is never mutated.
 */
export function ungroupNode(group: GroupNode): SceneNode[] {
  const natural = groupNaturalSize(group.children)
  const sx = natural.width === 0 ? 1 : group.width / natural.width
  const sy = natural.height === 0 ? 1 : group.height / natural.height
  return group.children.map((child) => {
    const parent = cloneNode(child)
    const scaled = { x: child.center.x * sx, y: child.center.y * sy }
    const rotated = rotate(scaled, group.rotation)
    parent.center = {
      x: group.center.x + rotated.x,
      y: group.center.y + rotated.y
    }
    parent.width *= sx
    parent.height *= sy
    parent.rotation += group.rotation
    parent.opacity *= group.opacity
    return parent
  })
}
