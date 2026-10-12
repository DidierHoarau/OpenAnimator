// @vitest-environment happy-dom
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { createDocument, createDrawingLayer } from '@shared/document'
import type { ExportOptions } from '@shared/exportOptions'
import { Editor } from '../editor'

import { runExport, type ExportRunnerDeps } from './runExport'

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function fakeDeps(overrides: Partial<ExportRunnerDeps> = {}): ExportRunnerDeps & {
  written: Array<{ path: string; bytes: Uint8Array }>
  messages: string[]
  progress: Array<{ done: number; total: number }>
  picked: Array<{ defaultName: string; filters: unknown }>
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
    showMessage: (message: string) => {
      deps.messages.push(message)
    },
    onProgress: (progress: { done: number; total: number }) => {
      deps.progress.push(progress)
    },
    written: [],
    messages: [],
    progress: [],
    picked: [],
    ...overrides
  }
  return deps as ExportRunnerDeps & typeof deps
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
    ...overrides
  }
}

describe('runExport', () => {
  it('exports a PNG sequence ZIP with one entry per frame', async () => {
    const editor = drawingEditor()
    const deps = fakeDeps()
    const result = await runExport(editor, options(), deps, { canceled: false })

    expect(result).toBe(true)
    expect(deps.picked[0].defaultName).toBe('demo.zip')
    expect(deps.written).toHaveLength(1)
    expect(deps.written[0].path).toBe('/tmp/out')
    const entries = unzipSync(deps.written[0].bytes)
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
  })

  it('stops between frames and reports when cancellation is requested', async () => {
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
    expect(deps.messages).toContain('Export canceled')
  })

  it('surfaces write failures through the status bar and keeps the result false', async () => {
    const editor = drawingEditor()
    const deps = fakeDeps({
      writeExportFile: () => Promise.resolve({ ok: false, error: 'disk full' })
    })
    const result = await runExport(editor, options(), deps, { canceled: false })

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
