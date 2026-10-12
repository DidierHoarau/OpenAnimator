// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'

import { parse } from 'opentype.js'
import { describe, expect, it, vi } from 'vitest'

import { createDocument } from '@shared/document'
import { embeddedFontId } from '@shared/fontPolicy'
import type { FontEmbeddingPolicy } from '@shared/fontPolicy'
import type { AnimatorDocument, EmbeddedFont, TextNode } from '@shared/model'

import { Editor } from './editor'
import { EmbeddedFontSync, reconcileEmbeddedFonts } from './fontEmbedding'
import type { FontEmbeddingDeps, FontFacePort } from './fontEmbedding'

const NOTO_400 = new Uint8Array(
  readFileSync('node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf')
)

const POLICY: FontEmbeddingPolicy = {
  allow: [
    { pattern: 'Lato', license: 'OFL-1.1' },
    { pattern: 'My Font', license: 'Custom-1.0' }
  ],
  deny: []
}

function textNode(id: string, text: string, overrides: Partial<TextNode> = {}): TextNode {
  return {
    type: 'text',
    id,
    center: { x: 100, y: 90 },
    width: 40,
    height: 30,
    rotation: 0,
    opacity: 1,
    text,
    fontFamily: 'Lato',
    fontSize: 24,
    fontWeight: 400,
    fill: '#ffffff',
    align: 'left',
    ...overrides
  }
}

function textEditor(nodes: TextNode[]): Editor {
  const editor = new Editor(createDocument('embed', 320, 180, 12), {
    measureText: (line: string) => line.length * 10
  })
  for (const node of nodes) editor.addNode(node)
  return editor
}

function fakeDeps(overrides: Partial<FontEmbeddingDeps> = {}) {
  const added: Array<{ bytes: Uint8Array; fileName: string; resourceId: string }> = []
  const readFont = vi.fn(async () => NOTO_400)
  const deps: FontEmbeddingDeps = {
    getPolicy: async () => POLICY,
    readFont,
    addResource: async (bytes, fileName) => {
      const resourceId = `res-${added.length + 1}`
      added.push({ bytes, fileName, resourceId })
      return { resourceId }
    },
    syncFaces: async () => undefined,
    ...overrides
  }
  return { deps, added, readFont }
}

function font(overrides: Partial<EmbeddedFont> = {}): EmbeddedFont {
  return {
    id: embeddedFontId('Lato', 400),
    family: 'Lato',
    weight: 400,
    resourceId: 'res-existing',
    glyphs: ['!', 'H', 'i'],
    license: 'OFL-1.1',
    ...overrides
  }
}

describe('reconcileEmbeddedFonts', () => {
  it('embeds one subset per (family, weight) usage into the resource store', async () => {
    const editor = textEditor([
      textNode('a', 'Hi!'),
      textNode('b', 'Bye', { fontFamily: 'My Font', fontWeight: 700 })
    ])
    const { deps, added, readFont } = fakeDeps()
    const changed = await reconcileEmbeddedFonts(editor, deps)

    expect(changed).toBe(true)
    expect(editor.document.fonts).toHaveLength(2)
    const lato = editor.document.fonts.find((entry) => entry.family === 'Lato')
    expect(lato).toMatchObject({
      id: embeddedFontId('Lato', 400),
      weight: 400,
      license: 'OFL-1.1',
      resourceId: 'res-1',
      glyphs: ['!', 'H', 'i']
    })
    const custom = editor.document.fonts.find((entry) => entry.family === 'My Font')
    expect(custom).toMatchObject({ weight: 700, license: 'Custom-1.0', glyphs: ['B', 'e', 'y'] })
    expect(readFont).toHaveBeenCalledTimes(2)
    // File names carry the synthetic family; the bytes parse and cover the glyphs.
    expect(added[0].fileName).toBe(`${lato!.id}.ttf`)
    const subset = parse(added[0].bytes.buffer.slice(0) as ArrayBuffer)
    expect(subset.charToGlyphIndex('H')).toBeGreaterThan(0)
    // The subsets land in the session cache too (stage + export read them).
    expect(editor.resources.getBlob('res-1')).not.toBeNull()
    expect(editor.resources.getBlob('res-2')).not.toBeNull()
  })

  it('embeds italic usages as separate styled subsets with marked family ids', async () => {
    const editor = textEditor([textNode('a', 'Hi!'), textNode('b', 'Hi!', { fontStyle: 'italic' })])
    const { deps, readFont } = fakeDeps()
    const changed = await reconcileEmbeddedFonts(editor, deps)

    expect(changed).toBe(true)
    expect(editor.document.fonts).toHaveLength(2)
    const upright = editor.document.fonts.find((entry) => entry.italic === undefined)
    expect(upright).toMatchObject({ id: embeddedFontId('Lato', 400), weight: 400 })
    expect(editor.document.fonts.find((entry) => entry.italic === true)).toMatchObject({
      id: embeddedFontId('Lato', 400, true),
      weight: 400,
      italic: true
    })
    expect(readFont).toHaveBeenCalledWith('Lato', 400, false)
    expect(readFont).toHaveBeenCalledWith('Lato', 400, true)
  })

  it('keeps an existing subset that already covers every character', async () => {
    const editor = textEditor([textNode('a', 'Hi!')])
    const existing = font()
    editor.document.fonts = [existing]
    const { deps, added, readFont } = fakeDeps()
    const changed = await reconcileEmbeddedFonts(editor, deps)

    expect(changed).toBe(false)
    expect(editor.document.fonts).toEqual([existing])
    expect(readFont).not.toHaveBeenCalled()
    expect(added).toHaveLength(0)
  })

  it('re-subsets with the union of glyphs when new characters outgrow an entry', async () => {
    const editor = textEditor([textNode('a', 'Hi!')])
    editor.document.fonts = [font({ glyphs: ['H'] })]
    const { deps, added, readFont } = fakeDeps()
    const changed = await reconcileEmbeddedFonts(editor, deps)

    expect(changed).toBe(true)
    expect(readFont).toHaveBeenCalledTimes(1)
    expect(added).toHaveLength(1)
    expect(editor.document.fonts[0]).toMatchObject({ resourceId: 'res-1', glyphs: ['!', 'H', 'i'] })
  })

  it('skips denied or unreadable families, keeps the old subset and reports them', async () => {
    const editor = textEditor([
      textNode('a', 'Hi!'),
      textNode('b', 'Bye', { fontFamily: 'My Font', fontWeight: 700 })
    ])
    editor.document.fonts = [font({ glyphs: ['H'] })]
    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))
    const { deps, added } = fakeDeps({
      getPolicy: async () => ({ allow: POLICY.allow, deny: ['My Font*'] }),
      readFont: async () => null
    })
    const changed = await reconcileEmbeddedFonts(editor, deps)

    // Lato could not be read, My Font is denied: only the old Lato subset
    // stays, so the list equals what was there before.
    expect(changed).toBe(false)
    expect(added).toHaveLength(0)
    expect(editor.document.fonts).toEqual([font({ glyphs: ['H'] })])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('Lato')
    expect(messages[0]).toContain('My Font')
  })

  it('prunes subsets that no text usage references anymore', async () => {
    const editor = textEditor([textNode('a', 'Hi!')])
    editor.document.fonts = [font(), font({ id: 'oa-embed-700-00000000', family: 'Gone', weight: 700 })]
    const { deps } = fakeDeps()
    const changed = await reconcileEmbeddedFonts(editor, deps)

    expect(changed).toBe(true)
    expect(editor.document.fonts).toEqual([font()])
  })

  it('does nothing (and skips the policy call) for empty documents', async () => {
    const editor = textEditor([])
    const getPolicy = vi.fn()
    const { deps } = fakeDeps({ getPolicy: getPolicy as unknown as FontEmbeddingDeps['getPolicy'] })
    expect(await reconcileEmbeddedFonts(editor, deps)).toBe(false)
    expect(getPolicy).not.toHaveBeenCalled()
  })
})

describe('EmbeddedFontSync', () => {
  function fakePort() {
    const added: Array<{ family: string; weight: number; bytes: ArrayBuffer; italic: boolean }> = []
    const removed: unknown[] = []
    let fail = false
    const port: FontFacePort = {
      add: async (family, weight, bytes, italic) => {
        if (fail) throw new Error('FontFace unavailable')
        const handle = { family, weight }
        added.push({ family, weight, bytes, italic })
        return handle
      },
      remove: (handle) => {
        removed.push(handle)
      }
    }
    return { port, added, removed, setFail: (value: boolean) => (fail = value) }
  }

  function documentWithFonts(fonts: EmbeddedFont[]): AnimatorDocument {
    const document = createDocument('sync', 100, 100, 12)
    document.fonts = fonts
    return document
  }

  const blobs = new Map<string, ArrayBuffer>([
    ['res-1', new Uint8Array([1, 2, 3]).buffer],
    ['res-2', new Uint8Array([4, 5]).buffer]
  ])
  const readBlob = (resourceId: string): Blob | null => {
    const bytes = blobs.get(resourceId)
    return bytes ? ({ arrayBuffer: () => Promise.resolve(bytes) } as unknown as Blob) : null
  }

  it('registers new subsets, skips unchanged ones and re-registers changed bytes', async () => {
    const { port, added, removed } = fakePort()
    const sync = new EmbeddedFontSync(port)
    const document = documentWithFonts([font({ resourceId: 'res-1' })])

    await sync.sync(document, readBlob)
    expect(added).toHaveLength(1)
    expect(added[0].family).toBe(embeddedFontId('Lato', 400))
    expect(added[0].weight).toBe(400)

    await sync.sync(document, readBlob)
    expect(added).toHaveLength(1)

    document.fonts = [font({ resourceId: 'res-2' })]
    await sync.sync(document, readBlob)
    expect(added).toHaveLength(2)
    expect(removed).toHaveLength(1)
  })

  it('registers italic subsets with the italic style flag', async () => {
    const { port, added } = fakePort()
    const sync = new EmbeddedFontSync(port)
    const document = documentWithFonts([font({ resourceId: 'res-1', id: 'oa-embed-400-ab12cd34i', italic: true })])
    await sync.sync(document, readBlob)
    expect(added).toHaveLength(1)
    expect(added[0].italic).toBe(true)
    expect(added[0].family).toBe('oa-embed-400-ab12cd34i')
  })

  it('unregisters faces whose subsets left the document', async () => {
    const { port, removed } = fakePort()
    const sync = new EmbeddedFontSync(port)
    const document = documentWithFonts([font({ resourceId: 'res-1' })])
    await sync.sync(document, readBlob)

    document.fonts = []
    await sync.sync(document, readBlob)
    expect(removed).toHaveLength(1)
  })

  it('swallows registration failures and retries while bytes are resolvable', async () => {
    const { port, added, setFail } = fakePort()
    setFail(true)
    const sync = new EmbeddedFontSync(port)
    const document = documentWithFonts([font({ resourceId: 'res-1' })])
    await sync.sync(document, readBlob)
    expect(added).toHaveLength(0)

    setFail(false)
    await sync.sync(document, readBlob)
    expect(added).toHaveLength(1)
  })

  it('skips subsets whose resource bytes are missing', async () => {
    const { port, added } = fakePort()
    const sync = new EmbeddedFontSync(port)
    await sync.sync(documentWithFonts([font({ resourceId: 'missing' })]), readBlob)
    expect(added).toHaveLength(0)
  })
})
