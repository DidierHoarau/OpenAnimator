import type { DrawingLayer } from '@shared/model'
import { isDrawingLayer } from '@shared/model'
import { resolveCellAtFrame } from '@shared/document'

import type { Editor } from './editor'

/** One sampled pointer position of a stroke (stage coordinates). */
export interface StrokePoint {
  x: number
  y: number
  /** Pointer pressure 0..1; mouse pointers report a constant 0.5. */
  pressure: number
}

/** One quadratic piece of a smoothed stroke: rendered with
 * `quadraticCurveTo(control, to)` continuing from `from`. */
export interface StrokeSegment {
  from: StrokePoint
  control: StrokePoint
  to: StrokePoint
}

/**
 * Width of the stroke at a point: the brush size scaled by pointer pressure.
 * Mouse pointers report a constant 0.5 pressure, which is treated as the
 * full configured size so a mouse stroke matches the size input exactly.
 */
export function segmentWidth(point: StrokePoint, size: number): number {
  return Math.max(0.5, size * Math.min(1, point.pressure * 2))
}

function midpoint(a: StrokePoint, b: StrokePoint): StrokePoint {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    pressure: (a.pressure + b.pressure) / 2
  }
}

/**
 * Smooths a raw pointer polyline into quadratic segments drawn through the
 * segment midpoints (each raw point is the control of the curve ending at the
 * midpoint with its neighbour), which rounds off the jitter of pointer input.
 * Consecutive segments share endpoints, so they render as one continuous path.
 */
export function strokeSegments(points: StrokePoint[]): StrokeSegment[] {
  if (points.length === 0) return []
  if (points.length === 1) {
    return [{ from: points[0], control: points[0], to: points[0] }]
  }
  if (points.length === 2) {
    return [{ from: points[0], control: points[1], to: points[1] }]
  }
  const segments: StrokeSegment[] = []
  for (let i = 1; i < points.length - 1; i++) {
    const from = i === 1 ? points[0] : midpoint(points[i - 1], points[i])
    const to =
      i + 1 === points.length - 1 ? points[points.length - 1] : midpoint(points[i], points[i + 1])
    segments.push({ from, control: points[i], to })
  }
  return segments
}

/** Injectable canvas dependencies (happy-dom has no canvas 2D). */
export interface DrawingSessionDeps {
  /** Canvas of the given pixel size with a 2D context, or null. */
  createCanvas?: (width: number, height: number) => HTMLCanvasElement | null
  /** Decoded image of a cell resource for seeding the buffer. */
  loadImage?: (url: string) => Promise<CanvasImageSource & { width: number; height: number }>
  /** PNG bytes of a canvas. */
  encodePng?: (canvas: HTMLCanvasElement) => Promise<Uint8Array | null>
}

function defaultCreateCanvas(width: number, height: number): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  return canvas.getContext('2d') ? canvas : null
}

function defaultLoadImage(
  url: string
): Promise<CanvasImageSource & { width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Image decoding failed'))
    image.src = url
  })
}

function defaultEncodePng(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(null)
        return
      }
      void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)))
    }, 'image/png')
  })
}

/** PNG bytes of a fully transparent buffer of the given pixel size. */
export async function createTransparentPng(
  width: number,
  height: number,
  deps: Pick<DrawingSessionDeps, 'createCanvas' | 'encodePng'> = {}
): Promise<Uint8Array | null> {
  const canvas = (deps.createCanvas ?? defaultCreateCanvas)(width, height)
  if (!canvas) return null
  return (deps.encodePng ?? defaultEncodePng)(canvas)
}

export interface DrawingSessionOptions {
  /** Eraser strokes composite with `destination-out` instead of painting. */
  eraser: boolean
  /** Notified after every buffer repaint (the stage mirrors the buffer). */
  onPaint: () => void
}

/**
 * One pointer stroke on a drawing layer, drawn overlay-then-commit: live
 * segments render into an offscreen buffer seeded with the held cell's
 * bitmap (the stage mirrors the buffer onto an on-screen canvas), and on
 * pointer-up the buffer is encoded to PNG, stored through the content-
 * addressed resource store and committed as the cell content — one undo
 * step per stroke. Committing at a frame without a cell creates one.
 */
export class DrawingSession {
  private readonly layer: DrawingLayer
  private readonly frame: number
  private readonly points: StrokePoint[] = []
  private buffer: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null
  private seeded = false
  private seedImage: CanvasImageSource | null = null
  private readonly createCanvas: NonNullable<DrawingSessionDeps['createCanvas']>
  private readonly loadImage: NonNullable<DrawingSessionDeps['loadImage']>
  private readonly encodePng: NonNullable<DrawingSessionDeps['encodePng']>

  constructor(
    private readonly editor: Editor,
    private readonly options: DrawingSessionOptions,
    deps: DrawingSessionDeps = {}
  ) {
    const layer = editor.currentLayer
    if (!layer || !isDrawingLayer(layer)) {
      throw new Error('DrawingSession requires a drawing layer')
    }
    this.layer = layer
    this.frame = editor.currentFrame
    this.createCanvas = deps.createCanvas ?? defaultCreateCanvas
    this.loadImage = deps.loadImage ?? defaultLoadImage
    this.encodePng = deps.encodePng ?? defaultEncodePng
  }

  /**
   * Starts the stroke: prepares the buffer (stage size × resolution scale)
   * seeded with the held cell's content. Returns false when the layer cannot
   * be painted or no canvas is available; the stroke is then never committed.
   */
  async begin(point: StrokePoint): Promise<boolean> {
    const editor = this.editor
    const scale = this.layer.resolutionScale
    const canvas = this.createCanvas(
      Math.max(1, Math.round(editor.document.width * scale)),
      Math.max(1, Math.round(editor.document.height * scale))
    )
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return false
    this.buffer = { canvas, ctx }
    const resourceId = resolveCellAtFrame(this.layer, this.frame)
    const url = resourceId ? editor.resources.getUrl(resourceId) : null
    if (url) {
      this.seedImage = await this.loadImage(url).catch(() => null)
    }
    this.seeded = true
    this.points.push(this.toBufferPoint(point))
    this.repaint()
    return true
  }

  /** Extends the stroke with a new sampled pointer position. */
  extend(point: StrokePoint): void {
    if (!this.buffer) return
    this.points.push(this.toBufferPoint(point))
    if (this.seeded) this.repaint()
  }

  /**
   * Commits the buffer as the content of the stroke's frame's cell: the PNG
   * goes through the resource store (dedupe free for identical content) and
   * `Editor.commitStroke` replaces or creates the cell — one undo step.
   * Returns true when the cell changed.
   */
  async end(): Promise<boolean> {
    const buffer = this.buffer
    this.buffer = null
    if (!buffer || this.points.length === 0) return false
    const bytes = await this.encodePng(buffer.canvas)
    if (!bytes) return false
    const resourceId = await this.editor.storeCellBytes(bytes)
    if (!resourceId) return false
    return this.editor.commitStroke(resourceId, this.frame)
  }

  /** Aborts the stroke without committing anything. */
  cancel(): void {
    this.buffer = null
  }

  /** The live buffer, mirrored by the stage onto its overlay canvas. */
  get bufferCanvas(): HTMLCanvasElement | null {
    return this.buffer?.canvas ?? null
  }

  private toBufferPoint(point: StrokePoint): StrokePoint {
    const scale = this.layer.resolutionScale
    return { x: point.x * scale, y: point.y * scale, pressure: point.pressure }
  }

  private repaint(): void {
    const buffer = this.buffer
    if (!buffer) return
    const { canvas, ctx } = buffer
    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (this.seedImage) {
      ctx.drawImage(this.seedImage, 0, 0, canvas.width, canvas.height)
    }
    ctx.globalCompositeOperation = this.options.eraser ? 'destination-out' : 'source-over'
    ctx.globalAlpha = this.options.eraser ? 1 : this.editor.brushOpacity
    ctx.strokeStyle = this.editor.brushColor
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const segment of strokeSegments(this.points)) {
      ctx.beginPath()
      ctx.moveTo(segment.from.x, segment.from.y)
      ctx.quadraticCurveTo(segment.control.x, segment.control.y, segment.to.x, segment.to.y)
      ctx.lineWidth = segmentWidth(segment.to, this.editor.brushSize)
      ctx.stroke()
    }
    ctx.restore()
    this.options.onPaint()
  }
}
