// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { createDocument } from '@shared/document'

import { Editor } from './editor'
import { sampleStagePixel } from './eyedropper'
import type { FrameRasterDeps } from './export/frameRaster'

/** 4×3 document; pixel (1, 2) holds rgb(10, 20, 30). */
function pixelBuffer(): number[] {
  const rgba = new Array<number>(4 * 3 * 4).fill(0)
  const index = (2 * 4 + 1) * 4
  rgba[index] = 10
  rgba[index + 1] = 20
  rgba[index + 2] = 30
  rgba[index + 3] = 255
  return rgba
}

function fakeDeps(rgba: number[], svgs?: string[]): FrameRasterDeps {
  return {
    resolveResourceDataUrl: () => Promise.resolve(null),
    createObjectUrl: (svg: string) => {
      svgs?.push(svg)
      return 'blob:pick'
    },
    revokeObjectUrl: () => undefined,
    loadImage: () => Promise.resolve({} as CanvasImageSource),
    createCanvas: (width, height) =>
      ({
        width,
        height,
        getContext: () => ({ clearRect: () => undefined, drawImage: () => undefined })
      }) as unknown as HTMLCanvasElement,
    canvasToPng: () => Promise.resolve(new Uint8Array()),
    canvasToRgba: () => Uint8ClampedArray.from(rgba)
  }
}

function editor(): Editor {
  return new Editor(createDocument('demo', 4, 3, 12))
}

describe('sampleStagePixel', () => {
  it('samples the pixel under the point as #rrggbb', async () => {
    await expect(
      sampleStagePixel(editor(), { x: 1.4, y: 2.9 }, fakeDeps(pixelBuffer()))
    ).resolves.toBe('#0a141e')
  })

  it('rasterizes the evaluated frame opaque at scale 1', async () => {
    const svgs: string[] = []
    const document = createDocument('demo', 4, 3, 12)
    await sampleStagePixel(new Editor(document), { x: 0, y: 0 }, fakeDeps(pixelBuffer(), svgs))
    expect(svgs[0]).toContain('viewBox="0 0 4 3"')
    expect(svgs[0]).toContain(`fill="${document.background}"`)
  })

  it('returns null for points outside the document', async () => {
    const subject = editor()
    const deps = fakeDeps(pixelBuffer())
    await expect(sampleStagePixel(subject, { x: -0.1, y: 0 }, deps)).resolves.toBeNull()
    await expect(sampleStagePixel(subject, { x: 4, y: 0 }, deps)).resolves.toBeNull()
    await expect(sampleStagePixel(subject, { x: 0, y: 3 }, deps)).resolves.toBeNull()
  })
})
