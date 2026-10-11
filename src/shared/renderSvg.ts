import type { RenderLayer } from './render'
import type { Shape } from './model'

/** Escapes a string for safe use inside a double- or single-quoted XML attribute. */
export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function attr(name: string, value: string | number): string {
  return ` ${name}="${escapeXmlAttribute(String(value))}"`
}

/**
 * SVG markup for one evaluated shape — the pure, string-based counterpart of
 * the stage's former DOM builder, byte-for-byte equivalent in output. Every
 * attribute value is XML-escaped, so document data can never inject markup.
 */
export function shapeToSvgMarkup(shape: Shape): string {
  let markup: string
  if (shape.kind === 'ellipse') {
    markup = `<ellipse${attr('rx', shape.width / 2)}${attr('ry', shape.height / 2)}`
  } else {
    markup =
      `<rect${attr('x', -shape.width / 2)}${attr('y', -shape.height / 2)}` +
      `${attr('width', shape.width)}${attr('height', shape.height)}`
  }
  markup += attr('fill', shape.fill)
  if (shape.stroke !== undefined) markup += attr('stroke', shape.stroke)
  if (shape.strokeWidth !== undefined) markup += attr('stroke-width', shape.strokeWidth)
  markup += attr(
    'transform',
    `translate(${shape.center.x} ${shape.center.y}) rotate(${shape.rotation})`
  )
  markup += attr('opacity', shape.opacity)
  return `${markup}/>`
}

/**
 * Concatenates evaluated layers into one SVG fragment in paint order,
 * usable as innerHTML of an SVG group element.
 */
export function renderLayersToSvgMarkup(layers: RenderLayer[]): string {
  let markup = ''
  for (const layer of layers) {
    for (const shape of layer.shapes) {
      markup += shapeToSvgMarkup(shape)
    }
  }
  return markup
}
