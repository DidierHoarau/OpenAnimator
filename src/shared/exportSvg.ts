import { evaluateDocumentAtFrame } from './render'
import { renderLayersToSvgMarkup } from './renderSvg'
import type { ResourceResolver } from './renderSvg'
import type { AnimatorDocument } from './model'

/**
 * Standalone SVG source of one evaluated frame — the rasterization input
 * shared by the renderer export pipeline (canvas path) and the headless CLI
 * (resvg path). The backdrop rect is omitted when `transparent` is set so
 * alpha formats keep the document's empty areas see-through. An
 * `embeddedFontStyle` block (`@font-face` rules over data: URLs) is emitted
 * right after the `<svg>` open tag; `resolveEmbeddedFont` threads the
 * embedded-subset family into the text markup.
 */
export function documentToSvgString(
  document: AnimatorDocument,
  frame: number,
  resolveResource?: ResourceResolver,
  options: {
    transparent?: boolean
    embeddedFontStyle?: string
    resolveEmbeddedFont?: (family: string, weight: number) => string | null
  } = {}
): string {
  const markup = renderLayersToSvgMarkup(
    evaluateDocumentAtFrame(document, frame),
    resolveResource,
    { resolveEmbeddedFont: options.resolveEmbeddedFont }
  )
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
