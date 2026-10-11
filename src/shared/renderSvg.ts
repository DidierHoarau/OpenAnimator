import { groupNaturalSize } from './groups'
import type { GroupNode, ImageNode, PathNode, PrimitiveNode, SceneNode, SymbolNode, TextNode } from './model'
import { layoutText } from './textModel'
import { pathNaturalSize } from './pathModel'
import type { RenderLayer } from './render'

/**
 * Object-URL resolver injected by the DOM renderer: maps a resource id to its
 * blob URL, or null when the resource is missing/corrupt (placeholder box).
 * The pure evaluator never touches URLs — only this renderer entry point does.
 */
export type ResourceResolver = (resourceId: string) => string | null

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

function groupToSvgMarkup(node: GroupNode, resolveResource: ResourceResolver | undefined): string {
  const natural = groupNaturalSize(node.children)
  const sx = natural.width === 0 ? 1 : node.width / natural.width
  const sy = natural.height === 0 ? 1 : node.height / natural.height
  let markup = `<g${attr(
    'transform',
    `translate(${node.center.x} ${node.center.y}) rotate(${node.rotation}) scale(${sx} ${sy})`
  )}${attr('opacity', node.opacity)}>`
  for (const child of node.children) {
    markup += nodeToSvgMarkup(child, resolveResource)
  }
  return `${markup}</g>`
}

/** Dashed placeholder box shown while an image's resource is missing or corrupt. */
function imagePlaceholderMarkup(node: ImageNode): string {
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

function imageToSvgMarkup(node: ImageNode, resolveResource: ResourceResolver | undefined): string {
  const href = resolveResource?.(node.resourceId) ?? null
  if (!href) return imagePlaceholderMarkup(node)
  let markup =
    `<image${attr('href', href)}` +
    `${attr('x', -node.width / 2)}${attr('y', -node.height / 2)}` +
    `${attr('width', node.width)}${attr('height', node.height)}` +
    attr('preserveAspectRatio', 'none')
  if (!node.smoothing) markup += attr('style', 'image-rendering: pixelated')
  markup += placementAttrs(node.center, node.rotation, node.opacity)
  return `${markup}/>`
}

/**
 * SVG markup for a path node: the geometry is drawn in its natural local
 * coordinates and the placed size is folded into the transform (the path data
 * is normalized to a (0,0)-centered bbox at creation, so scaling around the
 * origin keeps it centered).
 */
function pathToSvgMarkup(node: PathNode): string {
  const natural = pathNaturalSize(node)
  const sx = natural.width === 0 ? 1 : node.width / natural.width
  const sy = natural.height === 0 ? 1 : node.height / natural.height
  let markup =
    `<g${attr(
      'transform',
      `translate(${node.center.x} ${node.center.y}) rotate(${node.rotation}) scale(${sx} ${sy})`
    )}${attr('opacity', node.opacity)}><path${attr('d', node.d)}` +
    attr('fill', node.fill ?? 'none')
  if (node.stroke !== undefined) markup += attr('stroke', node.stroke)
  if (node.strokeWidth !== undefined) markup += attr('stroke-width', node.strokeWidth)
  return `${markup}/></g>`
}

/** SVG markup for a text node: one `<tspan>` per explicit line, positioned
 * by the shared layout math. Text content is XML-escaped. */
function textToSvgMarkup(node: TextNode): string {
  const layout = layoutText(node)
  let markup =
    `<text${attr('font-family', node.fontFamily)}` +
    `${attr('font-size', node.fontSize)}` +
    `${attr('font-weight', node.fontWeight)}` +
    `${attr('fill', node.fill)}` +
    `${attr('text-anchor', layout.anchor)}` +
    placementAttrs(node.center, node.rotation, node.opacity) +
    '>'
  for (let i = 0; i < layout.lines.length; i++) {
    markup += `<tspan${attr('x', layout.anchorX)}${attr('y', layout.baselines[i])}>${escapeXmlAttribute(layout.lines[i])}</tspan>`
  }
  return `${markup}</text>`
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
 * (children are never re-encoded); images render as `<image href>` when the
 * injected resolver yields a URL, and as a dashed placeholder box otherwise
 * (no resolver, missing or corrupt resource); symbols stay dashed placeholder
 * boxes until the asset-library phase. Every attribute value is XML-escaped,
 * so document data can never inject markup.
 */
export function nodeToSvgMarkup(node: SceneNode, resolveResource?: ResourceResolver): string {
  switch (node.type) {
    case 'group':
      return groupToSvgMarkup(node, resolveResource)
    case 'image':
      return imageToSvgMarkup(node, resolveResource)
    case 'symbol':
      return symbolToSvgMarkup(node)
    case 'primitive':
      return primitiveToSvgMarkup(node)
    case 'path':
      return pathToSvgMarkup(node)
    case 'text':
      return textToSvgMarkup(node)
  }
}

/**
 * Concatenates evaluated layers into one SVG fragment in paint order,
 * usable as innerHTML of an SVG group element.
 */
export function renderLayersToSvgMarkup(
  layers: RenderLayer[],
  resolveResource?: ResourceResolver
): string {
  let markup = ''
  for (const layer of layers) {
    for (const node of layer.nodes) {
      markup += nodeToSvgMarkup(node, resolveResource)
    }
  }
  return markup
}
