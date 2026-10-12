import { describe, expect, it } from 'vitest'

import {
  MAX_GRADIENT_STOPS,
  createDefaultGradientPaint,
  isGradientPaint,
  isPaintValue,
  lerpPaint,
  paintGradientId,
  paintKey,
  paintPrimaryColor
} from './paint'
import type { GradientPaint, LinearGradientPaint, RadialGradientPaint } from './paint'

const linear: LinearGradientPaint = {
  type: 'linear',
  angle: 90,
  stops: [
    { offset: 0, color: '#ff0000' },
    { offset: 1, color: '#0000ff' }
  ]
}

const radial: RadialGradientPaint = {
  type: 'radial',
  cx: 0.5,
  cy: 0.5,
  r: 0.5,
  stops: [
    { offset: 0, color: '#ffffff' },
    { offset: 1, color: '#000000' }
  ]
}

describe('isPaintValue', () => {
  it('accepts non-empty strings and the two gradient shapes', () => {
    expect(isPaintValue('#ff0000')).toBe(true)
    expect(isPaintValue('none')).toBe(true)
    expect(isPaintValue(linear)).toBe(true)
    expect(isPaintValue(radial)).toBe(true)
  })

  it('rejects empty strings, junk and arrays', () => {
    expect(isPaintValue('')).toBe(false)
    expect(isPaintValue('   ')).toBe(false)
    expect(isPaintValue(null)).toBe(false)
    expect(isPaintValue(42)).toBe(false)
    expect(isPaintValue([linear])).toBe(false)
  })

  it('rejects unknown gradient fields instead of ignoring them', () => {
    expect(isPaintValue({ ...linear, extra: true })).toBe(false)
    expect(isPaintValue({ ...radial, angle: 10 })).toBe(false)
    expect(isPaintValue({ ...linear, type: 'conic' })).toBe(false)
    expect(isPaintValue({ type: 'linear', stops: linear.stops })).toBe(false)
    expect(isPaintValue({ type: 'radial', cx: 0.5, cy: 0.5, stops: radial.stops })).toBe(false)
  })

  it('requires finite geometry numbers', () => {
    expect(isPaintValue({ ...linear, angle: Number.NaN })).toBe(false)
    expect(isPaintValue({ ...linear, angle: '90' })).toBe(false)
    expect(isPaintValue({ ...radial, r: Infinity })).toBe(false)
  })

  it('requires 2–8 valid stops', () => {
    const stops = linear.stops
    expect(isPaintValue({ ...linear, stops: [stops[0]] })).toBe(false)
    expect(
      isPaintValue({
        ...linear,
        stops: Array.from({ length: MAX_GRADIENT_STOPS + 1 }, (_, index) => ({
          offset: 0,
          color: `#00000${index}`
        }))
      })
    ).toBe(false)
    expect(isPaintValue({ ...linear, stops: [{ offset: -0.1, color: '#ff0000' }, stops[1]] })).toBe(false)
    expect(isPaintValue({ ...linear, stops: [{ offset: 1.1, color: '#ff0000' }, stops[1]] })).toBe(false)
    expect(isPaintValue({ ...linear, stops: [{ offset: 0.5, color: 'red' }, stops[1]] })).toBe(false)
    expect(
      isPaintValue({ ...linear, stops: [{ offset: 0.5, color: '#ff0000', id: 'x' }, stops[1]] })
    ).toBe(false)
    expect(
      isPaintValue({ ...linear, stops: [{ offset: 0.5 }, stops[1]] })
    ).toBe(false)
  })

  it('isGradientPaint narrows to the object branch only', () => {
    expect(isGradientPaint(linear)).toBe(true)
    expect(isGradientPaint(radial)).toBe(true)
    expect(isGradientPaint('#ff0000')).toBe(false)
    expect(isGradientPaint('none')).toBe(false)
  })

  it('accepts an optional 0..1 stop alpha and rejects bad values', () => {
    const stop = (alpha: unknown): object => ({ offset: 0, color: '#ff0000', alpha })
    expect(isPaintValue({ ...linear, stops: [stop(0), linear.stops[1]] })).toBe(true)
    expect(isPaintValue({ ...linear, stops: [stop(1), linear.stops[1]] })).toBe(true)
    expect(isPaintValue({ ...linear, stops: [stop(0.25), linear.stops[1]] })).toBe(true)
    expect(isPaintValue({ ...linear, stops: [stop(-0.1), linear.stops[1]] })).toBe(false)
    expect(isPaintValue({ ...linear, stops: [stop(1.1), linear.stops[1]] })).toBe(false)
    expect(isPaintValue({ ...linear, stops: [stop('0.5'), linear.stops[1]] })).toBe(false)
    expect(isPaintValue({ ...linear, stops: [stop(Number.NaN), linear.stops[1]] })).toBe(false)
  })
})

describe('paintPrimaryColor', () => {
  it('returns solids unchanged and the first stop color for gradients', () => {
    expect(paintPrimaryColor('#123456')).toBe('#123456')
    expect(paintPrimaryColor(linear)).toBe('#ff0000')
    expect(paintPrimaryColor(radial)).toBe('#ffffff')
  })
})

describe('lerpPaint', () => {
  it('lerps solid colors', () => {
    expect(lerpPaint('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(lerpPaint('#ff0000', '#00ff00', 0)).toBe('#ff0000')
    expect(lerpPaint('#ff0000', '#00ff00', 1)).toBe('#00ff00')
  })

  it('snaps invalid solid pairs: from until the end, to at t = 1', () => {
    expect(lerpPaint('none', '#ffffff', 0.5)).toBe('none')
    expect(lerpPaint('none', '#ffffff', 1)).toBe('#ffffff')
    expect(lerpPaint('#ff0000', 'none', 0.5)).toBe('#ff0000')
    expect(lerpPaint('#ff0000', 'none', 1)).toBe('none')
  })

  it('snaps solid↔gradient mismatches', () => {
    expect(lerpPaint('#ff0000', linear, 0.5)).toBe('#ff0000')
    expect(lerpPaint('#ff0000', linear, 1)).toBe(linear)
    expect(lerpPaint(radial, '#ff0000', 0.5)).toBe(radial)
  })

  it('interpolates linear gradients with matching stop counts', () => {
    const other: LinearGradientPaint = {
      type: 'linear',
      angle: 180,
      stops: [
        { offset: 0, color: '#000000' },
        { offset: 0.5, color: '#808080' }
      ]
    }
    const mixed = lerpPaint(linear, other, 0.5) as LinearGradientPaint
    expect(mixed.type).toBe('linear')
    expect(mixed.angle).toBe(135)
    expect(mixed.stops).toEqual([
      { offset: 0, color: '#800000' },
      { offset: 0.75, color: '#4040c0' }
    ])
  })

  it('interpolates radial gradients', () => {
    const other: RadialGradientPaint = { ...radial, cx: 1, cy: 0, r: 1 }
    const mixed = lerpPaint(radial, other, 0.25) as RadialGradientPaint
    expect(mixed.type).toBe('radial')
    expect(mixed.cx).toBe(0.625)
    expect(mixed.cy).toBe(0.375)
    expect(mixed.r).toBe(0.625)
  })

  it('snaps mismatched types, stop counts and malformed stop colors', () => {
    expect(lerpPaint(linear, radial, 0.5)).toBe(linear)
    expect(lerpPaint(linear, radial, 1)).toBe(radial)
    const oneStop = { ...linear, stops: [linear.stops[0]] }
    expect(lerpPaint(linear, oneStop, 0.5)).toBe(linear)
    const badColor = {
      ...linear,
      stops: [
        { offset: 0, color: 'red' },
        { offset: 1, color: '#000000' }
      ]
    }
    expect(lerpPaint(linear, badColor, 0.5)).toBe(linear)
    expect(lerpPaint(linear, badColor, 1)).toBe(badColor)
  })

  it('interpolates stop alpha pairwise, treating absent as opaque', () => {
    const faded: LinearGradientPaint = {
      type: 'linear',
      angle: 90,
      stops: [
        { offset: 0, color: '#ff0000', alpha: 0 },
        { offset: 1, color: '#0000ff' }
      ]
    }
    const mixed = lerpPaint(linear, faded, 0.5) as LinearGradientPaint
    expect(mixed.stops[0].alpha).toBe(0.5)
    // Absent ≡ 1: the lerp stays at 1 and the field stays absent.
    expect(mixed.stops[1]).toEqual({ offset: 1, color: '#0000ff' })
    const end = lerpPaint(linear, faded, 1) as LinearGradientPaint
    expect(end.stops[0]).toEqual({ offset: 0, color: '#ff0000', alpha: 0 })
    expect(end.stops[1]).toEqual({ offset: 1, color: '#0000ff' })
    // Both ends opaque: alpha never appears.
    const opaque = lerpPaint(linear, linear, 0.5) as LinearGradientPaint
    expect(opaque.stops.every((stop) => stop.alpha === undefined)).toBe(true)
  })
})

describe('paintKey / paintGradientId', () => {
  it('is deterministic and ignores stop color case', () => {
    const upper: LinearGradientPaint = {
      ...linear,
      stops: [
        { offset: 0, color: '#FF0000' },
        { offset: 1, color: '#0000FF' }
      ]
    }
    expect(paintKey(upper)).toBe(paintKey(linear))
    expect(paintGradientId(linear)).toBe(`oa-grad-${paintKey(linear)}`)
    expect(paintGradientId(linear)).toMatch(/^oa-grad-[0-9a-z]+$/)
  })

  it('differs across geometry, stop values and gradient type', () => {
    expect(paintKey(linear)).not.toBe(paintKey({ ...linear, angle: 91 }))
    expect(paintKey(linear)).not.toBe(paintKey(radial))
    expect(paintKey(linear)).not.toBe(
      paintKey({
        ...linear,
        stops: [
          { offset: 0, color: '#ff0000' },
          { offset: 1, color: '#00ff00' }
        ]
      })
    )
  })

  it('folds only non-opaque stop alpha into the key', () => {
    const opaque: LinearGradientPaint = {
      ...linear,
      stops: [
        { offset: 0, color: '#ff0000', alpha: 1 },
        { offset: 1, color: '#0000ff' }
      ]
    }
    // alpha 1 and absent are equivalent, so pre-alpha ids stay stable.
    expect(paintKey(opaque)).toBe(paintKey(linear))
    expect(paintKey(opaque)).toBe(paintGradientId(linear).slice('oa-grad-'.length))
    const faded: LinearGradientPaint = {
      ...linear,
      stops: [
        { offset: 0, color: '#ff0000', alpha: 0.5 },
        { offset: 1, color: '#0000ff' }
      ]
    }
    expect(paintKey(faded)).not.toBe(paintKey(linear))
  })
})

describe('createDefaultGradientPaint', () => {
  it('builds a linear default from the base color, darkened toward the end', () => {
    const paint = createDefaultGradientPaint('linear', '#ffffff')
    expect(paint.type).toBe('linear')
    if (paint.type !== 'linear') throw new Error('expected linear')
    expect(paint.angle).toBe(90)
    expect(paint.stops[0]).toEqual({ offset: 0, color: '#ffffff' })
    expect(paint.stops[1].offset).toBe(1)
    expect(paint.stops[1].color).toBe('#8c8c8c')
  })

  it('builds a radial default centered on the bounding box', () => {
    const paint = createDefaultGradientPaint('radial', '#38bdf8')
    expect(paint.type).toBe('radial')
    if (paint.type !== 'radial') throw new Error('expected radial')
    expect(paint.cx).toBe(0.5)
    expect(paint.cy).toBe(0.5)
    expect(paint.r).toBe(0.5)
    expect(paint.stops[0].color).toBe('#38bdf8')
  })

  it('falls back to the accent color for invalid bases and is always valid', () => {
    const paint = createDefaultGradientPaint('linear', 'not-a-color') as GradientPaint
    expect(paint.stops[0].color).toBe('#38bdf8')
    expect(isPaintValue(paint)).toBe(true)
    expect(isPaintValue(createDefaultGradientPaint('radial', '#000000'))).toBe(true)
  })
})
