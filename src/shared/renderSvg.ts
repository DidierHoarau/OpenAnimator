import { groupNaturalSize } from './groups'
import type { GroupNode, ImageNode, PrimitiveNode, SceneNode, SymbolNode } from './model'
import type { RenderLayer } from './render'

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

function placementAttrs(center: { x: number; y: number }, rotation: number, opacity: number): string {
  return (
    attr('transform', `translate(${center.x} ${center.y}) rotate(${rotation})`) +
    attr('opacity', opacity)
  )
}

function primitiveToSvgMarkup(node: PrimitiveNode): string {
  let markup: string
  if (node.primitive === 'ellipse') {
    markup = `<ellipse${attr('rx', node.width / 2)}${attr('ry', node.height / 2)}`
  } else {
    markup =
      `<rect${attr('x', -node.width / 2)}${attr('y', -node.height / 2)}` +
      `${attr('width', node.width)}${attr('height', node.height)}`
  }
  markup += attr('fill', node.fill)
  if (node.stroke !== undefined) markup += attr('stroke', node.stroke)
  if (node.strokeWidth !== undefined) markup += attr('stroke-width', node.strokeWidth)
  markup += placementAttrs(node.center, node.rotation, node.opacity)
  return `${markup}/>`
}

function groupToSvgMarkup(node: GroupNode): string {
  const natural = groupNaturalSize(node.children)
  const sx = natural.width === 0 ? 1 : node.width / natural.width
  const sy = natural.height === 0 ? 1 : node.height / natural.height
  let markup = `<g${attr(
    'transform',
    `translate(${node.center.x} ${node.center.y}) rotate(${node.rotation}) scale(${sx} ${sy})`
  )}${attr('opacity', node.opacity)}>`
  for (const child of node.children) {
    markup += nodeToSvgMarkup(child)
  }
  return `${markup}</g>`
}

function imageToSvgMarkup(node: ImageNode): string {
  return (
    `<rect${attr('x', -node.width / 2)}${attr('y', -node.height / 2)}` +
    `${attr('width', node.width)}${attr('height', node.height)}` +
    attr('fill', 'none') +
    attr('stroke', '#94a3b8') +
    attr('stroke-dasharray', '4 4') +
    placementAttrs(node.center, node.rotation, node.opacity) +
    '/>'
  )
}

function symbolToSvgMarkup(node: SymbolNode): string {
  return (
    `<rect${attr('x', -node.width / 2)}${attr('y', -node.height / 2)}` +
    `${attr('width', node.width)}${attr('height', node.height)}` +
    attr('fill', 'none') +
    attr('stroke', '#94a3b8') +
    attr('stroke-dasharray', '4 4') +
    placementAttrs(node.center, node.rotation, node.opacity) +
    '/>'
  )
}

/**
 * SVG markup for one evaluated node — the pure, string-based counterpart of
 * the stage. Primitives keep their historical byte-for-byte markup; groups
 * render as a nested `<g>` with the placed scale folded into the transform
 * (children are never re-encoded); images and symbols render as dashed
 * placeholder boxes until their real rendering lands. Every attribute value
 * is XML-escaped, so document data can never inject markup.
 */
export function nodeToSvgMarkup(node: SceneNode): string {
  switch (node.type) {
    case 'group':
      return groupToSvgMarkup(node)
    case 'image':
      return imageToSvgMarkup(node)
    case 'symbol':
      return symbolToSvgMarkup(node)
    case 'primitive':
      return primitiveToSvgMarkup(node)
  }
}

/**
 * Concatenates evaluated layers into one SVG fragment in paint order,
 * usable as innerHTML of an SVG group element.
 */
export function renderLayersToSvgMarkup(layers: RenderLayer[]): string {
  let markup = ''
  for (const layer of layers) {
    for (const node of layer.nodes) {
      markup += nodeToSvgMarkup(node)
    }
  }
  return markup
}
