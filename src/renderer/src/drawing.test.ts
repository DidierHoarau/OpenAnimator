import { describe, expect, it } from 'vitest'

import { createDocument, createDrawingLayer, getLayer } from '@shared/document'
import type { AnimatorDocument, DrawingLayer } from '@shared/model'

import { Editor } from './editor'
import { DrawingSession, createTransparentPng, segmentWidth, strokeSegments } from './drawing'
import type { StrokePoint } from './drawing'

function point(x: number, y: number, pressure = 0.5): StrokePoint {
  return { x, y, pressure }
}

interface RecordedOp {
  op: string
  args: unknown[]
}

function recordingContext(): {
  ctx: CanvasRenderingContext2D
  ops: RecordedOp[]
} {
  const ops: RecordedOp[] = []
  const record = (op: string) => (...args: unknown[]) => {
    ops.push({ op, args })
  }
  const ctx = {
    canvas: null,
    save: record('save'),
    restore: record('restore'),
    clearRect: record('clearRect'),
    drawImage: record('drawImage'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    quadraticCurveTo: record('quadraticCurveTo'),
    stroke: record('stroke'),
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    strokeStyle: '',
    lineCap: 'butt',
    lineJoin: 'miter',
    lineWidth: 1
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops }
}

interface CanvasStub {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  ops: RecordedOp[]
}

function stubCanvasFactory(): {
  createCanvas: (width: number, height: number) => HTMLCanvasElement | null
  canvases: CanvasStub[]
} {
  const canvases: CanvasStub[] = []
  return {
    canvases,
    createCanvas: (width, height) => {
      const { ctx, ops } = recordingContext()
      const canvas = {
        width,
        height,
        getContext: () => ctx
      } as unknown as HTMLCanvasElement
      ctx.canvas = canvas
      canvases.push({ canvas, ctx, ops })
      return canvas
    }
  }
}

function drawingDocument(scale = 1): { doc: AnimatorDocument; layer: DrawingLayer } {
  const doc = createDocument('test', 100, 50, 24)
  const layer = createDrawingLayer('Draw', scale)
  doc.layers.unshift(layer)
  return { doc, layer }
}

function drawingEditor(scale = 1, storeResource?: (bytes: Uint8Array) => Promise<string | null>): {
  editor: Editor
  layer: DrawingLayer
} {
  const { doc, layer } = drawingDocument(scale)
  const editor = new Editor(doc, storeResource ? { storeResource } : {})
  editor.currentLayerId = layer.id
  return { editor, layer }
}

/** Stand-in PNG encoder for sessions whose stub canvas has no toBlob. */
const stubEncodePng = async (): Promise<Uint8Array> => new Uint8Array([1, 2, 3])

describe('segmentWidth', () => {
  it('treats the mouse constant 0.5 pressure as the full brush size', () => {
    expect(segmentWidth(point(0, 0, 0.5), 6)).toBe(6)
  })

  it('scales the brush size with pen pressure', () => {
    expect(segmentWidth(point(0, 0, 1), 6)).toBe(6)
    expect(segmentWidth(point(0, 0, 0.25), 10)).toBe(5)
  })

  it('never produces a sub-half-pixel width', () => {
    expect(segmentWidth(point(0, 0, 0), 10)).toBe(0.5)
  })
})

describe('strokeSegments', () => {
  it('returns no segments for an empty stroke', () => {
    expect(strokeSegments([])).toEqual([])
  })

  it('renders a single point as a dot', () => {
    const segments = strokeSegments([point(3, 4)])
    expect(segments).toHaveLength(1)
    expect(segments[0].from).toEqual(point(3, 4))
    expect(segments[0].control).toEqual(point(3, 4))
    expect(segments[0].to).toEqual(point(3, 4))
  })

  it('renders two points as one straight segment', () => {
    const segments = strokeSegments([point(0, 0), point(10, 10)])
    expect(segments).toHaveLength(1)
    expect(segments[0].from).toEqual(point(0, 0))
    expect(segments[0].control).toEqual(point(10, 10))
    expect(segments[0].to).toEqual(point(10, 10))
  })

  it('smooths longer strokes through midpoints with shared endpoints', () => {
    const points = [point(0, 0), point(2, 0), point(4, 2), point(6, 2)]
    const segments = strokeSegments(points)
    expect(segments).toHaveLength(2)
    // The first segment starts at the raw first point...
    expect(segments[0].from).toEqual(points[0])
    expect(segments[0].control).toEqual(points[1])
    // ...and ends at the midpoint of its two raw neighbours.
    expect(segments[0].to).toEqual(point(3, 1))
    // Consecutive segments share endpoints, so the path is continuous.
    expect(segments[1].from).toEqual(segments[0].to)
    expect(segments[1].control).toEqual(points[2])
    // The last segment ends at the raw last point.
    expect(segments[1].to).toEqual(points[3])
  })
})

describe('createTransparentPng', () => {
  it('returns null when no canvas is available', async () => {
    expect(await createTransparentPng(10, 10, { createCanvas: () => null })).toBeNull()
  })

  it('asks the encoder for the canvas bytes', async () => {
    const { createCanvas, canvases } = stubCanvasFactory()
    const encoded = new Uint8Array([1, 2, 3])
    const bytes = await createTransparentPng(8, 4, {
      createCanvas,
      encodePng: async (canvas) => {
        expect(canvas.width).toBe(8)
        expect(canvas.height).toBe(4)
        return encoded
      }
    })
    expect(bytes).toEqual(encoded)
    expect(canvases).toHaveLength(1)
  })
})

describe('DrawingSession', () => {
  it('requires a drawing layer', () => {
    const editor = new Editor(createDocument('test', 100, 50, 24))
    expect(
      () => new DrawingSession(editor, { eraser: false, onPaint: () => undefined })
    ).toThrow('DrawingSession requires a drawing layer')
  })

  it('returns false when no canvas can be created', async () => {
    const { editor } = drawingEditor()
    const session = new DrawingSession(editor, { eraser: false, onPaint: () => undefined }, {
      createCanvas: () => null
    })
    expect(await session.begin(point(1, 1))).toBe(false)
    expect(await session.end()).toBe(false)
  })

  it('sizes the buffer at the stage size times the resolution scale', async () => {
    const { editor } = drawingEditor(2)
    const { createCanvas, canvases } = stubCanvasFactory()
    const session = new DrawingSession(editor, { eraser: false, onPaint: () => undefined }, {
      createCanvas
    })
    expect(await session.begin(point(1, 1))).toBe(true)
    expect(canvases[0].canvas.width).toBe(200)
    expect(canvases[0].canvas.height).toBe(100)
  })

  it('paints brush segments into the buffer and commits one cell on end', async () => {
    const stored: Uint8Array[] = []
    const { editor, layer } = drawingEditor(1, async (bytes) => {
      stored.push(bytes)
      return 'res-1'
    })
    const { createCanvas, canvases } = stubCanvasFactory()
    let paints = 0
    const session = new DrawingSession(editor, { eraser: false, onPaint: () => (paints += 1) }, {
      createCanvas,
      encodePng: stubEncodePng
    })
    editor.brushColor = '#123456'
    editor.brushOpacity = 0.5
    expect(await session.begin(point(0, 0))).toBe(true)
    session.extend(point(50, 25))
    session.extend(point(100, 50))

    const buffer = canvases[0]
    const strokes = buffer.ops.filter((entry) => entry.op === 'stroke')
    expect(strokes.length).toBeGreaterThan(0)
    expect(buffer.ctx.strokeStyle).toBe('#123456')
    expect(buffer.ctx.globalAlpha).toBe(0.5)
    expect(buffer.ctx.globalCompositeOperation).toBe('source-over')
    expect(paints).toBeGreaterThan(0)
    expect(session.bufferCanvas).toBe(canvases[0].canvas)

    expect(await session.end()).toBe(true)
    expect(stored).toHaveLength(1)
    expect(layer.cells).toEqual([{ frame: 0, resourceId: 'res-1' }])
    // The buffer is released after the commit.
    expect(session.bufferCanvas).toBeNull()
    // Storing goes through the editor, which also caches the bytes.
    expect(editor.resources.getUrl('res-1')).not.toBeNull()
  })

  it('keeps the eraser compositing with destination-out', async () => {
    const { editor } = drawingEditor()
    const { createCanvas, canvases } = stubCanvasFactory()
    const session = new DrawingSession(editor, { eraser: true, onPaint: () => undefined }, {
      createCanvas
    })
    await session.begin(point(0, 0))
    session.extend(point(10, 10))
    expect(canvases[0].ctx.globalCompositeOperation).toBe('destination-out')
    expect(canvases[0].ctx.globalAlpha).toBe(1)
  })

  it('seeds the buffer with the held cell bitmap before painting', async () => {
    const { editor, layer } = drawingEditor()
    layer.cells.push({ frame: 0, resourceId: 'seed' })
    editor.resources.put('seed', new Uint8Array([1, 2, 3]))

    const { createCanvas, canvases } = stubCanvasFactory()
    const loadedUrls: string[] = []
    const session = new DrawingSession(editor, { eraser: false, onPaint: () => undefined }, {
      createCanvas,
      loadImage: async (url) => {
        loadedUrls.push(url)
        return { width: 10, height: 10 } as unknown as CanvasImageSource & {
          width: number
          height: number
        }
      }
    })
    await session.begin(point(5, 5))
    expect(loadedUrls).toEqual([editor.resources.getUrl('seed')])
    const draws = canvases[0].ops.filter((entry) => entry.op === 'drawImage')
    expect(draws).toHaveLength(1)
  })

  it('aborts cleanly on cancel: nothing is committed', async () => {
    const { editor, layer } = drawingEditor(1, async () => 'res-1')
    const { createCanvas } = stubCanvasFactory()
    const session = new DrawingSession(editor, { eraser: false, onPaint: () => undefined }, {
      createCanvas
    })
    await session.begin(point(0, 0))
    session.cancel()
    expect(await session.end()).toBe(false)
    expect(layer.cells).toHaveLength(0)
  })

  it('returns false when the encoder or the store fails', async () => {
    const { editor, layer } = drawingEditor(1, async () => null)
    const { createCanvas } = stubCanvasFactory()

    const noBytes = new DrawingSession(editor, { eraser: false, onPaint: () => undefined }, {
      createCanvas,
      encodePng: async () => null
    })
    await noBytes.begin(point(0, 0))
    expect(await noBytes.end()).toBe(false)

    const noStore = new DrawingSession(editor, { eraser: false, onPaint: () => undefined }, {
      createCanvas,
      encodePng: stubEncodePng
    })
    await noStore.begin(point(0, 0))
    expect(await noStore.end()).toBe(false)
    expect(layer.cells).toHaveLength(0)
  })

  it('commits the stroke at the frame the stroke started on', async () => {
    const { editor, layer } = drawingEditor(1, async () => 'res-2')
    const { createCanvas } = stubCanvasFactory()
    const session = new DrawingSession(editor, { eraser: false, onPaint: () => undefined }, {
      createCanvas,
      encodePng: stubEncodePng
    })
    await session.begin(point(0, 0))
    editor.setFrame(5)
    await session.end()
    expect(layer.cells.map((cell) => cell.frame)).toEqual([0])
    expect(getLayer(editor.document, layer.id)).toBeDefined()
  })
})
