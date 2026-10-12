import { easeInOutCubic } from './geometry'

/** Named easing curves available on tweened keyframes. */
export type EasingName = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

/** Normalized cubic bezier control points (x values must stay within [0, 1]). */
export interface CubicBezierEasing {
  x1: number
  y1: number
  x2: number
  y2: number
}

export type Easing = EasingName | CubicBezierEasing

function bezierComponent(p1: number, p2: number, t: number): number {
  const u = 1 - t
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t
}

function bezierDerivative(p1: number, p2: number, t: number): number {
  const u = 1 - t
  return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2)
}

/** Builds a cubic-bezier easing solver (Newton-Raphson with bisection fallback). */
export function createCubicBezierEasing(easing: CubicBezierEasing): (t: number) => number {
  const { x1, y1, x2, y2 } = easing
  return (t: number): number => {
    if (t <= 0) return 0
    if (t >= 1) return 1

    let guess = t
    for (let i = 0; i < 8; i++) {
      const error = bezierComponent(x1, x2, guess) - t
      if (Math.abs(error) < 1e-6) break
      const derivative = bezierDerivative(x1, x2, guess)
      if (Math.abs(derivative) < 1e-6) break
      guess -= error / derivative
    }

    if (guess < 0 || guess > 1) {
      let low = 0
      let high = 1
      guess = t
      for (let i = 0; i < 48; i++) {
        const x = bezierComponent(x1, x2, guess)
        if (Math.abs(x - t) < 1e-6) break
        if (x < t) low = guess
        else high = guess
        guess = (low + high) / 2
      }
    }

    return bezierComponent(y1, y2, guess)
  }
}

const NAMED_EASINGS: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  'ease-in': (t) => t * t * t,
  'ease-out': (t) => 1 - Math.pow(1 - t, 3),
  'ease-in-out': easeInOutCubic
}

/** Evaluates an easing definition at progress `t` in [0, 1]. */
export function evaluateEasing(easing: Easing, t: number): number {
  const clamped = Math.min(1, Math.max(0, t))
  if (typeof easing === 'string') {
    return NAMED_EASINGS[easing](clamped)
  }
  return createCubicBezierEasing(easing)(clamped)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Structural validation of an easing definition: a named easing or a closed
 * `{x1, y1, x2, y2}` cubic bezier with finite numbers. `x1`/`x2` must stay in
 * [0, 1] for the solver's monotonicity; `y` values are free (overshoot is
 * allowed, e.g. ease-out-back).
 */
export function isEasing(value: unknown): value is Easing {
  if (typeof value === 'string') {
    return value in NAMED_EASINGS
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const bezier = value as Record<string, unknown>
  for (const key of Object.keys(bezier)) {
    if (key !== 'x1' && key !== 'y1' && key !== 'x2' && key !== 'y2') return false
  }
  if (!isFiniteNumber(bezier.x1) || !isFiniteNumber(bezier.y1)) return false
  if (!isFiniteNumber(bezier.x2) || !isFiniteNumber(bezier.y2)) return false
  return bezier.x1 >= 0 && bezier.x1 <= 1 && bezier.x2 >= 0 && bezier.x2 <= 1
}

function freezeBezier(x1: number, y1: number, x2: number, y2: number): CubicBezierEasing {
  return Object.freeze({ x1, y1, x2, y2 })
}

const NAMED_BEZIERS: Record<EasingName, CubicBezierEasing> = {
  // Canonical CSS `easing-function` beziers for the named curves.
  linear: freezeBezier(0, 0, 1, 1),
  'ease-in': freezeBezier(0.42, 0, 1, 1),
  'ease-out': freezeBezier(0, 0, 0.58, 1),
  'ease-in-out': freezeBezier(0.42, 0, 0.58, 1)
}

/** One entry of the built-in curve preset library shown in the easing editor. */
export interface EasingPreset {
  id: string
  label: string
  /** Set when the preset IS the named easing, so picking it stores the name. */
  named?: EasingName
  bezier: CubicBezierEasing
}

/** Built-in easing preset library (~10 cubic-bezier curves + the named ones). */
export const EASING_PRESETS: readonly EasingPreset[] = Object.freeze([
  { id: 'linear', label: 'Linear', named: 'linear', bezier: NAMED_BEZIERS.linear },
  { id: 'ease-in', label: 'Ease In', named: 'ease-in', bezier: NAMED_BEZIERS['ease-in'] },
  { id: 'ease-out', label: 'Ease Out', named: 'ease-out', bezier: NAMED_BEZIERS['ease-out'] },
  { id: 'ease-in-out', label: 'Ease In Out', named: 'ease-in-out', bezier: NAMED_BEZIERS['ease-in-out'] },
  { id: 'ease-in-quad', label: 'Ease In Quad', bezier: freezeBezier(0.11, 0, 0.5, 0) },
  { id: 'ease-out-quad', label: 'Ease Out Quad', bezier: freezeBezier(0.5, 1, 0.89, 1) },
  { id: 'ease-in-expo', label: 'Ease In Expo', bezier: freezeBezier(0.7, 0, 0.84, 0) },
  { id: 'ease-out-expo', label: 'Ease Out Expo', bezier: freezeBezier(0.16, 1, 0.3, 1) },
  { id: 'ease-in-back', label: 'Ease In Back', bezier: freezeBezier(0.36, 0, 0.66, -0.56) },
  { id: 'ease-out-back', label: 'Ease Out Back', bezier: freezeBezier(0.34, 1.56, 0.64, 1) },
  { id: 'ease-in-out-quart', label: 'Ease In Out Quart', bezier: freezeBezier(0.76, 0, 0.24, 1) }
])

/** Canonical bezier of a named easing — seeds the curve editor for names. */
export function canonicalBezierFor(name: EasingName): CubicBezierEasing {
  return { ...NAMED_BEZIERS[name] }
}
