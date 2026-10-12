// @vitest-environment happy-dom
import { strFromU8, unzipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAudioLayer, createDocument, createDrawingLayer } from '@shared/document'
import type { ExportOptions } from '@shared/exportOptions'
import { createIncrementalGifEncoder } from '@shared/gifEncode'
import type { GifEncodeOptions } from '@shared/gifEncode'
import type { TextNode } from '@shared/model'
import { Editor } from '../editor'

import type { GifEncodeClient } from './gifEncodeClient'
import { createDefaultExportRunnerDeps, runExport, type ExportRunnerDeps } from './runExport'

// The real encoder needs WebCodecs (absent here), so the video path is driven
// through controllable stubs; everything else stays the actual module.
const videoEncoder = vi.hoisted(() => ({
  canEncodeVideo: vi.fn(() => false),
  encodeVideo: vi.fn()
}))

vi.mock('./videoEncoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./videoEncoder')>()
  return {
    ...actual,
    canEncodeVideo: videoEncoder.canEncodeVideo,
    encodeVideo: videoEncoder.encodeVideo
  }
})

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

interface FakeStream {
  path: string
  chunks: Uint8Array[]
  committed: boolean | null
}

function inlineGifClient(): GifEncodeClient {
  const encoder = createIncrementalGifEncoder()
  return {
    addFrame: (frame) => {
      encoder.addFrame(frame)
      return Promise.resolve()
    },
    finish: () => Promise.resolve(encoder.finish()),
    dispose: () => undefined
  }
}

function fakeDeps(overrides: Partial<ExportRunnerDeps> = {}): ExportRunnerDeps & {
  written: Array<{ path: string; bytes: Uint8Array }>
  streams: FakeStream[]
  messages: string[]
  progress: Array<{ done: number; total: number }>
  picked: Array<{ defaultName: string; filters: unknown }>
  diagnostics: string[][]
} {
  const fakeContext = {
    clearRect: () => {},
    drawImage: () => {}
  }
  const deps = {
    resolveResourceDataUrl: () => Promise.resolve('data:image/png;base64,AAA'),
    createObjectUrl: () => 'blob:svg',
    revokeObjectUrl: () => {},
    loadImage: () => Promise.resolve({} as CanvasImageSource),
    createCanvas: (width: number, height: number) =>
      ({
        width,
        height,
        getContext: () => fakeContext
      }) as unknown as HTMLCanvasElement,
    canvasToPng: () => Promise.resolve(new Uint8Array(PNG_MAGIC)),
    canvasToRgba: (canvas: HTMLCanvasElement) =>
      new Uint8ClampedArray(canvas.width * canvas.height * 4),
    pickExportPath: (request: { defaultName: string; filters: unknown }) => {
      deps.picked.push(request)
      return Promise.resolve({ canceled: false, path: '/tmp/out' })
    },
    writeExportFile: (path: string, bytes: Uint8Array) => {
      deps.written.push({ path, bytes })
      return Promise.resolve({ ok: true })
    },
    openExportStream: (path: string) => {
      deps.streams.push({ path, chunks: [], committed: null })
      return Promise.resolve({ ok: true, token: String(deps.streams.length - 1) })
    },
    writeExportStream: (token: string, chunk: Uint8Array) => {
      deps.streams[Number(token)].chunks.push(chunk)
      return Promise.resolve({ ok: true })
    },
    finishExportStream: (token: string, commit: boolean) => {
      deps.streams[Number(token)].committed = commit
      return Promise.resolve({ ok: true })
    },
    createGifEncodeClient: () => Promise.resolve(inlineGifClient()),
    showMessage: (message: string) => {
      deps.messages.push(message)
    },
    onProgress: (progress: { done: number; total: number }) => {
      deps.progress.push(progress)
    },
    onDiagnostics: (entries: string[]) => {
      deps.diagnostics.push(entries)
    },
    written: [],
    streams: [],
    messages: [],
    progress: [],
    picked: [],
    diagnostics: [],
    ...overrides
  }
  return deps as ExportRunnerDeps & typeof deps
}

/** Concatenated chunk bytes of one staged stream (defaults to the first). */
function streamBytes(deps: { streams: FakeStream[] }, index = 0): Uint8Array {
  const chunks = deps.streams[index].chunks
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

function drawingEditor(frames = 2): Editor {
  const document = createDocument('demo', 320, 180, 12)
  document.frames = frames
  const drawing = createDrawingLayer('paint')
  drawing.cells.push({ frame: 0, resourceId: 'res-a' })
  document.layers.push(drawing)
  return new Editor(document)
}

function options(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return {
    format: 'png-sequence',
    scale: 1,
    fps: 12,
    fromFrame: 0,
    toFrame: 1,
    transparent: true,
    gifPalette: 'perFrame',
    gifDither: false,
    gifLoop: 0,
    videoQuality: 'high',
    ...overrides
  }
}

/** First index of `needle` inside `haystack`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

describe('runExport', () => {
  it('streams a PNG sequence ZIP with one entry per frame', async () => {
    const editor = drawingEditor()
    const deps = fakeDeps()
    const result = await runExport(editor, options(), deps, { canceled: false })

    expect(result).toBe(true)
    expect(deps.picked[0].defaultName).toBe('demo.zip')
    // Streamed: no one-shot write, the staged temp is committed instead.
    expect(deps.written).toHaveLength(0)
    expect(deps.streams).toHaveLength(1)
    expect(deps.streams[0].path).toBe('/tmp/out')
    expect(deps.streams[0].committed).toBe(true)
    const entries = unzipSync(streamBytes(deps))
    expect(Object.keys(entries).sort()).toEqual(['frame_0000.png', 'frame_0001.png'])
    expect(deps.messages).toEqual(['Exported to /tmp/out'])
    expect(deps.progress).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 }
    ])
  })

  it('exports an animated GIF from the rasterized frames', async () => {
    const editor = drawingEditor()
    const deps = fakeDeps()
    const result = await runExport(editor, options({ format: 'gif' }), deps, { canceled: false })

    expect(result).toBe(true)
    const gif = deps.written[0].bytes
    expect(String.fromCharCode(...gif.slice(0, 6))).toBe('GIF89a')
    expect(deps.picked[0].defaultName).toBe('demo.gif')
  })

  it('refuses video exports when WebCodecs is unavailable', async () => {
    const editor = drawingEditor()
    const deps = fakeDeps()
    const result = await runExport(editor, options({ format: 'webm' }), deps, { canceled: false })

    expect(result).toBe(false)
    expect(deps.written).toHaveLength(0)
    expect(deps.streams).toHaveLength(0)
    expect(deps.messages[0]).toContain('WebCodecs')
  })

  it('does nothing when the user cancels the destination dialog', async () => {
    const editor = drawingEditor()
    const deps = fakeDeps({
      pickExportPath: () => Promise.resolve({ canceled: true })
    })
    const result = await runExport(editor, options(), deps, { canceled: false })

    expect(result).toBe(false)
    expect(deps.written).toHaveLength(0)
    expect(deps.streams).toHaveLength(0)
  })

  it('aborts the staged stream between frames and reports when cancellation is requested', async () => {
    const editor = drawingEditor()
    const signal = { canceled: false }
    const deps = fakeDeps()
    let firstFrame = true
    const originalLoad = deps.loadImage
    deps.loadImage = (...args) => {
      if (firstFrame) {
        firstFrame = false
        signal.canceled = true
      }
      return originalLoad(...(args as []))
    }
    const result = await runExport(editor, options(), deps, signal)

    expect(result).toBe(false)
    expect(deps.written).toHaveLength(0)
    expect(deps.streams[0].committed).toBe(false)
    expect(deps.messages).toContain('Export canceled')
  })

  it('aborts the staged stream when a chunk write fails', async () => {
    const editor = drawingEditor()
    const deps = fakeDeps({
      writeExportStream: () => Promise.resolve({ ok: false, error: 'disk full' })
    })
    const result = await runExport(editor, options(), deps, { canceled: false })

    expect(result).toBe(false)
    expect(deps.streams[0].committed).toBe(false)
    expect(deps.messages).toEqual(['Export failed: disk full'])
  })

  it('reports staged-open failures without committing anything', async () => {
    const editor = drawingEditor()
    const deps = fakeDeps({
      openExportStream: () => Promise.resolve({ ok: false, error: 'read-only filesystem' })
    })
    const result = await runExport(editor, options(), deps, { canceled: false })

    expect(result).toBe(false)
    expect(deps.streams).toHaveLength(0)
    expect(deps.messages).toEqual(['Export failed: read-only filesystem'])
  })

  it('surfaces one-shot write failures through the status bar and keeps the result false', async () => {
    const editor = drawingEditor()
    const deps = fakeDeps({
      writeExportFile: () => Promise.resolve({ ok: false, error: 'disk full' }),
      createGifEncodeClient: () => Promise.resolve(inlineGifClient())
    })
    const result = await runExport(editor, options({ format: 'gif' }), deps, { canceled: false })

    expect(result).toBe(false)
    expect(deps.messages).toEqual(['Export failed: disk full'])
  })

  it('reconciles embedded fonts before rasterizing when the dep is provided', async () => {
    const editor = drawingEditor()
    const order: string[] = []
    const deps = fakeDeps({
      reconcileFonts: () => {
        order.push('reconcile')
        return Promise.resolve()
      }
    })
    const originalLoad = deps.loadImage
    deps.loadImage = (...args) => {
      order.push('raster')
      return originalLoad(...(args as []))
    }
    const result = await runExport(editor, options(), deps, { canceled: false })

    expect(result).toBe(true)
    expect(order[0]).toBe('reconcile')
    expect(order).toContain('raster')
    expect(deps.messages).toEqual(['Exported to /tmp/out'])
  })
})

describe('runExport — audio in video exports', () => {
  beforeEach(() => {
    videoEncoder.canEncodeVideo.mockReset()
    videoEncoder.canEncodeVideo.mockReturnValue(false)
    videoEncoder.encodeVideo.mockReset()
  })

  const mixBuffer = (): AudioBuffer => ({ duration: 0.5 }) as unknown as AudioBuffer

  it('mixes the audible audio into webm exports and hands it to the encoder', async () => {
    videoEncoder.canEncodeVideo.mockReturnValue(true)
    videoEncoder.encodeVideo.mockResolvedValue({
      bytes: new Uint8Array([7, 7]),
      audioIncluded: true,
      alphaIncluded: true
    })
    const mix = mixBuffer()
    const renderAudioMix = vi.fn(() => Promise.resolve(mix))
    const deps = fakeDeps({ renderAudioMix })
    const opts = options({ format: 'webm' })

    const result = await runExport(drawingEditor(), opts, deps, { canceled: false })

    expect(result).toBe(true)
    expect(renderAudioMix).toHaveBeenCalledWith(opts)
    expect(videoEncoder.encodeVideo).toHaveBeenCalledTimes(1)
    const call = videoEncoder.encodeVideo.mock.calls[0]
    expect(call[0]).toBe(opts)
    expect(call[1]).toEqual({ width: 320, height: 180 })
    expect(call[4]).toEqual({ buffer: mix })
    expect(deps.written[0].bytes).toEqual(new Uint8Array([7, 7]))
    expect(deps.messages).toEqual(['Exported to /tmp/out'])
  })

  it('reports the dropped track when the encoder cannot include the mix', async () => {
    videoEncoder.canEncodeVideo.mockReturnValue(true)
    videoEncoder.encodeVideo.mockResolvedValue({
      bytes: new Uint8Array([7]),
      audioIncluded: false,
      alphaIncluded: true
    })
    const deps = fakeDeps({ renderAudioMix: () => Promise.resolve(mixBuffer()) })

    const result = await runExport(drawingEditor(), options({ format: 'webm' }), deps, {
      canceled: false
    })

    expect(result).toBe(true)
    expect(deps.messages).toEqual(['Exported to /tmp/out without audio (no encoder available)'])
  })

  it('never mixes audio for the silent formats', async () => {
    const renderAudioMix = vi.fn()
    const editor = drawingEditor()
    const deps = fakeDeps({ renderAudioMix })

    await runExport(editor, options(), deps, { canceled: false })
    await runExport(editor, options({ format: 'gif' }), deps, { canceled: false })

    expect(renderAudioMix).not.toHaveBeenCalled()
    expect(deps.written).toHaveLength(1)
    expect(deps.streams[0].committed).toBe(true)
  })

  it('exports the video silently when the mixdown itself fails', async () => {
    videoEncoder.canEncodeVideo.mockReturnValue(true)
    videoEncoder.encodeVideo.mockResolvedValue({
      bytes: new Uint8Array([7]),
      audioIncluded: false,
      alphaIncluded: true
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps = fakeDeps({
      renderAudioMix: () => Promise.reject(new Error('no decodable audio'))
    })

    const result = await runExport(drawingEditor(), options({ format: 'webm' }), deps, {
      canceled: false
    })

    expect(result).toBe(true)
    expect(warn).toHaveBeenCalled()
    expect(videoEncoder.encodeVideo.mock.calls[0][4]).toBeNull()
    expect(deps.messages).toEqual(['Exported to /tmp/out'])
    warn.mockRestore()
  })

  it('reports dropped transparency when the VP9 alpha encoder is unavailable', async () => {
    videoEncoder.canEncodeVideo.mockReturnValue(true)
    videoEncoder.encodeVideo.mockResolvedValue({
      bytes: new Uint8Array([7]),
      audioIncluded: true,
      alphaIncluded: false
    })
    const deps = fakeDeps()

    const result = await runExport(drawingEditor(), options({ format: 'webm', transparent: true }), deps, {
      canceled: false
    })

    expect(result).toBe(true)
    expect(deps.messages).toEqual([
      'Exported to /tmp/out without transparency (no VP9 alpha encoder in this environment)'
    ])
  })
})

describe('runExport — vector and spritesheet formats', () => {
  it('exports Lottie JSON directly, without WebCodecs or rasterization', async () => {
    const editor = drawingEditor()
    const deps = fakeDeps()
    const result = await runExport(editor, options({ format: 'lottie' }), deps, { canceled: false })

    expect(result).toBe(true)
    expect(deps.picked[0].defaultName).toBe('demo.json')
    const parsed = JSON.parse(strFromU8(deps.written[0].bytes)) as {
      v: string
      fr: number
      layers: unknown[]
    }
    expect(parsed.v).toBe('5.7.4')
    expect(parsed.fr).toBe(12)
    expect(parsed.layers.length).toBeGreaterThan(0)
    expect(deps.messages).toEqual(['Exported to /tmp/out'])
  })

  it('packs dotLottie archives with the app version in the manifest', async () => {
    const editor = drawingEditor()
    const deps = fakeDeps({ appVersion: () => Promise.resolve('9.9.9') })
    const result = await runExport(editor, options({ format: 'dotlottie' }), deps, { canceled: false })

    expect(result).toBe(true)
    expect(deps.picked[0].defaultName).toBe('demo.lottie')
    const entries = unzipSync(deps.written[0].bytes)
    const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as { generator: string }
    expect(manifest.generator).toBe('OpenAnimator 9.9.9')
    expect(entries['animations/animation.json']).toBeDefined()
  })

  it('writes the animated SVG as text', async () => {
    const editor = drawingEditor()
    const deps = fakeDeps()
    const result = await runExport(editor, options({ format: 'svg-animation' }), deps, { canceled: false })

    expect(result).toBe(true)
    expect(deps.picked[0].defaultName).toBe('demo.svg')
    const svg = new TextDecoder().decode(deps.written[0].bytes)
    expect(svg.startsWith('<svg ')).toBe(true)
    expect(deps.messages).toEqual(['Exported to /tmp/out'])
  })

  it('streams spritesheet atlases with metadata', async () => {
    const editor = drawingEditor(6)
    const deps = fakeDeps({ appVersion: () => Promise.resolve('9.9.9') })
    const result = await runExport(
      editor,
      options({ format: 'spritesheet', toFrame: 5 }),
      deps,
      { canceled: false }
    )

    expect(result).toBe(true)
    expect(deps.picked[0].defaultName).toBe('demo.zip')
    expect(deps.written).toHaveLength(0)
    expect(deps.streams[0].committed).toBe(true)
    const entries = unzipSync(streamBytes(deps))
    expect(Array.from(entries['atlas.png'].slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    const metadata = JSON.parse(strFromU8(entries['atlas.json'])) as {
      meta: { version: string }
      openanimator: { frameCount: number }
    }
    expect(metadata.meta.version).toBe('9.9.9')
    expect(metadata.openanimator.frameCount).toBe(6)
  })

  it('appends the export diagnostic count and hands the list to onDiagnostics', async () => {
    const editor = drawingEditor()
    const layer = editor.document.layers[0]
    if (layer.kind !== 'object') throw new Error('expected an object layer')
    const text: TextNode = {
      id: 't1',
      type: 'text',
      center: { x: 100, y: 90 },
      width: 60,
      height: 30,
      rotation: 0,
      opacity: 1,
      text: 'Hi',
      fontFamily: 'Missing Font',
      fontSize: 48,
      fontWeight: 400,
      fill: '#ffffff',
      align: 'left'
    }
    layer.keyframes[0].nodes.push(text)
    const deps = fakeDeps()
    const result = await runExport(editor, options({ format: 'lottie' }), deps, { canceled: false })

    expect(result).toBe(true)
    expect(deps.messages).toEqual(['Exported to /tmp/out (1 export diagnostic)'])
    expect(deps.diagnostics).toHaveLength(1)
    expect(deps.diagnostics[0]).toHaveLength(1)
    expect(deps.diagnostics[0][0]).toContain('Missing Font')
  })
})

describe('runExport — GIF options and Lottie audio resources', () => {
  it('threads the palette, dithering and loop choices into the GIF encoder', async () => {
    const captures: Array<Partial<GifEncodeOptions> | undefined> = []
    const deps = fakeDeps({
      createGifEncodeClient: (gifOptions) => {
        captures.push(gifOptions)
        const encoder = createIncrementalGifEncoder(gifOptions)
        return Promise.resolve({
          addFrame: (frame) => {
            encoder.addFrame(frame)
            return Promise.resolve()
          },
          finish: () => Promise.resolve(encoder.finish()),
          dispose: () => undefined
        })
      }
    })
    const result = await runExport(
      drawingEditor(),
      options({ format: 'gif', gifPalette: 'global', gifDither: true, gifLoop: 3 }),
      deps,
      { canceled: false }
    )

    expect(result).toBe(true)
    expect(captures).toEqual([{ palette: 'global', dither: true, loop: 3 }])
    // The loop choice lands in the NETSCAPE extension of the encoded file.
    const netscape = new Uint8Array([
      0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03,
      0x01, 0x03, 0x00
    ])
    expect(indexOfBytes(deps.written[0].bytes, netscape)).toBeGreaterThan(-1)
  })

  it('embeds audio as dotLottie side files and reports unresolvable resources', async () => {
    const editor = drawingEditor()
    editor.document.layers.push(createAudioLayer('res-song', 'song'))
    const deps = fakeDeps({
      appVersion: () => Promise.resolve('9.9.9'),
      resolveResourceBytes: () =>
        Promise.resolve({ bytes: new Uint8Array([1, 2, 3, 4]), ext: 'mp3' })
    })
    const result = await runExport(
      editor,
      options({ format: 'dotlottie' }),
      deps,
      { canceled: false }
    )

    expect(result).toBe(true)
    const entries = unzipSync(deps.written[0].bytes)
    expect(Array.from(entries['audio/aud_1.mp3'])).toEqual([1, 2, 3, 4])
    const animation = JSON.parse(strFromU8(entries['animations/animation.json'])) as {
      layers: Array<{ ty: number; refId?: string }>
      assets: Array<{ id: string; u: string; p: string; e: number }>
    }
    const audioLayer = animation.layers.find((layer) => layer.ty === 6)
    expect(audioLayer).toBeDefined()
    expect(animation.assets).toContainEqual({ id: 'aud_1', u: 'audio/', p: 'aud_1.mp3', e: 0 })
  })

  it('keeps a missing audio resource out of the Lottie JSON with a diagnostic', async () => {
    const editor = drawingEditor()
    editor.document.layers.push(createAudioLayer('res-gone', 'song'))
    const deps = fakeDeps({ resolveResourceBytes: () => Promise.resolve(null) })
    const result = await runExport(editor, options({ format: 'lottie' }), deps, { canceled: false })

    expect(result).toBe(true)
    const parsed = JSON.parse(strFromU8(deps.written[0].bytes)) as { layers: unknown[] }
    expect(parsed.layers.every((layer) => (layer as { ty: number }).ty !== 6)).toBe(true)
    expect(deps.messages).toEqual(['Exported to /tmp/out (1 export diagnostic)'])
    expect(deps.diagnostics[0][0]).toContain('res-gone')
  })
})

describe('createDefaultExportRunnerDeps', () => {
  it('wires every dependency to the window.api surface', async () => {
    const api = {
      pickExportPath: vi.fn(() => Promise.resolve({ canceled: true as const })),
      writeExportFile: vi.fn(() => Promise.resolve({ ok: true as const })),
      openExportStream: vi.fn(() => Promise.resolve({ ok: true as const, token: 't1' })),
      writeExportStream: vi.fn(() => Promise.resolve({ ok: true as const })),
      finishExportStream: vi.fn(() => Promise.resolve({ ok: true as const })),
      versions: vi.fn(() =>
        Promise.resolve({ app: '1.2.3', electron: 'e', chrome: 'c', node: 'n' })
      )
    }
    const previous = window.api
    window.api = api as unknown as typeof window.api
    // No Worker in this environment: the GIF factory falls back to the inline
    // encoder, which the wiring exercises end to end.
    vi.stubGlobal('Worker', undefined)
    try {
      const editor = drawingEditor()
      const messages: Array<{ message: string; persistent: boolean }> = []
      editor.onMessage((message, options) => messages.push({ message, persistent: options.persistent }))
      const deps = createDefaultExportRunnerDeps(editor)

      expect(await deps.pickExportPath({ defaultName: 'x.zip', filters: [] })).toEqual({
        canceled: true
      })
      expect(await deps.writeExportFile('/tmp/x', new Uint8Array([1]))).toEqual({ ok: true })
      const opened = await deps.openExportStream('/tmp/x')
      expect(opened).toEqual({ ok: true, token: 't1' })
      if (!opened.ok) throw new Error('stream did not open')
      await deps.writeExportStream(opened.token, new Uint8Array([2]))
      await deps.finishExportStream(opened.token, true)
      expect(api.writeExportStream).toHaveBeenCalledWith('t1', new Uint8Array([2]))
      expect(api.finishExportStream).toHaveBeenCalledWith('t1', true)

      deps.showMessage('hello')
      expect(messages).toEqual([{ message: 'hello', persistent: false }])

      expect(await deps.appVersion?.()).toBe('1.2.3')
      expect(await deps.resolveResourceDataUrl('missing')).toBeNull()
      expect(await deps.resolveResourceBytes?.('missing')).toBeNull()

      const client = await deps.createGifEncodeClient?.()
      if (!client) throw new Error('no GIF client')
      await client.addFrame({
        data: new Uint8ClampedArray(4),
        width: 1,
        height: 1,
        delayMs: 100
      })
      const gif = await client.finish()
      client.dispose()
      expect(String.fromCharCode(...gif.slice(0, 6))).toBe('GIF89a')
    } finally {
      vi.unstubAllGlobals()
      window.api = previous
    }
  })
})
