// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDocument } from '@shared/document'
import type { PathNode, TextNode } from '@shared/model'

import { Editor } from './editor'
import { convertSelectedTextToOutlines } from './textOutlines'

/**
 * Convert-to-outlines: the bundled Noto Sans TTF is fed through a stubbed
 * fetch so the real opentype.js parsing + glyph layout runs in the test.
 */

const NOTO_400 = 'node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf'
const NOTO_700 = 'node_modules/@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf'

function stubFontFetch(): void {
  const cache = new Map<string, ArrayBuffer>()
  const load = (path: string): ArrayBuffer => {
    let buffer = cache.get(path)
    if (!buffer) {
      buffer = readFileSync(path).buffer as ArrayBuffer
      cache.set(path, buffer)
    }
    return buffer
  }
  vi.stubGlobal('fetch', (url: string | URL) => {
    const file = String(url).endsWith('700Bold') ? NOTO_700 : NOTO_400
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(load(file))
    })
  })
}

function textEditor(fontFamily = 'Noto Sans'): Editor {
  const editor = new Editor(createDocument('outlines', 320, 180, 12), {
    measureText: (line: string) => line.length * 10
  })
  editor.addNode({
    id: 't1',
    type: 'text',
    center: { x: 100, y: 90 },
    width: 40,
    height: 60,
    rotation: 0,
    opacity: 1,
    text: 'Hi',
    fontFamily,
    fontSize: 48,
    fontWeight: 400,
    fill: '#ffcc00',
    align: 'left'
  })
  return editor
}

function selectedPathNode(editor: Editor): PathNode {
  const layer = editor.currentLayer
  if (layer?.kind !== 'object') throw new Error('expected an object layer')
  return layer.keyframes[0].nodes[0] as PathNode
}

describe('convertSelectedTextToOutlines', () => {
  beforeEach(() => {
    stubFontFetch()
  })

  it('replaces the selected text with multi-subpath vector outlines', async () => {
    const editor = textEditor()
    const replaced = await convertSelectedTextToOutlines(editor)
    expect(replaced).toBe(true)

    const layer = editor.currentLayer
    if (layer?.kind !== 'object') throw new Error('expected an object layer')
    const node = layer.keyframes[0].nodes[0] as PathNode
    expect(node.type).toBe('path')
    // Two glyphs → at least two subpaths; the fill and id carry over.
    expect(node.d.match(/M/g)?.length).toBeGreaterThanOrEqual(2)
    expect(node.d).not.toContain('NaN')
    expect(node.fill).toBe('#ffcc00')
    expect(node.id).toBe('t1')
    // The placed box matches the glyph bounds and the center is preserved.
    expect(node.width).toBeGreaterThan(0)
    expect(node.height).toBeGreaterThan(0)
    expect(node.center).toEqual({ x: 100, y: 90 })
  })

  it('reports a message when no text object is selected', async () => {
    const editor = new Editor(createDocument('empty', 320, 180, 12))
    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))
    expect(await convertSelectedTextToOutlines(editor)).toBe(false)
    expect(messages).toHaveLength(1)
  })

  it('keeps the text node when the font cannot be loaded', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }))
    const editor = textEditor()
    // Weight 700 is not cached by the earlier tests, so the fetch failure hits.
    ;(editor.currentLayer as { keyframes: { nodes: { fontWeight: number }[] }[] })
      .keyframes[0].nodes[0].fontWeight = 700
    const replaced = await convertSelectedTextToOutlines(editor)
    expect(replaced).toBe(false)
    const layer = editor.currentLayer
    if (layer?.kind !== 'object') throw new Error('expected an object layer')
    expect(layer.keyframes[0].nodes[0].type).toBe('text')
  })

  it('converts through the system font when the family resolves through window.api', async () => {
    const calls: Array<{ family: string; weight: number }> = []
    const fontBytes = new Uint8Array(readFileSync(NOTO_700))
    const previous = window.api
    window.api = {
      readSystemFont: (family: string, weight: number) => {
        calls.push({ family, weight })
        return Promise.resolve({ ok: true, bytes: fontBytes })
      }
    } as unknown as typeof window.api
    try {
      const editor = textEditor('Lato')
      const messages: string[] = []
      editor.onMessage((message) => messages.push(message))
      expect(await convertSelectedTextToOutlines(editor)).toBe(true)
      expect(calls).toEqual([{ family: 'Lato', weight: 400 }])
      const node = selectedPathNode(editor)
      expect(node.type).toBe('path')
      expect(node.d.match(/M/g)?.length).toBeGreaterThanOrEqual(2)
      expect(messages).toEqual(['Converted the text to vector outlines'])
    } finally {
      window.api = previous
    }
  })

  it('loads the italic face when converting italic text', async () => {
    const calls: Array<{ family: string; weight: number; italic: boolean | undefined }> = []
    const fontBytes = new Uint8Array(readFileSync(NOTO_700))
    const previous = window.api
    window.api = {
      readSystemFont: (family: string, weight: number, italic?: boolean) => {
        calls.push({ family, weight, italic })
        return Promise.resolve({ ok: true, bytes: fontBytes })
      }
    } as unknown as typeof window.api
    try {
      const editor = textEditor('Lato')
      const layer = editor.currentLayer
      if (layer?.kind !== 'object') throw new Error('expected an object layer')
      ;(layer.keyframes[0].nodes[0] as TextNode).fontStyle = 'italic'
      expect(await convertSelectedTextToOutlines(editor)).toBe(true)
      expect(calls).toEqual([{ family: 'Lato', weight: 400, italic: true }])
      expect(selectedPathNode(editor).type).toBe('path')
    } finally {
      window.api = previous
    }
  })

  it('does not fall back to the bundled upright font for italic text', async () => {
    const previous = window.api
    window.api = {
      readSystemFont: () => Promise.resolve({ ok: false, error: 'no italic face installed' })
    } as unknown as typeof window.api
    try {
      const editor = textEditor('Noto Sans')
      const layer = editor.currentLayer
      if (layer?.kind !== 'object') throw new Error('expected an object layer')
      ;(layer.keyframes[0].nodes[0] as TextNode).fontStyle = 'italic'
      const messages: string[] = []
      editor.onMessage((message) => messages.push(message))
      expect(await convertSelectedTextToOutlines(editor)).toBe(false)
      expect(messages).toEqual(['No font could be loaded for "Noto Sans"'])
      expect((editor.currentLayer as { keyframes: { nodes: { type: string }[] }[] }).keyframes[0].nodes[0].type).toBe(
        'text'
      )
    } finally {
      window.api = previous
    }
  })

  it('falls back to the bundled font and reports it when the system font is missing', async () => {
    const previous = window.api
    window.api = {
      readSystemFont: () => Promise.resolve({ ok: false, error: 'no face near that weight' })
    } as unknown as typeof window.api
    try {
      const editor = textEditor('Georgia')
      const messages: string[] = []
      editor.onMessage((message) => messages.push(message))
      expect(await convertSelectedTextToOutlines(editor)).toBe(true)
      expect(selectedPathNode(editor).type).toBe('path')
      expect(messages).toEqual([
        'Converted the text to vector outlines using the bundled Noto Sans font'
      ])
    } finally {
      window.api = previous
    }
  })

  it('converts with the bundled font when no main-process API is reachable', async () => {
    const editor = textEditor('Verdana')
    expect(await convertSelectedTextToOutlines(editor)).toBe(true)
    expect(selectedPathNode(editor).type).toBe('path')
  })

  it('re-lays the glyphs with letter spacing during conversion', async () => {
    const plain = textEditor()
    const spaced = textEditor()
    const layer = spaced.currentLayer
    if (layer?.kind !== 'object') throw new Error('expected an object layer')
    ;(layer.keyframes[0].nodes[0] as TextNode).letterSpacing = 5

    expect(await convertSelectedTextToOutlines(plain)).toBe(true)
    expect(await convertSelectedTextToOutlines(spaced)).toBe(true)

    const plainNode = selectedPathNode(plain)
    const spacedNode = selectedPathNode(spaced)
    // Two glyphs: one extra advance between them widens the ink bounds by 5.
    expect(spacedNode.width).toBeCloseTo(plainNode.width + 5, 1)
    expect(spacedNode.height).toBeCloseTo(plainNode.height, 1)
  })
})
