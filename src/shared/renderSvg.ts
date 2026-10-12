import { fontFamilyListFor } from './fontPolicy'
import { groupNaturalSize } from './groups'
import type { GroupNode, ImageNode, PathNode, PrimitiveNode, SceneNode, SymbolNode, TextNode } from './model'
import { paintGradientId } from './paint'
import type { GradientPaint, Paint } from './paint'
import { layoutText } from './textModel'
import { pathNaturalSize } from './pathModel'
import type { RenderLayer } from './render'

/**
 * Object-URL resolver injected by the DOM renderer: maps a resource id to its
 * blob URL, or null when the resource is missing/corrupt (placeholder box).
 * The pure evaluator never touches URLs — only this renderer entry point does.
 */
export type ResourceResolver = (resourceId: string) => string | null

/**
 * Optional render style. `outline` draws primitives and paths stroke-only in
 * one flat color (the onion-skin outline approximation); groups keep their
 * normal wrapper markup so their primitive/path children still outline, while
 * symbols, images and text keep their normal markup. `resolveEmbeddedFont`
 * yields the synthetic family of an embedded subset for a (family, weight)
 * pair; text then renders through the full CSS family list (subset first,
 * `'Noto Sans', sans-serif` last). Absent options ⇒ byte-identical markup to
 * the historical renderer.
 */
export interface SvgRenderOptions {
  outline?: { color: string }
  resolveEmbeddedFont?: (family: string, weight: number) => string | null
}

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

/** Ids of the gradient defs emitted during one render, in emission order. */
type GradientDefs = Map<string, string>

function roundUnit(value: number): number {
  return Math.round(value * 10000) / 10000
}

/** `<defs>` entry of one gradient paint: `objectBoundingBox` units keep the
 * gradient attached to the painted element's bbox, so stage markup, library
 * thumbnails, onion ghosts and the export pipeline all render identically.
 * Stops are XML-escaped like every other attribute value. */
function gradientDefMarkup(paint: GradientPaint, id: string): string {
  const stops = paint.stops
    .map((stop) => `<stop${attr('offset', roundUnit(stop.offset))}${attr('stop-color', stop.color)}/>`)
    .join('')
  if (paint.type === 'linear') {
    const angle = (paint.angle * Math.PI) / 180
    return (
      `<linearGradient${attr('id', id)}${attr('gradientUnits', 'objectBoundingBox')}` +
      `${attr('x1', roundUnit(0.5 - 0.5 * Math.cos(angle)))}` +
      `${attr('y1', roundUnit(0.5 - 0.5 * Math.sin(angle)))}` +
      `${attr('x2', roundUnit(0.5 + 0.5 * Math.cos(angle)))}` +
      `${attr('y2', roundUnit(0.5 + 0.5 * Math.sin(angle)))}>${stops}</linearGradient>`
    )
  }
  return (
    `<radialGradient${attr('id', id)}${attr('gradientUnits', 'objectBoundingBox')}` +
    `${attr('cx', paint.cx)}${attr('cy', paint.cy)}${attr('r', paint.r)}>${stops}</radialGradient>`
  )
}

/** Attribute value of a paint: the solid color itself, or a `url(#…)`
 * reference to the content-hashed gradient def — registered in `defs` once
 * per unique paint. */
function paintAttribute(paint: Paint, defs: GradientDefs): string {
  if (typeof paint === 'string') return paint
  const id = paintGradientId(paint)
  if (!defs.has(id)) defs.set(id, gradientDefMarkup(paint, id))
  return `url(#${id})`
}

function defsMarkup(defs: GradientDefs): string {
  if (defs.size === 0) return ''
  return `<defs>${[...defs.values()].join('')}</defs>`
}

function primitiveToSvgMarkup(
  node: PrimitiveNode,
  outline: { color: string } | undefined,
  defs: GradientDefs
): string {
  let markup: string
  if (node.primitive === 'ellipse') {
    markup = `<ellipse${attr('rx', node.width / 2)}${attr('ry', node.height / 2)}`
  } else {
    markup =
      `<rect${attr('x', -node.width / 2)}${attr('y', -node.height / 2)}` +
      `${attr('width', node.width)}${attr('height', node.height)}`
  }
  if (outline) {
    markup +=
      attr('fill', 'none') +
      attr('stroke', outline.color) +
      attr('stroke-width', 1) +
      attr('vector-effect', 'non-scaling-stroke')
  } else {
    markup += attr('fill', paintAttribute(node.fill, defs))
    if (node.stroke !== undefined) markup += attr('stroke', paintAttribute(node.stroke, defs))
    if (node.strokeWidth !== undefined) markup += attr('stroke-width', node.strokeWidth)
  }
  markup += placementAttrs(node.center, node.rotation, node.opacity)
  return `${markup}/>`
}

function groupToSvgMarkup(
  node: GroupNode,
  resolveResource: ResourceResolver | undefined,
  options: SvgRenderOptions | undefined,
  defs: GradientDefs
): string {
  const natural = groupNaturalSize(node.children)
  const sx = natural.width === 0 ? 1 : node.width / natural.width
  const sy = natural.height === 0 ? 1 : node.height / natural.height
  let markup = `<g${attr(
    'transform',
    `translate(${node.center.x} ${node.center.y}) rotate(${node.rotation}) scale(${sx} ${sy})`
  )}${attr('opacity', node.opacity)}>`
  for (const child of node.children) {
    markup += nodeMarkup(child, resolveResource, options, defs)
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
function pathToSvgMarkup(node: PathNode, outline: { color: string } | undefined, defs: GradientDefs): string {
  const natural = pathNaturalSize(node)
  const sx = natural.width === 0 ? 1 : node.width / natural.width
  const sy = natural.height === 0 ? 1 : node.height / natural.height
  let markup =
    `<g${attr(
      'transform',
      `translate(${node.center.x} ${node.center.y}) rotate(${node.rotation}) scale(${sx} ${sy})`
    )}${attr('opacity', node.opacity)}><path${attr('d', node.d)}`
  if (outline) {
    markup +=
      attr('fill', 'none') +
      attr('stroke', outline.color) +
      attr('stroke-width', 1) +
      attr('vector-effect', 'non-scaling-stroke')
  } else {
    markup += attr('fill', node.fill !== undefined ? paintAttribute(node.fill, defs) : 'none')
    if (node.stroke !== undefined) markup += attr('stroke', paintAttribute(node.stroke, defs))
    if (node.strokeWidth !== undefined) markup += attr('stroke-width', node.strokeWidth)
  }
  return `${markup}/></g>`
}

/** SVG markup for a text node: one `<tspan>` per explicit line, positioned
 * by the shared layout math. Text content is XML-escaped. */
function textToSvgMarkup(node: TextNode, options: SvgRenderOptions | undefined, defs: GradientDefs): string {
  const layout = layoutText(node)
  const embeddedId = options?.resolveEmbeddedFont?.(node.fontFamily, node.fontWeight) ?? null
  // The extended family list (subset first, Noto Sans/sans-serif fallback
  // last) only engages when the node actually has something to extend the
  // plain family with; documents without embedding/fallbacks keep their
  // historical byte-for-byte markup.
  const family =
    embeddedId !== null || node.fontFallback !== undefined
      ? fontFamilyListFor(node, embeddedId)
      : node.fontFamily
  let markup =
    `<text${attr('font-family', family)}` +
    `${attr('font-size', node.fontSize)}` +
    `${attr('font-weight', node.fontWeight)}`
  if (layout.letterSpacing !== 0) markup += attr('letter-spacing', layout.letterSpacing)
  markup += attr('fill', paintAttribute(node.fill, defs))
  if (node.stroke !== undefined) markup += attr('stroke', paintAttribute(node.stroke, defs))
  if (node.strokeWidth !== undefined) markup += attr('stroke-width', node.strokeWidth)
  markup +=
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

/** Internal dispatch of one node, threading the shared gradient-defs map. */
function nodeMarkup(
  node: SceneNode,
  resolveResource: ResourceResolver | undefined,
  options: SvgRenderOptions | undefined,
  defs: GradientDefs
): string {
  switch (node.type) {
    case 'group':
      return groupToSvgMarkup(node, resolveResource, options, defs)
    case 'image':
      return imageToSvgMarkup(node, resolveResource)
    case 'symbol':
      return symbolToSvgMarkup(node)
    case 'primitive':
      return primitiveToSvgMarkup(node, options?.outline, defs)
    case 'path':
      return pathToSvgMarkup(node, options?.outline, defs)
    case 'text':
      return textToSvgMarkup(node, options, defs)
  }
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
 *
 * Gradient paints render as `url(#oa-grad-<hash>)` references with their
 * `<defs>` block prepended to the returned markup, so a standalone node
 * fragment is always self-contained.
 *
 * With `options.outline` set, primitives and paths (including those nested in
 * groups) render stroke-only in the outline color; every other kind keeps its
 * normal markup.
 */
export function nodeToSvgMarkup(
  node: SceneNode,
  resolveResource?: ResourceResolver,
  options?: SvgRenderOptions
): string {
  const defs: GradientDefs = new Map()
  const markup = nodeMarkup(node, resolveResource, options, defs)
  return defsMarkup(defs) + markup
}

/**
 * Concatenates evaluated layers into one SVG fragment in paint order,
 * usable as innerHTML of an SVG group element. Gradient paints share one
 * `<defs>` block across the whole fragment (one entry per unique paint).
 */
export function renderLayersToSvgMarkup(
  layers: RenderLayer[],
  resolveResource?: ResourceResolver,
  options?: SvgRenderOptions
): string {
  const defs: GradientDefs = new Map()
  let markup = ''
  for (const layer of layers) {
    for (const node of layer.nodes) {
      markup += nodeMarkup(node, resolveResource, options, defs)
    }
  }
  return defsMarkup(defs) + markup
}
