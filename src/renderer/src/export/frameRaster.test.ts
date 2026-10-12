// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { createDocument, createDrawingLayer } from '@shared/document'
import type { ExportOptions } from '@shared/exportOptions'

import { FrameRasterizer, createDefaultFrameRasterDeps, type FrameRasterDeps } from './frameRaster'

function fakeDeps() {
  const calls = {
    svgs: [] as string[],
    revoked: [] as string[],
    dataUrlRequests: [] as string[],
    draws: [] as Array<{ dx: number; dy: number; dw: number; dh: number }>,
    cleared: 0,
    canvases: [] as Array<{ width: number; height: number }>
  }
  const fakeContext = {
    clearRect: () => {
      calls.cleared += 1
    },
    drawImage: (_image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number) => {
      calls.draws.push({ dx, dy, dw, dh })
    }
  }
  const deps: FrameRasterDeps = {
    resolveResourceDataUrl: (resourceId: string) => {
      calls.dataUrlRequests.push(resourceId)
      return Promise.resolve(`data:image/png;base64,${resourceId}`)
    },
    createObjectUrl: (svg: string) => {
      calls.svgs.push(svg)
      return `blob:svg-${calls.svgs.length}`
    },
    revokeObjectUrl: (url: string) => {
      calls.revoked.push(url)
    },
    loadImage: () => Promise.resolve({} as CanvasImageSource),
    createCanvas: (width: number, height: number) => {
      const canvas = {
        width,
        height,
        getContext: () => fakeContext
      }
      calls.canvases.push(canvas)
      return canvas as unknown as HTMLCanvasElement
    },
    canvasToPng: () => Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    canvasToRgba: () => new Uint8ClampedArray(4)
  }
  return { deps, calls }
}

function options(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return {
    format: 'gif',
    scale: 2,
    fps: 12,
    fromFrame: 0,
    toFrame: 1,
    transparent: false,
    ...overrides
  }
}

describe('FrameRasterizer', () => {
  it('draws each frame at the export pixel size on a cleared canvas', async () => {
    const document = createDocument('demo', 320, 180, 12)
    document.frames = 2
    const { deps, calls } = fakeDeps()
    const rasterizer = new FrameRasterizer(document, options({ scale: 2 }), deps)

    const canvas = await rasterizer.rasterizeToCanvas(1)

    expect(canvas.width).toBe(640)
    expect(canvas.height).toBe(360)
    expect(calls.cleared).toBe(1)
    expect(calls.draws).toEqual([{ dx: 0, dy: 0, dw: 640, dh: 360 }])
    expect(calls.revoked).toEqual([calls.svgs.length ? 'blob:svg-1' : ''])
    expect(calls.svgs[0]).toContain('viewBox="0 0 320 180"')
  })

  it('omits the backdrop for transparent exports (alpha formats)', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const { deps, calls } = fakeDeps()
    const rasterizer = new FrameRasterizer(document, options({ transparent: true }), deps)

    await rasterizer.rasterizeToCanvas(0)

    expect(calls.svgs[0]).not.toContain(`fill="${document.background}"`)
    expect(calls.svgs[0]).toContain('viewBox="0 0 320 180"')
  })

  it('caches the data-URL resolution per resource id across frames', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const drawing = createDrawingLayer('paint')
    drawing.cells.push({ frame: 0, resourceId: 'res-a' })
    document.layers.push(drawing)
    const { deps, calls } = fakeDeps()
    const rasterizer = new FrameRasterizer(document, options(), deps)

    await rasterizer.rasterizeToCanvas(0)
    await rasterizer.rasterizeToCanvas(0)

    expect(calls.dataUrlRequests).toEqual(['res-a'])
    expect(calls.svgs[0]).toContain('href="data:image/png;base64,res-a"')
  })

  it('renders missing resources as the standard placeholder box', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const drawing = createDrawingLayer('paint')
    drawing.cells.push({ frame: 0, resourceId: 'gone' })
    document.layers.push(drawing)
    const { deps, calls } = fakeDeps()
    deps.resolveResourceDataUrl = () => Promise.resolve(null)
    const rasterizer = new FrameRasterizer(document, options(), deps)

    await rasterizer.rasterizeToCanvas(0)

    expect(calls.svgs[0]).toContain('stroke-dasharray="4 4"')
  })

  it('embeds subsets as @font-face rules and resolves the synthetic family', async () => {
    const document = createDocument('demo', 320, 180, 12)
    document.fonts = [
      {
        id: 'oa-embed-400-ab12cd34',
        family: 'Lato',
        weight: 400,
        resourceId: 'font-res',
        glyphs: ['A'],
        license: 'OFL-1.1'
      }
    ]
    const layer = document.layers[0]
    if (layer.kind !== 'object') throw new Error('expected an object layer')
    layer.keyframes[0].nodes.push({
      type: 'text',
      id: 't',
      center: { x: 100, y: 90 },
      width: 40,
      height: 30,
      rotation: 0,
      opacity: 1,
      text: 'A',
      fontFamily: 'Lato',
      fontSize: 24,
      fontWeight: 400,
      fill: '#ffffff',
      align: 'left'
    })
    const { deps, calls } = fakeDeps()
    const rasterizer = new FrameRasterizer(document, options(), deps)

    await rasterizer.rasterizeToCanvas(0)
    await rasterizer.rasterizeToCanvas(1)

    expect(calls.dataUrlRequests).toEqual(['font-res'])
    expect(calls.svgs[0]).toContain(
      "<style>@font-face{font-family:'oa-embed-400-ab12cd34';font-weight:400;" +
        "src:url(data:image/png;base64,font-res) format('truetype');}</style>"
    )
    expect(calls.svgs[0]).toContain('font-family="oa-embed-400-ab12cd34, Lato,')
    // Frames without embedded fonts stay byte-identical to the old markup.
    const plainFake = fakeDeps()
    await new FrameRasterizer(createDocument('plain', 320, 180, 12), options(), plainFake.deps).rasterizeToCanvas(0)
    expect(plainFake.calls.svgs[0]).not.toContain('@font-face')
  })

  it('marks italic subsets with font-style in the @font-face rule', async () => {
    const document = createDocument('demo', 320, 180, 12)
    document.fonts = [
      {
        id: 'oa-embed-400-ab12cd34i',
        family: 'Lato',
        weight: 400,
        italic: true,
        resourceId: 'font-italic',
        glyphs: ['A'],
        license: 'OFL-1.1'
      }
    ]
    const layer = document.layers[0]
    if (layer.kind !== 'object') throw new Error('expected an object layer')
    layer.keyframes[0].nodes.push({
      type: 'text',
      id: 't',
      center: { x: 100, y: 90 },
      width: 40,
      height: 30,
      rotation: 0,
      opacity: 1,
      text: 'A',
      fontFamily: 'Lato',
      fontSize: 24,
      fontWeight: 400,
      fontStyle: 'italic',
      fill: '#ffffff',
      align: 'left'
    })
    const { deps, calls } = fakeDeps()
    const rasterizer = new FrameRasterizer(document, options(), deps)

    await rasterizer.rasterizeToCanvas(0)

    expect(calls.svgs[0]).toContain(
      "<style>@font-face{font-family:'oa-embed-400-ab12cd34i';font-weight:400;" +
        "font-style:italic;src:url(data:image/png;base64,font-italic) format('truetype');}</style>"
    )
    expect(calls.svgs[0]).toContain('font-family="oa-embed-400-ab12cd34i, Lato,')
    expect(calls.svgs[0]).toContain('style="font-style: italic"')
  })

  it('revokes the SVG object URL even when the image fails to load', async () => {
    const document = createDocument('demo', 320, 180, 12)
    const { deps, calls } = fakeDeps()
    deps.loadImage = () => Promise.reject(new Error('decode failed'))
    const rasterizer = new FrameRasterizer(document, options(), deps)

    await expect(rasterizer.rasterizeToCanvas(0)).rejects.toThrow('decode failed')
    expect(calls.revoked).toHaveLength(1)
    expect(calls.canvases).toHaveLength(0)
  })

  it('exposes default deps built on the real DOM APIs', () => {
    const deps = createDefaultFrameRasterDeps()
    expect(typeof deps.createObjectUrl('x')).toBe('string')
    expect(typeof deps.canvasToPng).toBe('function')
    expect(typeof deps.canvasToRgba).toBe('function')
    const canvas = deps.createCanvas(10, 5)
    expect(canvas.width).toBe(10)
    expect(canvas.height).toBe(5)
  })
})
