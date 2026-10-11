// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDocument } from '@shared/document'
import type { AnimatorDocument, ImageNode } from '@shared/model'

import { Editor } from './editor'
import { detectImageFormat, importImageBytes } from './imageImport'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3])
const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"></svg>')
const RASTER_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9])

function fakeApi(addResource: ReturnType<typeof vi.fn>): void {
  ;(window as unknown as { api: unknown }).api = { addResource }
}

function setupEditor(): { editor: Editor; document: AnimatorDocument } {
  const document = createDocument('test', 960, 540, 24)
  const editor = new Editor(document)
  return { editor, document }
}

describe('detectImageFormat', () => {
  it('detects by extension first (SVG has no magic bytes)', () => {
    expect(detectImageFormat('art.svg', SVG_BYTES)).toBe('svg')
    expect(detectImageFormat('photo.PNG', PNG_BYTES)).toBe('png')
    expect(detectImageFormat('clip.gif', GIF_BYTES)).toBe('gif')
    expect(detectImageFormat('photo.jpeg', PNG_BYTES)).toBe('jpg')
  })

  it('falls back to magic bytes', () => {
    expect(detectImageFormat('noext', PNG_BYTES)).toBe('png')
    expect(detectImageFormat('noext', GIF_BYTES)).toBe('gif')
    expect(detectImageFormat('noext', SVG_BYTES)).toBe('svg')
    expect(detectImageFormat('noext', new Uint8Array([1, 2, 3]))).toBeNull()
  })
})

describe('importImageBytes', () => {
  let editor: Editor

  beforeEach(() => {
    document.body.textContent = ''
    ;({ editor } = setupEditor())
  })

  function deps(overrides: Partial<Parameters<typeof importImageBytes>[4]> = {}) {
    return {
      decode: vi.fn(() => Promise.resolve({ width: 640, height: 480 })),
      encodePng: vi.fn(() => Promise.resolve(RASTER_PNG)),
      ...overrides
    }
  }

  it('imports a PNG at natural size capped to the stage, centered and selected', async () => {
    const addResource = vi.fn(() => Promise.resolve({ resourceId: 'hash-1', deduped: false }))
    fakeApi(addResource)
    const message = vi.fn()
    editor.onMessage(message)

    const ok = await importImageBytes(
      editor,
      'big.png',
      PNG_BYTES,
      undefined,
      deps({ decode: () => Promise.resolve({ width: 1920, height: 1080 }) })
    )

    expect(ok).toBe(true)
    expect(addResource).toHaveBeenCalledWith(PNG_BYTES, 'big.png')
    const node = editor.document.layers[0].keyframes[0].nodes[0] as ImageNode
    expect(node.type).toBe('image')
    expect(node.name).toBe('big.png')
    expect(node.resourceId).toBe('hash-1')
    // 1920/1080 proportions capped into 960×540.
    expect(node.width).toBe(960)
    expect(node.height).toBe(540)
    expect(node.center).toEqual({ x: 480, y: 270 })
    expect(node.naturalWidth).toBe(1920)
    expect(node.naturalHeight).toBe(1080)
    expect(node.smoothing).toBe(true)
    expect(node.rotation).toBe(0)
    expect(node.opacity).toBe(1)
    expect(editor.selectedNodeIds).toEqual([node.id])
    expect(message).not.toHaveBeenCalled()
  })

  it('keeps images that fit the stage uncapped', async () => {
    const addResource = vi.fn(() => Promise.resolve({ resourceId: 'hash-2', deduped: false }))
    fakeApi(addResource)
    await importImageBytes(
      editor,
      'small.png',
      PNG_BYTES,
      undefined,
      deps({ decode: () => Promise.resolve({ width: 300, height: 200 }) })
    )
    const node = editor.document.layers[0].keyframes[0].nodes[0] as ImageNode
    expect(node.width).toBe(300)
    expect(node.height).toBe(200)
    expect(node.naturalWidth).toBe(300)
  })

  it('places at the drop point when given', async () => {
    const addResource = vi.fn(() => Promise.resolve({ resourceId: 'hash-3', deduped: false }))
    fakeApi(addResource)
    await importImageBytes(editor, 'small.png', PNG_BYTES, { x: 120, y: 90 }, deps())
    const node = editor.document.layers[0].keyframes[0].nodes[0] as ImageNode
    expect(node.center).toEqual({ x: 120, y: 90 })
  })

  it('dedupes through the main-process store and keeps the original bytes', async () => {
    const addResource = vi.fn(() => Promise.resolve({ resourceId: 'hash-1', deduped: true }))
    fakeApi(addResource)
    await importImageBytes(editor, 'again.png', PNG_BYTES, undefined, deps())
    expect(addResource).toHaveBeenCalledWith(PNG_BYTES, 'again.png')
    const node = editor.document.layers[0].keyframes[0].nodes[0] as ImageNode
    expect(node.resourceId).toBe('hash-1')
  })

  it('re-encodes GIFs to a PNG of their first frame at natural size', async () => {
    const addResource = vi.fn(() => Promise.resolve({ resourceId: 'hash-gif', deduped: false }))
    fakeApi(addResource)
    const encoded = deps({
      decode: vi.fn(() => Promise.resolve({ width: 200, height: 100 })),
      encodePng: vi.fn(() => Promise.resolve(RASTER_PNG))
    })
    await importImageBytes(editor, 'anim.gif', GIF_BYTES, undefined, encoded)
    expect(encoded.encodePng).toHaveBeenCalledWith(GIF_BYTES, 'image/gif', { width: 200, height: 100 }, 1)
    expect(addResource).toHaveBeenCalledWith(RASTER_PNG, 'anim.gif')
    const node = editor.document.layers[0].keyframes[0].nodes[0] as ImageNode
    expect(node.naturalWidth).toBe(200)
    expect(node.naturalHeight).toBe(100)
  })

  it('rasterizes SVGs at 2× and reports the rasterized natural size', async () => {
    const addResource = vi.fn(() => Promise.resolve({ resourceId: 'hash-svg', deduped: false }))
    fakeApi(addResource)
    const encoded = deps({
      decode: vi.fn(() => Promise.resolve({ width: 40, height: 30 })),
      encodePng: vi.fn(() => Promise.resolve(RASTER_PNG))
    })
    await importImageBytes(editor, 'icon.svg', SVG_BYTES, undefined, encoded)
    expect(encoded.encodePng).toHaveBeenCalledWith(SVG_BYTES, 'image/svg+xml', { width: 40, height: 30 }, 2)
    expect(addResource).toHaveBeenCalledWith(RASTER_PNG, 'icon.svg')
    const node = editor.document.layers[0].keyframes[0].nodes[0] as ImageNode
    expect(node.naturalWidth).toBe(80)
    expect(node.naturalHeight).toBe(60)
    expect(node.width).toBe(80)
    expect(node.height).toBe(60)
  })

  it('is a no-op with a status message when the current layer is locked', async () => {
    const addResource = vi.fn()
    fakeApi(addResource)
    editor.document.layers[0].locked = true
    const message = vi.fn()
    editor.onMessage(message)
    const ok = await importImageBytes(editor, 'x.png', PNG_BYTES, undefined, deps())
    expect(ok).toBe(false)
    expect(addResource).not.toHaveBeenCalled()
    expect(editor.document.layers[0].keyframes[0].nodes.length).toBe(0)
    expect(message).toHaveBeenCalledWith('Select a visible, unlocked object layer to import the image')
  })

  it('rejects unsupported formats with a status message', async () => {
    const addResource = vi.fn()
    fakeApi(addResource)
    const message = vi.fn()
    editor.onMessage(message)
    const ok = await importImageBytes(
      editor,
      'song.mp3',
      new Uint8Array([1, 2, 3]),
      undefined,
      deps()
    )
    expect(ok).toBe(false)
    expect(addResource).not.toHaveBeenCalled()
    expect(message).toHaveBeenCalledWith('Unsupported image format (PNG, JPG, WebP, GIF or SVG)')
  })

  it('reports a decode failure without touching the document', async () => {
    const addResource = vi.fn()
    fakeApi(addResource)
    const ok = await importImageBytes(
      editor,
      'broken.png',
      PNG_BYTES,
      undefined,
      deps({ decode: () => Promise.reject(new Error('bad image')) })
    )
    expect(ok).toBe(false)
    expect(addResource).not.toHaveBeenCalled()
  })
})
