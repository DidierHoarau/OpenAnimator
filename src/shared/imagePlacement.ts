import type { Vec2 } from './geometry'

/** Placed size and center of a newly imported image. */
export interface ImagePlacement {
  width: number
  height: number
  center: Vec2
}

/**
 * Placement of an image with the given natural pixel size onto a stage:
 * natural size when it fits, otherwise scaled down proportionally so the
 * whole image stays within the stage (never upscaled). The image is centered
 * on `center` — the stage center when no drop point is given.
 */
export function fitImagePlacement(
  natural: { width: number; height: number },
  stage: { width: number; height: number },
  center?: Vec2
): ImagePlacement {
  const naturalWidth = Math.max(0, natural.width)
  const naturalHeight = Math.max(0, natural.height)
  let scale = 1
  if (naturalWidth > stage.width || naturalHeight > stage.height) {
    scale = Math.min(
      naturalWidth === 0 ? 1 : stage.width / naturalWidth,
      naturalHeight === 0 ? 1 : stage.height / naturalHeight
    )
  }
  const target = center ?? { x: stage.width / 2, y: stage.height / 2 }
  return {
    width: naturalWidth * scale,
    height: naturalHeight * scale,
    center: { x: target.x, y: target.y }
  }
}
