import { formatHexColor } from '@shared/color'
import { defaultExportOptions } from '@shared/exportOptions'
import type { ExportOptions } from '@shared/exportOptions'
import type { Vec2 } from '@shared/geometry'

import type { Editor } from './editor'
import { FrameRasterizer, createDefaultFrameRasterDeps } from './export/frameRaster'
import type { FrameRasterDeps } from './export/frameRaster'
import { createResourceDataUrlResolver } from './export/resourceDataUrl'

/**
 * Eyedropper sampling: rasterizes the evaluated current frame through the
 * export pipeline (scale 1, opaque so the pick sees the document background
 * like the stage does) and reads back the pixel under a stage point.
 */

/** Raster dependencies for picking: the export pipeline's wiring, with
 * resource ids resolved through the editor's resource cache. */
export function createEyedropperDeps(editor: Editor): FrameRasterDeps {
  return {
    ...createDefaultFrameRasterDeps(),
    resolveResourceDataUrl: createResourceDataUrlResolver(editor.resources)
  }
}

/**
 * Samples one stage pixel of the evaluated current frame. Returns the color
 * as `#rrggbb`, or null when the point lies outside the document. The frame
 * is rasterized fresh for every pick (`deps` is injectable for tests).
 */
export async function sampleStagePixel(
  editor: Editor,
  point: Vec2,
  deps: FrameRasterDeps = createEyedropperDeps(editor)
): Promise<string | null> {
  const x = Math.floor(point.x)
  const y = Math.floor(point.y)
  if (x < 0 || y < 0 || x >= editor.document.width || y >= editor.document.height) return null
  const options: ExportOptions = {
    ...defaultExportOptions(editor.document),
    scale: 1,
    transparent: false
  }
  const rasterizer = new FrameRasterizer(editor.document, options, deps)
  const canvas = await rasterizer.rasterizeToCanvas(editor.currentFrame)
  const rgba = rasterizer.canvasToRgba(canvas)
  const index = (y * canvas.width + x) * 4
  return formatHexColor([rgba[index], rgba[index + 1], rgba[index + 2]])
}
