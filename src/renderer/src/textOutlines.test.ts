// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDocument } from '@shared/document'
import type { PathNode } from '@shared/model'

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

function textEditor(): Editor {
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
    fontFamily: 'Noto Sans',
    fontSize: 48,
    fontWeight: 400,
    fill: '#ffcc00',
    align: 'left'
  })
  return editor
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
})
