import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  getFirstEncodableVideoCodec
} from 'mediabunny'
import type { ExportOptions } from '@shared/exportOptions'

/**
 * Video export through WebCodecs (via mediabunny): frames are drawn onto one
 * canvas and encoded as VP9/WebM (preferred, patent-free) or H.264/MP4. The
 * `drawFrame` callback draws frame `index` onto the canvas and awaits back-
 * pressure, which keeps memory flat for long timelines.
 */

export type VideoFrameDrawer = (canvas: HTMLCanvasElement, frame: number) => Promise<void> | void

/** True when the environment can encode video (WebCodecs available). */
export function canEncodeVideo(): boolean {
  return typeof VideoEncoder !== 'undefined'
}

/** Preferred codecs per container, first encodable wins. */
const CODEC_CANDIDATES = {
  webm: ['vp9', 'vp8'],
  mp4: ['avc']
} as const

async function codecFor(format: 'webm' | 'mp4', width: number, height: number): Promise<string> {
  const codec = await getFirstEncodableVideoCodec([...CODEC_CANDIDATES[format]], {
    width,
    height
  })
  if (!codec) {
    throw new Error(`No supported ${format.toUpperCase()} video encoder in this environment`)
  }
  return codec
}

/**
 * Renders and encodes the export frame range into a video file. `drawFrame`
 * is called once per frame with a reusable canvas; the caller (export runner)
 * rasterizes through the shared FrameRasterizer.
 */
export async function encodeVideo(
  options: ExportOptions,
  pixelSize: { width: number; height: number },
  drawFrame: VideoFrameDrawer,
  signal: { canceled: boolean }
): Promise<Uint8Array> {
  const { width, height } = pixelSize
  const container = options.format === 'mp4' ? 'mp4' : 'webm'
  const codec = await codecFor(container, width, height)

  const output = new Output({
    format: container === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: new BufferTarget()
  })
  const canvas = globalThis.document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const source = new CanvasSource(canvas, { codec: codec as 'vp9', quality: QUALITY_HIGH })
  output.addVideoTrack(source, { frameRate: options.fps })
  await output.start()

  const frameCount = options.toFrame - options.fromFrame + 1
  const secondsPerFrame = 1 / options.fps
  try {
    for (let index = 0; index < frameCount; index++) {
      if (signal.canceled) throw new CanceledError()
      const canvas2d = canvas.getContext('2d')
      canvas2d?.clearRect(0, 0, width, height)
      await drawFrame(canvas, options.fromFrame + index)
      await source.add(index * secondsPerFrame, secondsPerFrame)
    }
    await output.finalize()
  } catch (error) {
    await output.cancel().catch(() => {})
    throw error
  }
  const buffer = output.target.buffer
  if (!buffer) throw new Error('Video encoding produced no data')
  return new Uint8Array(buffer)
}

/** Thrown when the user cancels a running export. */
export class CanceledError extends Error {
  constructor() {
    super('Export canceled')
    this.name = 'CanceledError'
  }
}

