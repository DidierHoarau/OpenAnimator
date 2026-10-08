import { describe, expect, it } from 'vitest'

import { formatHexColor, lerpHexColor, parseHexColor } from './color'

describe('parseHexColor', () => {
  it('parses 6-digit hex colors', () => {
    expect(parseHexColor('#ff8000')).toEqual([255, 128, 0])
    expect(parseHexColor('#FF8000')).toEqual([255, 128, 0])
  })

  it('parses 3-digit hex colors', () => {
    expect(parseHexColor('#f00')).toEqual([255, 0, 0])
  })

  it('rejects invalid values', () => {
    expect(parseHexColor('ff8000')).toBeNull()
    expect(parseHexColor('#ff80')).toBeNull()
    expect(parseHexColor('#zzzzzz')).toBeNull()
    expect(parseHexColor('')).toBeNull()
  })
})

describe('formatHexColor', () => {
  it('formats and clamps channels', () => {
    expect(formatHexColor([255, 128, 0])).toBe('#ff8000')
    expect(formatHexColor([300, -20, 10.4])).toBe('#ff000a')
  })
})

describe('lerpHexColor', () => {
  it('interpolates between two colors', () => {
    expect(lerpHexColor('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(lerpHexColor('#000000', '#ffffff', 0)).toBe('#000000')
    expect(lerpHexColor('#000000', '#ffffff', 1)).toBe('#ffffff')
  })

  it('returns null when either color is invalid', () => {
    expect(lerpHexColor('nope', '#ffffff', 0.5)).toBeNull()
    expect(lerpHexColor('#000000', 'nope', 0.5)).toBeNull()
  })
})
