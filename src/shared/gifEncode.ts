import { GIFEncoder, quantize, applyPalette } from 'gifenc'
import type { ExportOptions } from './exportOptions'

/** One rasterized frame as raw RGBA pixels (row-major, 4 bytes per pixel). */
export interface RgbaFrame {
  data: Uint8Array | Uint8ClampedArray
  width: number
  height: number
}

export interface GifFrame extends RgbaFrame {
  /** Frame duration in milliseconds. */
  delayMs: number
}

/**
 * Encodes RGBA frames into an animated GIF with gifenc (pure JS). Each frame
 * is quantized to its own 256-color palette; when a frame carries transparent
 * pixels (alpha 0), 1-bit transparency is enabled for it. Accepts
 * `Uint8ClampedArray` (canvas ImageData) as well as `Uint8Array`.
 */
export function encodeGif(frames: GifFrame[]): Uint8Array {
  if (frames.length === 0) throw new Error('GIF export needs at least one frame')
  const encoder = GIFEncoder()
  for (const frame of frames) {
    const data = toUint8Array(frame.data)
    const palette = quantize(data, 256, { format: 'rgba4444', oneBitAlpha: true })
    const index = applyPalette(data, palette, 'rgba4444')
    const transparentIndex = palette.findIndex((color) => color[3] === 0)
    encoder.writeFrame(index, frame.width, frame.height, {
      palette,
      delay: frame.delayMs,
      ...(transparentIndex >= 0 ? { transparent: true, transparentIndex } : {})
    })
  }
  encoder.finish()
  return encoder.bytes()
}

/** Delay in whole milliseconds between frames at the export fps. */
export function gifDelayMs(options: Pick<ExportOptions, 'fps'>): number {
  return Math.max(1, Math.round(1000 / options.fps))
}

function toUint8Array(data: Uint8Array | Uint8ClampedArray): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
