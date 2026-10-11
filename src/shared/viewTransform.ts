import type { Vec2 } from './geometry'

/**
 * Stage-view zoom/pan state. Lives only in the stage view — it is never part
 * of the document and never saved.
 *
 * `tx`/`ty` are the stage coordinates of the top-left corner of the visible
 * viewBox; `scale` is the zoom factor applied to the document's stage size
 * (the visible viewBox measures `stageWidth / scale` × `stageHeight / scale`).
 */
export interface ViewTransform {
  scale: number
  tx: number
  ty: number
}

export const MIN_SCALE = 0.1
export const MAX_SCALE = 8

export function identityView(): ViewTransform {
  return { scale: 1, tx: 0, ty: 0 }
}

/** Clamps a scale factor to the supported zoom range. */
export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/**
 * Zooms the view by `factor` while keeping the stage-space `focus` point
 * (e.g. the cursor) visually fixed: the view origin moves so the focus stays
 * at the same position on screen.
 */
export function zoomAtView(view: ViewTransform, focus: Vec2, factor: number): ViewTransform {
  const scale = clampScale(view.scale * factor)
  const ratio = view.scale / scale
  return {
    scale,
    tx: focus.x - (focus.x - view.tx) * ratio,
    ty: focus.y - (focus.y - view.ty) * ratio
  }
}

/** Moves the visible window by `dx`/`dy` in stage coordinates. */
export function panView(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy }
}
