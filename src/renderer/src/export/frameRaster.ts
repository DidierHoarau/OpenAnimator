import { documentToSvgString } from '@shared/exportSvg'
import { embeddedFamilyResolverFor } from '@shared/fontPolicy'
import type { AnimatorDocument } from '@shared/model'
import type { ExportOptions } from '@shared/exportOptions'

/**
 * Browser rasterization of document frames: the shared SVG source is loaded
 * as an image and drawn onto a canvas at the export resolution. Resource ids
 * resolve to data: URLs — inside an SVG loaded through `<img>`, external and
 * blob: references are blocked by the browser, while data: URLs render (and
 * keep the canvas untainted). All DOM effects are injectable for tests.
 */
export interface FrameRasterDeps {
  /** Resolves a resource id to a data URL, or null when unavailable. */
  resolveResourceDataUrl(resourceId: string): Promise<string | null>
  /** Creates an object URL for SVG source text. */
  createObjectUrl(svg: string): string
  revokeObjectUrl(url: string): void
  /** Loads an image URL and resolves with a drawable, decoded source. */
  loadImage(url: string): Promise<CanvasImageSource>
  createCanvas(width: number, height: number): HTMLCanvasElement
  canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array>
  canvasToRgba(canvas: HTMLCanvasElement): Uint8ClampedArray
}

function defaultCreateCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function loadImageElement(url: string): Promise<CanvasImageSource> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not render the frame'))
    image.src = url
  })
}

export function createDefaultFrameRasterDeps(): FrameRasterDeps {
  return {
    resolveResourceDataUrl: () => Promise.resolve(null),
    createObjectUrl: (svg) => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    loadImage: loadImageElement,
    createCanvas: defaultCreateCanvas,
    canvasToPng: (canvas) =>
      new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('Could not encode the frame as PNG'))
            return
          }
          void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)))
        }, 'image/png')
      }),
    canvasToRgba: (canvas) => {
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas 2D context unavailable')
      return context.getImageData(0, 0, canvas.width, canvas.height).data
    }
  }
}

export class FrameRasterizer {
  private readonly dataUrls = new Map<string, string | null>()
  private embeddedFontCache: string | undefined

  constructor(
    private readonly document: AnimatorDocument,
    private readonly options: ExportOptions,
    private readonly deps: FrameRasterDeps
  ) {}

  /**
   * Renders one frame onto a fresh canvas of the export pixel size. Each
   * frame gets its own canvas; video encoding captures the canvas state at
   * `add()` time, PNG/GIF read the pixels immediately after.
   */
  async rasterizeToCanvas(frame: number): Promise<HTMLCanvasElement> {
    const ids = this.collectResourceIds()
    for (const id of ids) {
      if (!this.dataUrls.has(id)) this.dataUrls.set(id, await this.deps.resolveResourceDataUrl(id))
    }
    const svg = documentToSvgString(
      this.document,
      frame,
      (resourceId) => this.dataUrls.get(resourceId) ?? null,
      {
        embeddedFontStyle: this.embeddedFontStyle(),
        resolveEmbeddedFont: embeddedFamilyResolverFor(this.document.fonts)
      }
    )
    const url = this.deps.createObjectUrl(svg)
    try {
      const image = await this.deps.loadImage(url)
      const canvas = this.deps.createCanvas(
        Math.round(this.document.width * this.options.scale),
        Math.round(this.document.height * this.options.scale)
      )
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas 2D context unavailable')
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      return canvas
    } finally {
      this.deps.revokeObjectUrl(url)
    }
  }

  canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
    return this.deps.canvasToPng(canvas)
  }

  canvasToRgba(canvas: HTMLCanvasElement): Uint8ClampedArray {
    return this.deps.canvasToRgba(canvas)
  }

  /**
   * `@font-face` rules over the embedded subsets' data URLs — inside an SVG
   * loaded through `<img>` this is the only way the synthetic families
   * resolve; empty (undefined) for documents without embedded fonts so their
   * markup stays unchanged.
   */
  private embeddedFontStyle(): string | undefined {
    if (this.document.fonts.length === 0) return undefined
    this.embeddedFontCache ??= this.document.fonts
      .map((font) => {
        const url = this.dataUrls.get(font.resourceId)
        return url
          ? `@font-face{font-family:'${font.id}';font-weight:${font.weight};src:url(${url}) format('truetype');}`
          : ''
      })
      .join('')
    return this.embeddedFontCache || undefined
  }

  /** Every resource id the document can render, warmed once per export. */
  private collectResourceIds(): Set<string> {
    const ids = new Set<string>()
    for (const layer of this.document.layers) {
      if (layer.kind !== 'drawing') continue
      for (const cell of layer.cells) if (cell.resourceId) ids.add(cell.resourceId)
    }
    for (const asset of this.document.assets) {
      if (asset.resourceId) ids.add(asset.resourceId)
    }
    for (const font of this.document.fonts) ids.add(font.resourceId)
    return ids
  }
}
