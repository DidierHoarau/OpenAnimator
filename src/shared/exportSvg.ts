import { evaluateDocumentAtFrame } from './render'
import { renderLayersToSvgMarkup } from './renderSvg'
import type { ResourceResolver } from './renderSvg'
import type { AnimatorDocument, CameraPose } from './model'

/** Formats a transform number without floating-point noise, normalizing -0. */
function formatTransformNumber(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6
  return String(rounded === 0 ? 0 : rounded)
}

/**
 * SVG transform of a camera pose: document point `p` renders at
 * `R(−rotation) · S(zoom) · (p − center) + (W/2, H/2)` around the stage
 * center. Exported for tests.
 */
export function cameraTransform(payload: CameraPose, width: number, height: number): string {
  const n = formatTransformNumber
  return (
    `translate(${n(width / 2)} ${n(height / 2)})` +
    ` rotate(${n(-payload.rotation)})` +
    ` scale(${n(payload.zoom)})` +
    ` translate(${n(-payload.center.x)} ${n(-payload.center.y)})`
  )
}

/**
 * Standalone SVG source of one evaluated frame — the rasterization input
 * shared by the renderer export pipeline (canvas path) and the headless CLI
 * (resvg path). The backdrop rect is omitted when `transparent` is set so
 * alpha formats keep the document's empty areas see-through. An
 * `embeddedFontStyle` block (`@font-face` rules over data: URLs) is emitted
 * right after the `<svg>` open tag; `resolveEmbeddedFont` threads the
 * embedded-subset family into the text markup. An active camera wraps the
 * layer markup in one `<g transform>` — camera-less documents keep emitting
 * the exact same markup as before.
 */
export function documentToSvgString(
  document: AnimatorDocument,
  frame: number,
  resolveResource?: ResourceResolver,
  options: {
    transparent?: boolean
    embeddedFontStyle?: string
    resolveEmbeddedFont?: (family: string, weight: number, italic?: boolean) => string | null
  } = {}
): string {
  const evaluated = evaluateDocumentAtFrame(document, frame)
  const layerMarkup = renderLayersToSvgMarkup(evaluated.layers, resolveResource, {
    resolveEmbeddedFont: options.resolveEmbeddedFont
  })
  const markup = evaluated.camera
    ? `<g transform="${cameraTransform(evaluated.camera, document.width, document.height)}">${layerMarkup}</g>`
    : layerMarkup
  const backdrop = options.transparent
    ? ''
    : `<rect x="0" y="0" width="${document.width}" height="${document.height}" fill="${document.background}"/>`
  const fontStyle = options.embeddedFontStyle ? `<style>${options.embeddedFontStyle}</style>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${document.width}" height="${document.height}"` +
    ` viewBox="0 0 ${document.width} ${document.height}">` +
    fontStyle +
    backdrop +
    markup +
    '</svg>'
  )
}
