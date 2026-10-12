import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse } from 'opentype.js'
import { describe, expect, it } from 'vitest'

import { createDocument, createDrawingLayer, createLayer } from './document'
import { fontUsage, subsetFont } from './fontSubset'
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
  it('keys usages by family+weight and unions characters across keyframes', () => {
    const document = createDocument('t', 100, 100, 12)
    const layer = createLayer('L')
    layer.keyframes.push({ frame: 0, nodes: [textNode('a', 'Hi')] })
    layer.keyframes.push({ frame: 4, nodes: [textNode('a', 'Ho'), textNode('b', 'Bye', { fontWeight: 700 })] })
    document.layers = [layer, createDrawingLayer('paint')]
    const usages = fontUsage(document)
    expect([...usages.keys()].sort()).toEqual(['noto sans|400', 'noto sans|700'])
    expect([...usages.get('noto sans|400')!.chars].sort()).toEqual(['H', 'i', 'o'])
    expect([...usages.get('noto sans|700')!.chars].sort()).toEqual(['B', 'e', 'y'])
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
    expect([...usages.get('noto sans|400')!.chars].sort()).toEqual(['Z', 'z'])
    expect([...usages.get('lato|400')!.chars].sort()).toEqual(['Q', 'X', 'y'])
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
