import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { parse } from 'opentype.js'
import type { Font } from 'opentype.js'
import { beforeAll, describe, expect, it } from 'vitest'

import type { TextNode } from './model'
import { pathDataBounds, pathDataToSubpathAnchors } from './pathModel'
import { linePathData, textNodeToOutlinePath } from './textOutline'

/**
 * Outline math against the real bundled Noto Sans TTF (the same font the
 * app and the CLI fall back to): fs read + opentype parse in plain node.
 */

const require = createRequire(import.meta.url)

let font: Font

beforeAll(() => {
  const bytes = readFileSync(
    require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf')
  )
  font = parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
})

function textNode(overrides: Partial<TextNode> = {}): TextNode {
  return {
    id: 't1',
    name: 'Title',
    type: 'text',
    center: { x: 100, y: 90 },
    width: 160,
    height: 48,
    rotation: 15,
    opacity: 0.8,
    text: 'Hi',
    fontFamily: 'Noto Sans',
    fontSize: 48,
    fontWeight: 400,
    fill: '#ffcc00',
    align: 'left',
    ...overrides
  }
}

describe('linePathData', () => {
  it('encodes the line as path data', () => {
    const d = linePathData(font, 'A', 0, 100, 48, 0)
    expect(d).not.toBe('')
    expect(pathDataBounds(d)).not.toBeNull()
  })

  it('widens the line by one letter-spacing advance per character', () => {
    const without = pathDataBounds(linePathData(font, 'AB', 0, 100, 48, 0))!
    const withSpacing = pathDataBounds(linePathData(font, 'AB', 0, 100, 48, 10))!
    expect(withSpacing.width).toBeGreaterThan(without.width)
    expect(withSpacing.width - without.width).toBeCloseTo(10, 5)
  })
})

describe('textNodeToOutlinePath', () => {
  it('keeps the pose fields, fill only, and normalized multi-subpath data', () => {
    const outline = textNodeToOutlinePath(textNode(), font)
    expect(outline).not.toBeNull()
    expect(outline!.id).toBe('t1')
    expect(outline!.name).toBe('Title')
    expect(outline!.type).toBe('path')
    expect(outline!.center).toEqual({ x: 100, y: 90 })
    expect(outline!.rotation).toBe(15)
    expect(outline!.opacity).toBe(0.8)
    expect(outline!.fill).toBe('#ffcc00')
    expect(outline!.stroke).toBeUndefined()
    expect(outline!.d.startsWith('M')).toBe(true)
    // "Hi" draws two glyphs → at least two contours (glyph counters add more).
    const subpaths = pathDataToSubpathAnchors(outline!.d)
    expect(subpaths).not.toBeNull()
    expect(subpaths!.length).toBeGreaterThanOrEqual(2)
    // The data is normalized to sit centered on its own bounding box.
    const bounds = pathDataBounds(outline!.d)!
    expect(bounds.x + bounds.width / 2).toBeCloseTo(0, 1)
    expect(bounds.y + bounds.height / 2).toBeCloseTo(0, 1)
  })

  it('sizes the path to the glyph bounds, floored at 2 px', () => {
    const outline = textNodeToOutlinePath(textNode(), font)!
    const bounds = pathDataBounds(outline.d)!
    expect(outline.width).toBeCloseTo(Math.max(2, bounds.width), 1)
    expect(outline.height).toBeCloseTo(Math.max(2, bounds.height), 1)
  })

  it('outlines every line of multi-line text', () => {
    const perLine = pathDataToSubpathAnchors(textNodeToOutlinePath(textNode({ text: 'A' }), font)!.d)!.length
    const outline = textNodeToOutlinePath(textNode({ text: 'A\nA\nA' }), font)!
    expect(pathDataToSubpathAnchors(outline.d)!.length).toBe(3 * perLine)
    // Lines sit on different baselines: the bounds are taller than one line.
    const single = textNodeToOutlinePath(textNode({ text: 'A' }), font)!
    expect(pathDataBounds(outline.d)!.height).toBeGreaterThan(pathDataBounds(single.d)!.height)
  })

  it('widens the outline with letter spacing', () => {
    const plain = textNodeToOutlinePath(textNode({ text: 'AB' }), font)!
    const spaced = textNodeToOutlinePath(textNode({ text: 'AB', letterSpacing: 8 }), font)!
    expect(spaced.width).toBeCloseTo(plain.width + 8, 1)
  })

  it('returns null when the text lays out no glyphs', () => {
    expect(textNodeToOutlinePath(textNode({ text: '' }), font)).toBeNull()
    expect(textNodeToOutlinePath(textNode({ text: ' \n ' }), font)).toBeNull()
  })
})
