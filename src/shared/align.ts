import type { Rect } from './hitTesting'

/**
 * Align and distribute math (pure): per-rect offsets against the union bounds
 * of the selection (align) or even center spacing with the outermost two
 * members fixed (distribute). The editor applies the offsets through the
 * regular node-update pipeline, so auto-keying and undo behave like a drag.
 */

export const ALIGN_MODES = ['left', 'centerH', 'right', 'top', 'middle', 'bottom'] as const
export type AlignMode = (typeof ALIGN_MODES)[number]
export const DISTRIBUTE_AXES = ['h', 'v'] as const
export type DistributeAxis = (typeof DISTRIBUTE_AXES)[number]

export interface Offset {
  dx: number
  dy: number
}

function unionBounds(rects: readonly Rect[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const rect of rects) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Per-rect offsets that align every rect to the union bounds. */
export function alignOffsets(rects: readonly Rect[], mode: AlignMode): Offset[] {
  if (rects.length === 0) return []
  const union = unionBounds(rects)
  return rects.map((rect) => {
    switch (mode) {
      case 'left':
        return { dx: union.x - rect.x, dy: 0 }
      case 'centerH':
        return { dx: union.x + union.width / 2 - (rect.x + rect.width / 2), dy: 0 }
      case 'right':
        return { dx: union.x + union.width - (rect.x + rect.width), dy: 0 }
      case 'top':
        return { dx: 0, dy: union.y - rect.y }
      case 'middle':
        return { dx: 0, dy: union.y + union.height / 2 - (rect.y + rect.height / 2) }
      case 'bottom':
        return { dx: 0, dy: union.y + union.height - (rect.y + rect.height) }
    }
  })
}

/**
 * Per-rect offsets that space the rect centers evenly along `axis`, keeping
 * the first and last (by center) fixed. Fewer than three rects or a zero
 * spread produces zero offsets.
 */
export function distributeOffsets(rects: readonly Rect[], axis: DistributeAxis): Offset[] {
  const offsets: Offset[] = rects.map(() => ({ dx: 0, dy: 0 }))
  if (rects.length < 3) return offsets
  const centerOf = (rect: Rect): number =>
    axis === 'h' ? rect.x + rect.width / 2 : rect.y + rect.height / 2
  const order = rects.map((_, index) => index).sort((a, b) => centerOf(rects[a]) - centerOf(rects[b]))
  const first = centerOf(rects[order[0]])
  const last = centerOf(rects[order[order.length - 1]])
  const step = (last - first) / (order.length - 1)
  order.forEach((index, position) => {
    const shift = first + position * step - centerOf(rects[index])
    if (axis === 'h') offsets[index].dx = shift
    else offsets[index].dy = shift
  })
  return offsets
}
