import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Font, Glyph, Path, parse } from 'opentype.js'
import { describe, expect, it } from 'vitest'

import { createDocument, createDrawingLayer, createLayer } from './document'
import { extractKerningPairs, fontUsage, spliceKernTable, subsetFont } from './fontSubset'
import type { AnimatorDocument, GroupNode, SceneNode, TextNode } from './model'

const NOTO_400 = new Uint8Array(
  readFileSync(join(__dirname, '..', '..', 'node_modules', '@expo-google-fonts', 'noto-sans', '400Regular', 'NotoSans_400Regular.ttf'))
)

function textNode(id: string, text: string, overrides: Partial<TextNode> = {}): TextNode {
  return {
    type: 'text',
    id,
    center: { x: 0, y: 0 },
    width: 100,
    height: 24,
    rotation: 0,
    opacity: 1,
    text,
    fontFamily: 'Noto Sans',
    fontSize: 20,
    fontWeight: 400,
    fill: '#ffffff',
    align: 'left',
    ...overrides
  }
}

function documentWith(nodes: SceneNode[]): AnimatorDocument {
  const document = createDocument('t', 100, 100, 12)
  const layer = createLayer('L')
  layer.keyframes.push({ frame: 0, nodes })
  document.layers.push(layer)
  return document
}

describe('fontUsage', () => {
  it('keys usages by family+weight+style and unions characters across keyframes', () => {
    const document = createDocument('t', 100, 100, 12)
    const layer = createLayer('L')
    layer.keyframes.push({ frame: 0, nodes: [textNode('a', 'Hi')] })
    layer.keyframes.push({
      frame: 4,
      nodes: [textNode('a', 'Ho'), textNode('b', 'Bye', { fontWeight: 700 }), textNode('c', 'It', { fontStyle: 'italic' })]
    })
    document.layers = [layer, createDrawingLayer('paint')]
    const usages = fontUsage(document)
    expect([...usages.keys()].sort()).toEqual(['noto sans|400|false', 'noto sans|400|true', 'noto sans|700|false'])
    expect([...usages.get('noto sans|400|false')!.chars].sort()).toEqual(['H', 'i', 'o'])
    expect([...usages.get('noto sans|700|false')!.chars].sort()).toEqual(['B', 'e', 'y'])
    expect([...usages.get('noto sans|400|true')!.chars].sort()).toEqual(['I', 't'])
    expect(usages.get('noto sans|400|false')!.italic).toBe(false)
    expect(usages.get('noto sans|400|true')!.italic).toBe(true)
    // The plain 'normal' style shares the upright usage key.
    expect(usages.get('noto sans|400|true')!.chars.has('H')).toBe(false)
  })

  it('recurses into groups and follows symbol instances with a cycle guard', () => {
    const content: GroupNode = {
      type: 'group',
      id: 'g',
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      children: [textNode('inner', 'Xy', { fontFamily: 'Lato' })]
    }
    const document = documentWith([
      {
        type: 'group',
        id: 'outer',
        center: { x: 0, y: 0 },
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1,
        children: [textNode('deep', 'Zz')]
      },
      { type: 'symbol', id: 's1', assetId: 'sym', center: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0, opacity: 1 },
      { type: 'symbol', id: 's2', assetId: 'cyclic', center: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0, opacity: 1 }
    ])
    document.assets = [
      { id: 'sym', name: 'sym', kind: 'symbol', content, createdAt: 1 },
      {
        // Referenced cyclically by itself: must not loop forever, and its own
        // text must still be collected exactly once.
        id: 'cyclic',
        name: 'cyclic',
        kind: 'symbol',
        content: {
          type: 'group',
          id: 'cg',
          center: { x: 0, y: 0 },
          width: 10,
          height: 10,
          rotation: 0,
          opacity: 1,
          children: [
            textNode('ct', 'Q', { fontFamily: 'Lato' }),
            { type: 'symbol', id: 'loops', assetId: 'cyclic', center: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0, opacity: 1 }
          ]
        },
        createdAt: 1
      }
    ]
    const usages = fontUsage(document)
    expect([...usages.get('noto sans|400|false')!.chars].sort()).toEqual(['Z', 'z'])
    expect([...usages.get('lato|400|false')!.chars].sort()).toEqual(['Q', 'X', 'y'])
  })

  it('ignores drawing layers and non-text nodes', () => {
    const document = documentWith([])
    const usages = fontUsage(document)
    expect(usages.size).toBe(0)
  })
})

describe('subsetFont', () => {
  it('packs only the requested glyphs into a smaller parseable TTF', () => {
    const subsetBytes = subsetFont(NOTO_400, ['H', 'i', '!'], 'oa-embed-400-ab12cd34')
    expect(subsetBytes.byteLength).toBeGreaterThan(0)
    expect(subsetBytes.byteLength).toBeLessThan(NOTO_400.byteLength / 10)

    const subset = parse(subsetBytes.buffer.slice(subsetBytes.byteOffset, subsetBytes.byteOffset + subsetBytes.byteLength) as ArrayBuffer)
    expect(subset.getEnglishName('fontFamily')).toBe('oa-embed-400-ab12cd34')
    expect(subset.unitsPerEm).toBe(parse(NOTO_400.slice().buffer).unitsPerEm)
    for (const char of ['H', 'i', '!']) {
      expect(subset.charToGlyphIndex(char)).toBeGreaterThan(0)
    }
    // Characters outside the subset map to .notdef.
    expect(subset.charToGlyphIndex('Z')).toBe(0)
  })

  it('is deterministic in glyph coverage across calls', () => {
    const first = parse(subsetFont(NOTO_400, ['A', 'B'], 'F').slice().buffer)
    const second = parse(subsetFont(NOTO_400, ['A', 'B'], 'F').slice().buffer)
    expect(first.numGlyphs).toBe(second.numGlyphs)
    expect(first.charToGlyphIndex('A')).toBe(second.charToGlyphIndex('A'))
  })

  it('throws on unparseable bytes and on characters no glyph covers', () => {
    expect(() => subsetFont(new Uint8Array([1, 2, 3, 4]), ['A'], 'F')).toThrow(/could not be parsed/)
    expect(() => subsetFont(NOTO_400, ['\uE000'], 'F')).toThrow(/no glyphs/)
  })
})

describe('extractKerningPairs', () => {
  it('reads the GPOS kern lookups and keeps only pairs inside the subset', () => {
    const source = parse(NOTO_400.slice().buffer)
    const pairs = extractKerningPairs(source)
    expect(pairs.size).toBeGreaterThan(0)
    expect([...pairs.values()].every((value) => value !== 0)).toBe(true)

    // Map source glyph index -> a character rendering it, then pick a pair
    // whose both glyphs are reachable from real characters.
    const charFor = new Map<number, string>()
    for (const [from, to] of [
      [0x20, 0x4ff],
      [0x1e00, 0x1fff]
    ] as const) {
      for (let code = from; code <= to; code++) {
        const char = String.fromCodePoint(code)
        const index = source.charToGlyphIndex(char)
        if (index > 0 && !charFor.has(index)) charFor.set(index, char)
      }
    }
    const found = [...pairs.entries()].find(([key]) => {
      const [left, right] = key.split(',').map(Number)
      return left !== right && charFor.has(left) && charFor.has(right)
    })
    expect(found).toBeDefined()
    const [pairKey, pairValue] = found!
    const [leftGlyph, rightGlyph] = pairKey.split(',').map(Number)
    const chars = [charFor.get(leftGlyph)!, charFor.get(rightGlyph)!]
    const keptGlyphs = [leftGlyph, rightGlyph]

    const subset = parse(subsetFont(NOTO_400, chars, 'F').slice().buffer)
    // The rebuild packs the kept glyphs in order, so the pair moves to the
    // packed indices 1 and 2 — and every other extracted pair references an
    // excluded glyph and must be gone.
    const expected = new Map<string, number>()
    for (const [key, value] of pairs) {
      const [left, right] = key.split(',').map(Number)
      const leftAt = keptGlyphs.indexOf(left)
      const rightAt = keptGlyphs.indexOf(right)
      if (leftAt >= 0 && rightAt >= 0) expected.set(`${leftAt + 1},${rightAt + 1}`, value)
    }
    expect(expected.get('1,2')).toBe(pairValue)
    const dropped = [...pairs.keys()].filter((key) => {
      const [left, right] = key.split(',').map(Number)
      return !(keptGlyphs.includes(left) && keptGlyphs.includes(right))
    })
    expect(dropped.length).toBeGreaterThan(0)
    expect(subset.kerningPairs).toEqual(Object.fromEntries(expected))
    expect(subset.getKerningValue(subset.charToGlyphIndex(chars[0]), subset.charToGlyphIndex(chars[1]))).toBe(
      pairValue
    )
  })
})

describe('spliceKernTable', () => {
  function syntheticFont(): Uint8Array {
    const box = (): Path => {
      const path = new Path()
      path.moveTo(0, 0)
      path.lineTo(400, 0)
      path.lineTo(400, 700)
      path.close()
      return path
    }
    const font = new Font({
      familyName: 'Kern Fixture',
      styleName: 'Regular',
      unitsPerEm: 1000,
      ascender: 800,
      descender: -200,
      glyphs: [
        new Glyph({ name: '.notdef', advanceWidth: 500, path: new Path() }),
        new Glyph({ name: 'A', unicode: 0x41, advanceWidth: 500, path: box() }),
        new Glyph({ name: 'V', unicode: 0x56, advanceWidth: 500, path: box() })
      ]
    })
    return new Uint8Array(font.toArrayBuffer())
  }

  it('round-trips legacy kern pairs through the rebuilt sfnt with a valid checksum', () => {
    const spliced = spliceKernTable(syntheticFont(), new Map([['1,2', -123], ['2,1', 40]]))
    const parsed = parse(spliced.slice().buffer)
    expect(parsed.getEnglishName('fontFamily')).toBe('Kern Fixture')
    expect(parsed.kerningPairs).toEqual({ '1,2': -123, '2,1': 40 })
    expect(parsed.getKerningValue(parsed.charToGlyphIndex('A'), parsed.charToGlyphIndex('V'))).toBe(-123)
    // Without GPOS the extractor falls back to the legacy pairs.
    expect(Object.fromEntries(extractKerningPairs(parsed))).toEqual({ '1,2': -123, '2,1': 40 })

    let sum = 0
    const view = new DataView(spliced.buffer, spliced.byteOffset, spliced.byteLength)
    for (let at = 0; at < spliced.byteLength; at += 4) sum = (sum + view.getUint32(at)) >>> 0
    expect(sum).toBe(0xb1b0afba)
  })

  it('returns the input unchanged when there are no pairs', () => {
    const bytes = syntheticFont()
    expect(spliceKernTable(bytes, new Map())).toBe(bytes)
  })
})
