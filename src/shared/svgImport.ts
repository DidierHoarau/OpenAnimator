import { createDocumentAsset, symbolContentFromGroup } from './assets'
import { createId } from './document'
import { groupNodes } from './groups'
import { MAX_STROKE_DASH_VALUES, cloneNode } from './model'
import type { Asset, GroupNode, PathNode, PrimitiveNode, SceneNode, StrokeLinecap, StrokeLinejoin, SymbolNode } from './model'
import { normalizePathData, parsePathCommands, pathDataBounds, serializeCommands } from './pathModel'
import type { PathCommand } from './pathModel'

/**
 * Pure SVG import: a handwritten minimal XML parser (no DOM, so it is fully
 * node-testable) plus a transformer for a documented element/attribute
 * subset. Anything the subset cannot represent faithfully — unknown or
 * appearance-affecting elements/attributes, CSS classes, arcs, units other
 * than px — fails the whole import with a reason; the caller then falls back
 * to rasterizing the file, so a partial import can never render wrong
 * artwork. Flattening rule: transforms (translate/scale/rotate/matrix) are
 * baked into the geometry, and inherited paints are resolved per shape.
 *
 * Supported: `svg`/`g`, `rect` (incl. rounded corners), `circle`, `ellipse`,
 * `line`, `polyline`, `polygon`, `path` (M/L/H/V/C/S/Q/T/Z, no arcs);
 * `fill`/`stroke` (`none`, `#rgb`, `#rrggbb`), `stroke-width`, `opacity`,
 * `stroke-linecap`, `stroke-linejoin`, `stroke-dasharray` (`none` or up to 16
 * unitless/px values), `stroke-dashoffset`, the same keys in `style`, and
 * `transform`.
 */

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

/** Maximum element nesting depth of an imported SVG. */
const MAX_DEPTH = 256

// ---------------------------------------------------------------------------
// Minimal XML parser
// ---------------------------------------------------------------------------

export interface XmlElement {
  name: string
  attributes: Map<string, string>
  children: XmlElement[]
}

const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_.:-]/

function codePointOf(value: number): string | null {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return null
  try {
    return String.fromCodePoint(value)
  } catch {
    return null
  }
}

/** Decodes the XML entities an attribute value may contain; null on an
 * unknown or malformed entity. */
function decodeXmlEntities(value: string): string | null {
  let result = ''
  let index = 0
  while (index < value.length) {
    const ampersand = value.indexOf('&', index)
    if (ampersand === -1) return result + value.slice(index)
    result += value.slice(index, ampersand)
    const semicolon = value.indexOf(';', ampersand + 1)
    if (semicolon === -1 || semicolon - ampersand > 12) return null
    const entity = value.slice(ampersand + 1, semicolon)
    let decoded: string | null
    if (entity === 'amp') decoded = '&'
    else if (entity === 'lt') decoded = '<'
    else if (entity === 'gt') decoded = '>'
    else if (entity === 'quot') decoded = '"'
    else if (entity === 'apos') decoded = "'"
    else if (entity.startsWith('#x') || entity.startsWith('#X')) {
      decoded = codePointOf(parseInt(entity.slice(2), 16))
    } else if (entity.startsWith('#')) {
      decoded = codePointOf(parseInt(entity.slice(1), 10))
    } else {
      decoded = null
    }
    if (decoded === null) return null
    result += decoded
    index = semicolon + 1
  }
  return result
}

/** Parses an XML document into one root element. Prolog (declaration,
 * comments, DOCTYPE) and trailing comments are tolerated; mismatched or
 * unterminated markup fails with a reason. */
export function parseSvgXml(source: string): Parsed<XmlElement> {
  let index = 0

  const malformed = <T,>(reason: string): Parsed<T> => ({
    ok: false,
    reason: `malformed XML: ${reason}`
  })
  const skipWhitespace = (): void => {
    while (index < source.length && /\s/.test(source[index])) index++
  }
  const skipUntil = (end: string): boolean => {
    const at = source.indexOf(end, index)
    if (at === -1) return false
    index = at + end.length
    return true
  }
  const parseName = (): string | null => {
    if (index >= source.length || !NAME_START.test(source[index])) return null
    const start = index
    while (index < source.length && NAME_CHAR.test(source[index])) index++
    return source.slice(start, index)
  }
  const skipComment = (): Parsed<null> | null =>
    source.startsWith('<!--', index)
      ? skipUntil('-->')
        ? { ok: true, value: null }
        : malformed('unterminated comment')
      : null

  const parseElement = (depth: number): XmlElement | string => {
    if (depth > MAX_DEPTH) return 'malformed XML: the document is nested too deeply'
    index++
    const name = parseName()
    if (!name) return 'malformed XML: missing element name'
    const attributes = new Map<string, string>()
    for (;;) {
      skipWhitespace()
      if (index >= source.length) return 'malformed XML: unexpected end of file'
      const char = source[index]
      if (char === '>') {
        index++
        break
      }
      if (char === '/') {
        if (source[index + 1] !== '>') return 'malformed XML: malformed tag'
        index += 2
        return { name, attributes, children: [] }
      }
      const attributeName = parseName()
      if (!attributeName) return 'malformed XML: malformed attribute'
      skipWhitespace()
      if (source[index] !== '=') return `malformed XML: attribute "${attributeName}" has no value`
      index++
      skipWhitespace()
      const quote = source[index]
      if (quote !== '"' && quote !== "'") {
        return `malformed XML: attribute "${attributeName}" is not quoted`
      }
      const end = source.indexOf(quote, index + 1)
      if (end === -1) return `malformed XML: unterminated attribute "${attributeName}"`
      const raw = source.slice(index + 1, end)
      if (raw.includes('<')) return `malformed XML: "<" inside attribute "${attributeName}"`
      const value = decodeXmlEntities(raw)
      if (value === null) return `malformed XML: unsupported entity in attribute "${attributeName}"`
      if (attributes.has(attributeName)) {
        return `malformed XML: duplicate attribute "${attributeName}"`
      }
      attributes.set(attributeName, value)
      index = end + 1
    }
    const children: XmlElement[] = []
    for (;;) {
      if (index >= source.length) return `malformed XML: <${name}> is never closed`
      if (source[index] !== '<') {
        const next = source.indexOf('<', index)
        if (next === -1) return `malformed XML: <${name}> is never closed`
        index = next
        continue
      }
      if (source.startsWith('</', index)) {
        index += 2
        const closeName = parseName()
        if (!closeName || closeName !== name) {
          return `malformed XML: mismatched closing tag for <${name}>`
        }
        skipWhitespace()
        if (source[index] !== '>') return 'malformed XML: malformed closing tag'
        index++
        return { name, attributes, children }
      }
      const comment = skipComment()
      if (comment) {
        if (!comment.ok) return comment.reason
        continue
      }
      if (source.startsWith('<![CDATA[', index)) {
        if (!skipUntil(']]>')) return 'malformed XML: unterminated CDATA section'
        continue
      }
      const child = parseElement(depth + 1)
      if (typeof child === 'string') return child
      children.push(child)
    }
  }

  for (;;) {
    skipWhitespace()
    if (index >= source.length) return malformed('the document is empty')
    if (source.startsWith('<?', index)) {
      if (!skipUntil('?>')) return malformed('unterminated processing instruction')
      continue
    }
    const comment = skipComment()
    if (comment) {
      if (!comment.ok) return comment
      continue
    }
    if (source.startsWith('<!DOCTYPE', index)) {
      let cursor = index + '<!DOCTYPE'.length
      let brackets = 0
      while (cursor < source.length) {
        const char = source[cursor]
        if (char === '[') brackets++
        else if (char === ']') brackets--
        else if (char === '>' && brackets <= 0) break
        cursor++
      }
      if (cursor >= source.length) return malformed('unterminated DOCTYPE')
      index = cursor + 1
      continue
    }
    break
  }
  if (index >= source.length || source[index] !== '<' || source[index + 1] === '!' || source[index + 1] === '?') {
    return malformed('no root element')
  }
  const root = parseElement(0)
  if (typeof root === 'string') return { ok: false, reason: root }
  for (;;) {
    skipWhitespace()
    if (index >= source.length) break
    const comment = skipComment()
    if (comment) {
      if (!comment.ok) return comment
      continue
    }
    if (source.startsWith('<?', index)) {
      if (!skipUntil('?>')) return malformed('unterminated processing instruction')
      continue
    }
    return malformed('content after the root element')
  }
  return { ok: true, value: root }
}

// ---------------------------------------------------------------------------
// Affine transforms
// ---------------------------------------------------------------------------

interface Matrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f
  }
}

function applyMatrix(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }
}

const TRANSFORM_FUNCTION = /([a-zA-Z]+)\s*\(([^()]*)\)/g

/** Parses a transform list; only translate/scale/rotate/matrix are
 * supported. Functions compose left to right like CSS/SVG transform lists. */
function parseTransform(value: string): Parsed<Matrix> {
  const fail = (): Parsed<Matrix> => ({
    ok: false,
    reason: `unsupported transform "${value}"`
  })
  let matrix = IDENTITY
  let consumed = 0
  let found = false
  TRANSFORM_FUNCTION.lastIndex = 0
  let match = TRANSFORM_FUNCTION.exec(value)
  while (match) {
    if (value.slice(consumed, match.index).trim().length > 0) return fail()
    consumed = match.index + match[0].length
    found = true
    const name = match[1]
    const args = match[2]
      .split(/[\s,]+/)
      .filter((part) => part.length > 0)
      .map(Number)
    if (args.some((argument) => !Number.isFinite(argument))) return fail()
    if (name === 'translate' && (args.length === 1 || args.length === 2)) {
      matrix = multiply(matrix, {
        a: 1,
        b: 0,
        c: 0,
        d: 1,
        e: args[0],
        f: args.length === 2 ? args[1] : 0
      })
    } else if (name === 'scale' && (args.length === 1 || args.length === 2)) {
      matrix = multiply(matrix, {
        a: args[0],
        b: 0,
        c: 0,
        d: args.length === 2 ? args[1] : args[0],
        e: 0,
        f: 0
      })
    } else if (name === 'rotate' && (args.length === 1 || args.length === 3)) {
      const radians = (args[0] * Math.PI) / 180
      const cos = Math.cos(radians)
      const sin = Math.sin(radians)
      const rotation: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
      if (args.length === 1) {
        matrix = multiply(matrix, rotation)
      } else {
        const translate = (e: number, f: number): Matrix => ({ a: 1, b: 0, c: 0, d: 1, e, f })
        matrix = multiply(matrix, multiply(translate(args[1], args[2]), multiply(rotation, translate(-args[1], -args[2]))))
      }
    } else if (name === 'matrix' && args.length === 6) {
      matrix = multiply(matrix, {
        a: args[0],
        b: args[1],
        c: args[2],
        d: args[3],
        e: args[4],
        f: args[5]
      })
    } else {
      return fail()
    }
    match = TRANSFORM_FUNCTION.exec(value)
  }
  if (!found) return fail()
  if (value.slice(consumed).trim().length > 0) return fail()
  return { ok: true, value: matrix }
}

function transformOf(el: XmlElement, matrix: Matrix): Parsed<Matrix> {
  const raw = el.attributes.get('transform')
  if (raw === undefined || raw.trim().length === 0) return { ok: true, value: matrix }
  const parsed = parseTransform(raw)
  if (!parsed.ok) return parsed
  return { ok: true, value: multiply(matrix, parsed.value) }
}

/** True when the matrix maps axis-aligned boxes to axis-aligned boxes (pure
 * translate/scale, possibly mirrored — no rotation, skew or shear). */
function isAxisAligned(m: Matrix): boolean {
  const scale = Math.max(Math.abs(m.a), Math.abs(m.d), 1)
  return Math.abs(m.b) <= 1e-9 * scale && Math.abs(m.c) <= 1e-9 * scale
}

/** Uniform scale factor of the matrix (geometric mean of the two axis
 * scales) — the factor folded into stroke widths. */
function matrixScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c))
}

// ---------------------------------------------------------------------------
// Attribute values: lengths, colors, paints, appearance, style
// ---------------------------------------------------------------------------

const LENGTH = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?(px)?$/

/** Numeric attribute value in user units; only unitless numbers and `px`
 * are supported. */
function parseLength(value: string, what: string): Parsed<number> {
  const trimmed = value.trim()
  if (!LENGTH.test(trimmed)) {
    return { ok: false, reason: `unsupported value "${value}" for ${what} (only unitless px lengths)` }
  }
  const number = Number(trimmed.replace(/px$/, ''))
  if (!Number.isFinite(number)) {
    return { ok: false, reason: `unsupported value "${value}" for ${what}` }
  }
  return { ok: true, value: number }
}

function lengthOf(el: XmlElement, name: string, fallback: number): Parsed<number> {
  const raw = el.attributes.get(name)
  if (raw === undefined) return { ok: true, value: fallback }
  return parseLength(raw, name)
}

/** Paint color: `none`, `#rgb` or `#rrggbb` (normalized to lowercase). */
function parseColorValue(value: string): Parsed<string> {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === 'none') return { ok: true, value: 'none' }
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(trimmed)
  if (!match) {
    return {
      ok: false,
      reason: `unsupported color "${value}" (supported: none, #rgb, #rrggbb)`
    }
  }
  const hex = match[1]
  const expanded = hex.length === 3 ? hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] : hex
  return { ok: true, value: `#${expanded}` }
}

/** Resolved paint state of one element (inherited from its ancestors). */
interface Appearance {
  fill: string
  stroke: string
  strokeWidth: number
  opacity: number
  strokeLinecap?: StrokeLinecap
  strokeLinejoin?: StrokeLinejoin
  /** Dash pattern in user units (scaled like `strokeWidth` at materialize). */
  strokeDasharray?: number[]
  /** Dash phase in user units (scaled like `strokeWidth` at materialize). */
  strokeDashoffset?: number
}

const DEFAULT_APPEARANCE: Appearance = { fill: '#000000', stroke: 'none', strokeWidth: 1, opacity: 1 }

const STYLE_PROPERTIES = new Set([
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity'
])

function parseStyleDeclarations(value: string): Parsed<Map<string, string>> {
  const declarations = new Map<string, string>()
  for (const part of value.split(';')) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0 || colon === trimmed.length - 1) {
      return { ok: false, reason: `malformed style declaration "${trimmed}"` }
    }
    const key = trimmed.slice(0, colon).trim().toLowerCase()
    const raw = trimmed.slice(colon + 1).trim()
    if (!STYLE_PROPERTIES.has(key)) {
      return { ok: false, reason: `unsupported style property "${key}"` }
    }
    declarations.set(key, raw)
  }
  return { ok: true, value: declarations }
}

/** Resolves the element's paint state over its inherited base. Presentation
 * attributes are applied first, then the `style` attribute (CSS wins).
 * `opacity` is folded multiplicatively into the inherited value; the
 * stroke-style fields inherit like the paints. */
function resolveAppearance(el: XmlElement, base: Appearance): Parsed<Appearance> {
  let fill = base.fill
  let stroke = base.stroke
  let strokeWidth = base.strokeWidth
  let opacity = 1
  let strokeLinecap = base.strokeLinecap
  let strokeLinejoin = base.strokeLinejoin
  let strokeDasharray = base.strokeDasharray
  let strokeDashoffset = base.strokeDashoffset

  const applyPaint = (key: 'fill' | 'stroke', raw: string): string | null => {
    const parsed = parseColorValue(raw)
    if (!parsed.ok) return parsed.reason
    if (key === 'fill') fill = parsed.value
    else stroke = parsed.value
    return null
  }
  const applyStrokeWidth = (raw: string): string | null => {
    const parsed = parseLength(raw, 'stroke-width')
    if (!parsed.ok) return parsed.reason
    if (parsed.value < 0) return `negative stroke-width "${raw}"`
    strokeWidth = parsed.value
    return null
  }
  const applyLinecap = (raw: string): string | null => {
    const value = raw.trim().toLowerCase()
    if (value !== 'butt' && value !== 'round' && value !== 'square') {
      return `unsupported value "${raw}" for stroke-linecap (supported: butt, round, square)`
    }
    strokeLinecap = value
    return null
  }
  const applyLinejoin = (raw: string): string | null => {
    const value = raw.trim().toLowerCase()
    if (value !== 'miter' && value !== 'round' && value !== 'bevel') {
      return `unsupported value "${raw}" for stroke-linejoin (supported: miter, round, bevel)`
    }
    strokeLinejoin = value
    return null
  }
  const applyDasharray = (raw: string): string | null => {
    const value = raw.trim().toLowerCase()
    if (value === 'none') {
      strokeDasharray = undefined
      return null
    }
    const parts = value.split(/[\s,]+/).filter((part) => part.length > 0)
    if (parts.length === 0) return `malformed stroke-dasharray "${raw}"`
    if (parts.length > MAX_STROKE_DASH_VALUES) {
      return `stroke-dasharray with more than ${MAX_STROKE_DASH_VALUES} values is not supported`
    }
    const values: number[] = []
    for (const part of parts) {
      const parsed = parseLength(part, 'stroke-dasharray')
      if (!parsed.ok) return parsed.reason
      if (parsed.value < 0) return `negative stroke-dasharray value "${raw}"`
      values.push(parsed.value)
    }
    // An all-zero pattern renders as a solid stroke (SVG spec), so it is
    // stored as no dash pattern at all.
    strokeDasharray = values.some((entry) => entry > 0) ? values : undefined
    return null
  }
  const applyDashoffset = (raw: string): string | null => {
    const parsed = parseLength(raw, 'stroke-dashoffset')
    if (!parsed.ok) return parsed.reason
    strokeDashoffset = parsed.value
    return null
  }
  const applyOpacity = (raw: string): string | null => {
    const value = Number(raw.trim())
    if (!Number.isFinite(value)) return `unsupported value "${raw}" for opacity`
    opacity = Math.min(1, Math.max(0, value))
    return null
  }
  const applyProperty = (key: string, raw: string): string | null => {
    if (key === 'fill' || key === 'stroke') return applyPaint(key, raw)
    if (key === 'stroke-width') return applyStrokeWidth(raw)
    if (key === 'stroke-linecap') return applyLinecap(raw)
    if (key === 'stroke-linejoin') return applyLinejoin(raw)
    if (key === 'stroke-dasharray') return applyDasharray(raw)
    if (key === 'stroke-dashoffset') return applyDashoffset(raw)
    return applyOpacity(raw)
  }

  const PRESENTATION_ATTRIBUTES = [
    'fill',
    'stroke',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-dasharray',
    'stroke-dashoffset',
    'opacity'
  ] as const
  for (const name of PRESENTATION_ATTRIBUTES) {
    const raw = el.attributes.get(name)
    if (raw === undefined) continue
    const error = applyProperty(name, raw)
    if (error) return { ok: false, reason: error }
  }
  const styleRaw = el.attributes.get('style')
  if (styleRaw !== undefined) {
    const declarations = parseStyleDeclarations(styleRaw)
    if (!declarations.ok) return declarations
    for (const [key, raw] of declarations.value) {
      const error = applyProperty(key, raw)
      if (error) return { ok: false, reason: error }
    }
  }
  return {
    ok: true,
    value: {
      fill,
      stroke,
      strokeWidth,
      opacity: base.opacity * opacity,
      strokeLinecap,
      strokeLinejoin,
      strokeDasharray,
      strokeDashoffset
    }
  }
}

const GLOBAL_ATTRIBUTES = new Set([
  'id',
  'transform',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'style',
  'version',
  'baseProfile',
  'overflow',
  'enable-background'
])

/** Rejects every attribute outside the element's documented subset.
 * Namespaced (`foo:bar`, incl. `xml:space`), `xmlns`/`xmlns:*` declarations
 * and `data-*` attributes are metadata and ignored. */
function checkAttributes(el: XmlElement, extra: readonly string[]): string | null {
  for (const name of el.attributes.keys()) {
    if (name === 'xmlns' || name.includes(':') || name.startsWith('data-')) continue
    if (GLOBAL_ATTRIBUTES.has(name) || extra.includes(name)) continue
    return `unsupported attribute "${name}" on <${el.name}>`
  }
  return null
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

type ShapeGeometry =
  | { kind: 'box'; primitive: 'rect' | 'ellipse'; x: number; y: number; width: number; height: number }
  | { kind: 'commands'; commands: PathCommand[] }

const KAPPA = 0.5522847498307936

/** Rounded-rectangle outline clockwise from the top edge (corner arcs as
 * standard cubic approximations). */
function roundedRectCommands(
  x: number,
  y: number,
  width: number,
  height: number,
  rx: number,
  ry: number
): PathCommand[] {
  const right = x + width
  const bottom = y + height
  return [
    { type: 'M', x: x + rx, y },
    { type: 'L', x: right - rx, y },
    { type: 'C', x1: right - rx + KAPPA * rx, y1: y, x2: right, y2: y + ry - KAPPA * ry, x: right, y: y + ry },
    { type: 'L', x: right, y: bottom - ry },
    { type: 'C', x1: right, y1: bottom - ry + KAPPA * ry, x2: right - rx + KAPPA * rx, y2: bottom, x: right - rx, y: bottom },
    { type: 'L', x: x + rx, y: bottom },
    { type: 'C', x1: x + rx - KAPPA * rx, y1: bottom, x2: x, y2: bottom - ry + KAPPA * ry, x, y: bottom - ry },
    { type: 'L', x, y: y + ry },
    { type: 'C', x1: x, y1: y + ry - KAPPA * ry, x2: x + rx - KAPPA * rx, y2: y, x: x + rx, y },
    { type: 'Z' }
  ]
}

/** Ellipse outline as four cubic segments (standard kappa approximation). */
function ellipseCommands(cx: number, cy: number, rx: number, ry: number): PathCommand[] {
  return [
    { type: 'M', x: cx + rx, y: cy },
    { type: 'C', x1: cx + rx, y1: cy + KAPPA * ry, x2: cx + KAPPA * rx, y2: cy + ry, x: cx, y: cy + ry },
    { type: 'C', x1: cx - KAPPA * rx, y1: cy + ry, x2: cx - rx, y2: cy + KAPPA * ry, x: cx - rx, y: cy },
    { type: 'C', x1: cx - rx, y1: cy - KAPPA * ry, x2: cx - KAPPA * rx, y2: cy - ry, x: cx, y: cy - ry },
    { type: 'C', x1: cx + KAPPA * rx, y1: cy - ry, x2: cx + rx, y2: cy - KAPPA * ry, x: cx + rx, y: cy },
    { type: 'Z' }
  ]
}

function sharpRectCommands(x: number, y: number, width: number, height: number): PathCommand[] {
  return [
    { type: 'M', x, y },
    { type: 'L', x: x + width, y },
    { type: 'L', x: x + width, y: y + height },
    { type: 'L', x, y: y + height },
    { type: 'Z' }
  ]
}

const POINT_NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g

function parsePointsList(value: string): Parsed<number[]> {
  const matches = value.match(POINT_NUMBER)
  if (!matches) return { ok: true, value: [] }
  const rest = value.replace(POINT_NUMBER, ' ').replace(/[\s,]+/g, '')
  if (rest.length > 0) return { ok: false, reason: `malformed points list "${value}"` }
  const numbers = matches.map(Number)
  if (numbers.some((number) => !Number.isFinite(number))) {
    return { ok: false, reason: `malformed points list "${value}"` }
  }
  return { ok: true, value: numbers }
}

const SHAPE_ATTRIBUTES: Record<string, readonly string[]> = {
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
  path: ['d']
}

/** Raw geometry of one shape element in user units, before transforms. */
function buildShapeGeometry(el: XmlElement): Parsed<ShapeGeometry> | null {
  const fail = (reason: string): Parsed<ShapeGeometry> => ({ ok: false, reason })
  const ok = (value: ShapeGeometry): Parsed<ShapeGeometry> => ({ ok: true, value })
  switch (el.name) {
    case 'rect': {
      const x = lengthOf(el, 'x', 0)
      if (!x.ok) return x
      const y = lengthOf(el, 'y', 0)
      if (!y.ok) return y
      const width = lengthOf(el, 'width', 0)
      if (!width.ok) return width
      const height = lengthOf(el, 'height', 0)
      if (!height.ok) return height
      if (width.value < 0 || height.value < 0) return fail('negative rect size')
      if (width.value === 0 || height.value === 0) return null
      const rxRaw = el.attributes.get('rx')
      const ryRaw = el.attributes.get('ry')
      const rx = rxRaw !== undefined ? parseLength(rxRaw, 'rx') : undefined
      if (rx && !rx.ok) return rx
      const ry = ryRaw !== undefined ? parseLength(ryRaw, 'ry') : undefined
      if (ry && !ry.ok) return ry
      let cornerX = rx?.value ?? ry?.value ?? 0
      let cornerY = ry?.value ?? rx?.value ?? 0
      if (cornerX < 0 || cornerY < 0) return fail('negative corner radius')
      cornerX = Math.min(cornerX, width.value / 2)
      cornerY = Math.min(cornerY, height.value / 2)
      if (cornerX === 0 || cornerY === 0) {
        return ok({ kind: 'box', primitive: 'rect', x: x.value, y: y.value, width: width.value, height: height.value })
      }
      return ok({ kind: 'commands', commands: roundedRectCommands(x.value, y.value, width.value, height.value, cornerX, cornerY) })
    }
    case 'circle': {
      const cx = lengthOf(el, 'cx', 0)
      if (!cx.ok) return cx
      const cy = lengthOf(el, 'cy', 0)
      if (!cy.ok) return cy
      const r = lengthOf(el, 'r', 0)
      if (!r.ok) return r
      if (r.value < 0) return fail('negative circle radius')
      if (r.value === 0) return null
      return ok({ kind: 'box', primitive: 'ellipse', x: cx.value - r.value, y: cy.value - r.value, width: 2 * r.value, height: 2 * r.value })
    }
    case 'ellipse': {
      const cx = lengthOf(el, 'cx', 0)
      if (!cx.ok) return cx
      const cy = lengthOf(el, 'cy', 0)
      if (!cy.ok) return cy
      const rx = lengthOf(el, 'rx', 0)
      if (!rx.ok) return rx
      const ry = lengthOf(el, 'ry', 0)
      if (!ry.ok) return ry
      if (rx.value < 0 || ry.value < 0) return fail('negative ellipse radius')
      if (rx.value === 0 || ry.value === 0) return null
      return ok({ kind: 'box', primitive: 'ellipse', x: cx.value - rx.value, y: cy.value - ry.value, width: 2 * rx.value, height: 2 * ry.value })
    }
    case 'line': {
      const x1 = lengthOf(el, 'x1', 0)
      if (!x1.ok) return x1
      const y1 = lengthOf(el, 'y1', 0)
      if (!y1.ok) return y1
      const x2 = lengthOf(el, 'x2', 0)
      if (!x2.ok) return x2
      const y2 = lengthOf(el, 'y2', 0)
      if (!y2.ok) return y2
      if (x1.value === x2.value && y1.value === y2.value) return null
      return ok({
        kind: 'commands',
        commands: [
          { type: 'M', x: x1.value, y: y1.value },
          { type: 'L', x: x2.value, y: y2.value }
        ]
      })
    }
    case 'polyline':
    case 'polygon': {
      const pointsRaw = el.attributes.get('points')
      if (pointsRaw === undefined) return null
      const points = parsePointsList(pointsRaw)
      if (!points.ok) return points
      if (points.value.length % 2 !== 0) {
        return fail(`malformed points list "${pointsRaw}" (odd number of coordinates)`)
      }
      const count = points.value.length / 2
      if (count < 2) return null
      const commands: PathCommand[] = [{ type: 'M', x: points.value[0], y: points.value[1] }]
      for (let i = 1; i < count; i++) {
        commands.push({ type: 'L', x: points.value[i * 2], y: points.value[i * 2 + 1] })
      }
      if (el.name === 'polygon') commands.push({ type: 'Z' })
      return ok({ kind: 'commands', commands })
    }
    case 'path': {
      const d = el.attributes.get('d')
      if (d === undefined || d.trim().length === 0) return null
      const commands = parsePathCommands(d)
      if (!commands) {
        return fail('path data uses unsupported or malformed commands (arcs cannot be converted)')
      }
      if (commands.length === 0) return null
      return ok({ kind: 'commands', commands })
    }
    default:
      return null
  }
}

function transformCommand(command: PathCommand, m: Matrix): PathCommand {
  switch (command.type) {
    case 'M': {
      const p = applyMatrix(m, command.x, command.y)
      return { type: 'M', x: p.x, y: p.y }
    }
    case 'L': {
      const p = applyMatrix(m, command.x, command.y)
      return { type: 'L', x: p.x, y: p.y }
    }
    case 'C': {
      const c1 = applyMatrix(m, command.x1, command.y1)
      const c2 = applyMatrix(m, command.x2, command.y2)
      const p = applyMatrix(m, command.x, command.y)
      return { type: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: p.x, y: p.y }
    }
    case 'Q': {
      const c1 = applyMatrix(m, command.x1, command.y1)
      const p = applyMatrix(m, command.x, command.y)
      return { type: 'Q', x1: c1.x, y1: c1.y, x: p.x, y: p.y }
    }
    case 'Z':
      return command
  }
}

type StrokeFields = Partial<
  Pick<
    PrimitiveNode,
    'stroke' | 'strokeWidth' | 'strokeLinecap' | 'strokeLinejoin' | 'strokeDasharray' | 'strokeDashoffset'
  >
>

/** Appearance → node stroke fields: nothing when the stroke never paints;
 * otherwise the paint, its width and the authored stroke-style fields, with
 * lengths and the dash pattern scaled by the accumulated transform (the same
 * factor as `stroke-width`). */
function strokeFields(appearance: Appearance, scale: number): StrokeFields {
  if (appearance.stroke === 'none' || appearance.strokeWidth === 0) return {}
  const fields: StrokeFields = {
    stroke: appearance.stroke,
    strokeWidth: appearance.strokeWidth * scale
  }
  if (appearance.strokeLinecap !== undefined) fields.strokeLinecap = appearance.strokeLinecap
  if (appearance.strokeLinejoin !== undefined) fields.strokeLinejoin = appearance.strokeLinejoin
  if (appearance.strokeDasharray !== undefined) {
    fields.strokeDasharray = appearance.strokeDasharray.map((value) => value * scale)
  }
  if (appearance.strokeDashoffset !== undefined) {
    fields.strokeDashoffset = appearance.strokeDashoffset * scale
  }
  return fields
}

/** Converts raw geometry plus accumulated transform and paint into a node:
 * axis-aligned rect/ellipse boxes become primitives, everything else a
 * `PathNode` (vector import never rasterizes). Null when nothing is drawn. */
function materializeShape(
  geometry: ShapeGeometry,
  matrix: Matrix,
  appearance: Appearance
): PrimitiveNode | PathNode | null {
  const scale = matrixScale(matrix)
  if (geometry.kind === 'box' && isAxisAligned(matrix)) {
    const width = geometry.width * Math.abs(matrix.a)
    const height = geometry.height * Math.abs(matrix.d)
    if (width === 0 || height === 0) return null
    return {
      id: createId('node'),
      type: 'primitive',
      primitive: geometry.primitive,
      center: applyMatrix(matrix, geometry.x + geometry.width / 2, geometry.y + geometry.height / 2),
      width,
      height,
      rotation: 0,
      opacity: appearance.opacity,
      fill: appearance.fill,
      ...strokeFields(appearance, scale)
    }
  }
  const commands = geometry.kind === 'box'
    ? geometry.primitive === 'rect'
      ? sharpRectCommands(geometry.x, geometry.y, geometry.width, geometry.height)
      : ellipseCommands(
          geometry.x + geometry.width / 2,
          geometry.y + geometry.height / 2,
          geometry.width / 2,
          geometry.height / 2
        )
    : geometry.commands
  const raw = serializeCommands(commands.map((command) => transformCommand(command, matrix)))
  const bounds = pathDataBounds(raw)
  if (!bounds) return null
  if (bounds.width === 0 && bounds.height === 0) return null
  return {
    id: createId('node'),
    type: 'path',
    center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
    width: bounds.width > 0 ? bounds.width : 2,
    height: bounds.height > 0 ? bounds.height : 2,
    rotation: 0,
    opacity: appearance.opacity,
    d: normalizePathData(raw),
    ...(appearance.fill !== 'none' ? { fill: appearance.fill } : {}),
    ...strokeFields(appearance, scale)
  }
}

// ---------------------------------------------------------------------------
// Document walk
// ---------------------------------------------------------------------------

const IGNORED_ELEMENTS = new Set(['title', 'desc', 'metadata'])
const ROOT_ATTRIBUTES = ['width', 'height', 'viewBox', 'preserveAspectRatio']

/** Viewport matrix of the root `<svg>`: viewBox mapping (xMidYMid meet by
 * default, `none` for non-uniform), width/height defaulting to the viewBox
 * size (or 300×150 without a viewBox). */
function rootViewportMatrix(root: XmlElement): Parsed<Matrix> {
  const widthRaw = root.attributes.get('width')
  const heightRaw = root.attributes.get('height')
  const viewBoxRaw = root.attributes.get('viewBox')
  const width = widthRaw !== undefined ? parseLength(widthRaw, 'width') : undefined
  if (width && !width.ok) return width
  const height = heightRaw !== undefined ? parseLength(heightRaw, 'height') : undefined
  if (height && !height.ok) return height
  if (viewBoxRaw === undefined) return { ok: true, value: IDENTITY }
  const parts = viewBoxRaw
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return { ok: false, reason: `malformed viewBox "${viewBoxRaw}"` }
  }
  const [vx, vy, vw, vh] = parts
  if (vw <= 0 || vh <= 0) return { ok: false, reason: `malformed viewBox "${viewBoxRaw}"` }
  const boxWidth = width?.value ?? vw
  const boxHeight = height?.value ?? vh
  const preserveRaw = root.attributes.get('preserveAspectRatio')
  if (preserveRaw !== undefined) {
    const normalized = preserveRaw.trim().toLowerCase().replace(/\s+/g, ' ')
    if (normalized !== 'xmidymid' && normalized !== 'xmidymid meet' && normalized !== 'none') {
      return { ok: false, reason: `unsupported preserveAspectRatio "${preserveRaw}"` }
    }
    if (normalized === 'none') {
      const sx = boxWidth / vw
      const sy = boxHeight / vh
      return { ok: true, value: { a: sx, b: 0, c: 0, d: sy, e: -vx * sx, f: -vy * sy } }
    }
  }
  const scale = Math.min(boxWidth / vw, boxHeight / vh)
  return {
    ok: true,
    value: {
      a: scale,
      b: 0,
      c: 0,
      d: scale,
      e: (boxWidth - vw * scale) / 2 - vx * scale,
      f: (boxHeight - vh * scale) / 2 - vy * scale
    }
  }
}

function visitShape(
  el: XmlElement,
  attributes: readonly string[],
  matrix: Matrix,
  appearance: Appearance,
  out: SceneNode[]
): string | null {
  const attributeError = checkAttributes(el, attributes)
  if (attributeError) return attributeError
  for (const child of el.children) {
    if (!IGNORED_ELEMENTS.has(child.name)) {
      return `unexpected content inside <${el.name}>`
    }
  }
  const resolved = resolveAppearance(el, appearance)
  if (!resolved.ok) return resolved.reason
  const next = transformOf(el, matrix)
  if (!next.ok) return next.reason
  const geometry = buildShapeGeometry(el)
  if (geometry === null) return null
  if (!geometry.ok) return geometry.reason
  // A <line> has no interior: its fill never paints (SVG never applies it).
  const paint = el.name === 'line' ? { ...resolved.value, fill: 'none' } : resolved.value
  const node = materializeShape(geometry.value, next.value, paint)
  if (node) out.push(node)
  return null
}

function visitElement(
  el: XmlElement,
  matrix: Matrix,
  appearance: Appearance,
  out: SceneNode[],
  depth: number
): string | null {
  if (depth > MAX_DEPTH) return 'the SVG is nested too deeply'
  if (IGNORED_ELEMENTS.has(el.name)) return null
  if (el.name === 'svg') return 'nested <svg> elements are not supported'
  if (el.name === 'g') {
    const attributeError = checkAttributes(el, [])
    if (attributeError) return attributeError
    const resolved = resolveAppearance(el, appearance)
    if (!resolved.ok) return resolved.reason
    const next = transformOf(el, matrix)
    if (!next.ok) return next.reason
    for (const child of el.children) {
      const error = visitElement(child, next.value, resolved.value, out, depth + 1)
      if (error) return error
    }
    return null
  }
  const attributes = SHAPE_ATTRIBUTES[el.name]
  if (!attributes) return `unsupported element <${el.name}>`
  return visitShape(el, attributes, matrix, appearance, out)
}

function importRoot(root: XmlElement, out: SceneNode[]): string | null {
  const attributeError = checkAttributes(root, ROOT_ATTRIBUTES)
  if (attributeError) return attributeError
  const resolved = resolveAppearance(root, DEFAULT_APPEARANCE)
  if (!resolved.ok) return resolved.reason
  const viewport = rootViewportMatrix(root)
  if (!viewport.ok) return viewport.reason
  let matrix = viewport.value
  const transform = transformOf(root, IDENTITY)
  if (!transform.ok) return transform.reason
  matrix = multiply(transform.value, matrix)
  for (const child of root.children) {
    const error = visitElement(child, matrix, resolved.value, out, 1)
    if (error) return error
  }
  return null
}

// ---------------------------------------------------------------------------
// Duplicate collapse + entry point
// ---------------------------------------------------------------------------

/** Canonical geometry+appearance key of a leaf shape; null for kinds that are
 * never collapsed (position, rotation, opacity and name are carried by the
 * symbol instance instead). Includes the stroke-style fields so shapes that
 * differ only in linecap/linejoin/dash never collapse into one symbol. */
function shapeKey(node: SceneNode): string | null {
  if (node.type !== 'primitive' && node.type !== 'path') return null
  const style = `${node.strokeLinecap ?? null}|${node.strokeLinejoin ?? null}|${JSON.stringify(node.strokeDasharray ?? null)}|${node.strokeDashoffset ?? null}`
  if (node.type === 'primitive') {
    return `primitive|${node.primitive}|${node.width}|${node.height}|${JSON.stringify(node.fill)}|${JSON.stringify(node.stroke ?? null)}|${node.strokeWidth ?? null}|${style}`
  }
  return `path|${node.width}|${node.height}|${node.d}|${JSON.stringify(node.fill ?? null)}|${JSON.stringify(node.stroke ?? null)}|${node.strokeWidth ?? null}|${style}`
}

export interface SvgCollapseResult {
  nodes: SceneNode[]
  assets: Asset[]
}

/**
 * Collapses every group of ≥ 2 identical leaf shapes (same geometry and
 * appearance, ignoring position/rotation/opacity/name) into one document
 * symbol asset: each occurrence becomes a symbol instance carrying its own
 * transform. Groups are traversed; non-duplicates stay as-is.
 */
export function collapseDuplicateShapes(nodes: SceneNode[]): SvgCollapseResult {
  const counts = new Map<string, number>()
  const countShapes = (list: SceneNode[]): void => {
    for (const node of list) {
      const key = shapeKey(node)
      if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1)
      if (node.type === 'group') countShapes(node.children)
    }
  }
  countShapes(nodes)

  const assetByKey = new Map<string, Asset>()
  const assets: Asset[] = []
  const collapse = (list: SceneNode[]): SceneNode[] =>
    list.map((node) => {
      const key = shapeKey(node)
      if (key !== null && (counts.get(key) ?? 0) >= 2) {
        let asset = assetByKey.get(key)
        if (!asset) {
          const member = cloneNode(node)
          member.center = { x: 0, y: 0 }
          member.rotation = 0
          member.opacity = 1
          asset = createDocumentAsset({
            name: `Imported symbol ${assets.length + 1}`,
            kind: 'symbol',
            content: symbolContentFromGroup(groupNodes([member], createId('node')))
          })
          assetByKey.set(key, asset)
          assets.push(asset)
        }
        const instance: SymbolNode = {
          id: createId('node'),
          ...(node.name !== undefined ? { name: node.name } : {}),
          type: 'symbol',
          assetId: asset.id,
          center: { ...node.center },
          width: node.width,
          height: node.height,
          rotation: node.rotation,
          opacity: node.opacity
        }
        return instance
      }
      if (node.type === 'group') return { ...node, children: collapse(node.children) }
      return node
    })

  return { nodes: collapse(nodes), assets }
}

export type SvgImportOutcome =
  | { ok: true; group: GroupNode; assets: Asset[] }
  | { ok: false; reason: string }

/**
 * Imports SVG bytes as editable vector content: parses, converts the
 * supported subset into primitive/path nodes, collapses exact duplicates
 * into symbol assets and wraps everything in one group whose center and
 * natural size come from the imported content bounds. Any unsupported or
 * malformed construct fails with a human-readable reason instead of
 * importing partial artwork.
 */
export function importSvgAsVectors(bytes: Uint8Array): SvgImportOutcome {
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, reason: 'the file is not valid UTF-8 text' }
  }
  const parsed = parseSvgXml(source)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  if (parsed.value.name !== 'svg') return { ok: false, reason: 'the root element is not <svg>' }
  const nodes: SceneNode[] = []
  const error = importRoot(parsed.value, nodes)
  if (error) return { ok: false, reason: error }
  if (nodes.length === 0) return { ok: false, reason: 'no supported drawable shapes were found' }
  const collapsed = collapseDuplicateShapes(nodes)
  return { ok: true, group: groupNodes(collapsed.nodes, createId('node')), assets: collapsed.assets }
}
