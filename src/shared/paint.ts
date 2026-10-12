import { formatHexColor, lerpHexColor, parseHexColor } from './color'

/**
 * Paint model for fills and strokes: a flat hex color (or `none`) or a
 * linear/radial gradient with 2–8 stops. The type is a pure union of plain
 * data so documents stay JSON-serializable and the renderer emits gradients
 * through the existing single SVG pipeline.
 */

/** One gradient stop: position in the paint's 0..1 range and a hex color. */
export interface GradientStop {
  /** 0..1 along the gradient axis (linear) or radius (radial). */
  offset: number
  /** `#rrggbb` (or `#rgb`) color. */
  color: string
}

/** Linear gradient: `angle` in degrees, 0 = left→right, positive clockwise
 * in the y-down stage space. */
export interface LinearGradientPaint {
  type: 'linear'
  angle: number
  stops: GradientStop[]
}

/** Radial gradient: center and radius as fractions of the node's bounding
 * box, so the paint survives resize without re-authoring. */
export interface RadialGradientPaint {
  type: 'radial'
  cx: number
  cy: number
  r: number
  stops: GradientStop[]
}

export type GradientPaint = LinearGradientPaint | RadialGradientPaint

/** A fill or stroke value: a flat color string (`#rrggbb`, `none`) or a
 * gradient. */
export type Paint = string | GradientPaint

/** Minimum and maximum number of gradient stops. */
export const MIN_GRADIENT_STOPS = 2
export const MAX_GRADIENT_STOPS = 8

export function isGradientPaint(value: unknown): value is GradientPaint {
  return isPaintValue(value) && typeof value === 'object'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isGradientStop(value: unknown): value is GradientStop {
  if (typeof value !== 'object' || value === null) return false
  const stop = value as Record<string, unknown>
  for (const key of Object.keys(stop)) {
    if (key !== 'offset' && key !== 'color') return false
  }
  if (!isFiniteNumber(stop.offset) || stop.offset < 0 || stop.offset > 1) return false
  return typeof stop.color === 'string' && parseHexColor(stop.color) !== null
}

function isGradientStops(value: unknown): value is GradientStop[] {
  return (
    Array.isArray(value) &&
    value.length >= MIN_GRADIENT_STOPS &&
    value.length <= MAX_GRADIENT_STOPS &&
    value.every(isGradientStop)
  )
}

/**
 * Strict paint validation: strings must be non-empty color strings, gradient
 * objects must be exactly one of the two known shapes with numeric geometry
 * and 2–8 valid stops — unknown fields are rejected, never ignored.
 */
export function isPaintValue(value: unknown): value is Paint {
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const paint = value as Record<string, unknown>
  const allowed = paint.type === 'linear' ? ['type', 'angle', 'stops'] : ['type', 'cx', 'cy', 'r', 'stops']
  for (const key of Object.keys(paint)) {
    if (!allowed.includes(key)) return false
  }
  if (paint.type === 'linear') {
    return (
      isFiniteNumber(paint.angle) &&
      paint.stops !== undefined &&
      isGradientStops(paint.stops)
    )
  }
  if (paint.type === 'radial') {
    return (
      isFiniteNumber(paint.cx) &&
      isFiniteNumber(paint.cy) &&
      isFiniteNumber(paint.r) &&
      paint.stops !== undefined &&
      isGradientStops(paint.stops)
    )
  }
  return false
}

/** Representative solid color of a paint: the paint itself when solid, the
 * first stop's color for gradients (timeline badges, input fallbacks). */
export function paintPrimaryColor(paint: Paint): string {
  return typeof paint === 'string' ? paint : paint.stops[0].color
}

/**
 * Interpolates two paints for tweening. Solid↔solid lerps the colors.
 * Gradient↔gradient of the same type and stop count interpolates the geometry
 * and then every stop pairwise. Any mismatch (type, stop count or an
 * unparseable color) snaps: `from` until the last frame, `to` at `t = 1` —
 * the same fallback the solid color lerp uses for invalid input.
 */
export function lerpPaint(from: Paint, to: Paint, t: number): Paint {
  if (typeof from === 'string' || typeof to === 'string') {
    if (typeof from === 'string' && typeof to === 'string') {
      return lerpHexColor(from, to, t) ?? (t < 1 ? from : to)
    }
    return t < 1 ? from : to
  }
  if (from.type !== to.type || from.stops.length !== to.stops.length) {
    return t < 1 ? from : to
  }
  const stops: GradientStop[] = []
  for (let i = 0; i < from.stops.length; i++) {
    const color = lerpHexColor(from.stops[i].color, to.stops[i].color, t)
    if (!color) return t < 1 ? from : to
    stops.push({ offset: lerpNumber(from.stops[i].offset, to.stops[i].offset, t), color })
  }
  if (from.type === 'linear' && to.type === 'linear') {
    return { type: 'linear', angle: lerpNumber(from.angle, to.angle, t), stops }
  }
  if (from.type === 'radial' && to.type === 'radial') {
    return {
      type: 'radial',
      cx: lerpNumber(from.cx, to.cx, t),
      cy: lerpNumber(from.cy, to.cy, t),
      r: lerpNumber(from.r, to.r, t),
      stops
    }
  }
  return t < 1 ? from : to
}

function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Deterministic content key of a gradient paint (FNV-1a, non-cryptographic):
 * identical paints always produce the same key, so the renderer can emit one
 * `<defs>` per unique paint and reference it from every occurrence.
 */
export function paintKey(paint: GradientPaint): string {
  const stops = paint.stops.map((stop) => `${stop.offset}:${stop.color.toLowerCase()}`).join(';')
  const canonical =
    paint.type === 'linear'
      ? `linear|${paint.angle}|${stops}`
      : `radial|${paint.cx}|${paint.cy}|${paint.r}|${stops}`
  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** The `url(#…)` reference and defs id for a gradient paint. */
export function paintGradientId(paint: GradientPaint): string {
  return `oa-grad-${paintKey(paint)}`
}

/** Promotes a solid color to a two-stop gradient of the same family: the
 * color at the start, a darkened version at the end — the editor's default
 * when switching a paint from solid to gradient. */
export function createDefaultGradientPaint(
  kind: GradientPaint['type'],
  baseColor: string
): GradientPaint {
  const base = parseHexColor(baseColor)
  const start = base ? formatHexColor(base) : '#38bdf8'
  const end = lerpHexColor(start, '#000000', 0.45) ?? start
  const stops: GradientStop[] = [
    { offset: 0, color: start },
    { offset: 1, color: end }
  ]
  if (kind === 'radial') return { type: 'radial', cx: 0.5, cy: 0.5, r: 0.5, stops }
  return { type: 'linear', angle: 90, stops }
}
