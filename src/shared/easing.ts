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
