import { GIFEncoder, quantize, applyPalette, nearestColorIndex } from 'gifenc'
import type { GifPaletteEntry } from 'gifenc'
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

/** How an exported GIF picks its color palette, dithering and loop count. */
export interface GifEncodeOptions {
  /** 'perFrame' quantizes each frame; 'global' quantizes once and reuses the palette. */
  palette: 'perFrame' | 'global'
  /** Floyd–Steinberg error diffusion when mapping pixels to the palette. */
  dither: boolean
  /** NETSCAPE loop count: 0 = forever; N = repeat N times; -1 = play once (no extension). */
  loop: number
}

/** Defaults preserve the historical output: per-frame palettes, no dithering,
 * loop forever. */
export const DEFAULT_GIF_ENCODE_OPTIONS: GifEncodeOptions = {
  palette: 'perFrame',
  dither: false,
  loop: 0
}

/** Frames buffered in 'global' mode before the palette is quantized and flushed. */
const GLOBAL_PALETTE_WINDOW = 16
/** NETSCAPE loop counts are 16-bit unsigned values. */
const MAX_LOOP = 65535

/** Fills in defaults, validates the palette mode and clamps the loop count. */
export function normalizeGifOptions(partial?: Partial<GifEncodeOptions>): GifEncodeOptions {
  const loop = partial?.loop
  return {
    palette: partial?.palette === 'global' ? 'global' : DEFAULT_GIF_ENCODE_OPTIONS.palette,
    dither: Boolean(partial?.dither),
    loop: Number.isFinite(loop)
      ? Math.min(MAX_LOOP, Math.max(-1, Math.floor(loop as number)))
      : DEFAULT_GIF_ENCODE_OPTIONS.loop
  }
}

/** Frame-at-a-time GIF encoder: `addFrame` per rasterized frame, then
 * `finish()` for the bytes. The streaming worker and the CLI share it. */
export interface IncrementalGifEncoder {
  addFrame(frame: GifFrame): void
  finish(): Uint8Array
}

/**
 * Creates an incremental GIF encoder built on gifenc (pure JS). With
 * `palette: 'perFrame'` (default) each frame is quantized to its own 256-color
 * palette; `palette: 'global'` buffers the first frames and reuses a single
 * palette quantized from all of them. `dither` enables Floyd–Steinberg error
 * diffusion when mapping pixels to the palette; `loop` sets the NETSCAPE loop
 * count. Accepts `Uint8ClampedArray` (canvas ImageData) as well as `Uint8Array`.
 */
export function createIncrementalGifEncoder(
  options?: Partial<GifEncodeOptions>
): IncrementalGifEncoder {
  const resolved = normalizeGifOptions(options)
  const encoder = GIFEncoder()
  // 'global' mode buffers the first frames' RGBA copies (the caller may reuse
  // or transfer its buffers) so the palette can be quantized from all of them
  // before the first frame is written.
  const buffered: GifFrame[] = []
  let globalPalette: GifPaletteEntry[] | null = null

  const writeFrame = (frame: GifFrame, palette: GifPaletteEntry[]): void => {
    const data = toUint8Array(frame.data)
    const index = resolved.dither
      ? ditheredIndices(data, frame.width, frame.height, palette)
      : applyPalette(data, palette, 'rgba4444')
    const transparentIndex = palette.findIndex((color) => color[3] === 0)
    encoder.writeFrame(index, frame.width, frame.height, {
      palette,
      delay: frame.delayMs,
      // gifenc consumes `repeat` on the first frame only; -1 omits the
      // NETSCAPE extension (play once), 0 loops forever.
      repeat: resolved.loop,
      ...(transparentIndex >= 0 ? { transparent: true, transparentIndex } : {})
    })
  }

  /** Quantizes one palette from the buffered frames and flushes them in order. */
  const buildGlobalPalette = (): GifPaletteEntry[] => {
    let byteLength = 0
    for (const frame of buffered) byteLength += frame.data.byteLength
    const concat = new Uint8Array(byteLength)
    let offset = 0
    for (const frame of buffered) {
      concat.set(frame.data, offset)
      offset += frame.data.byteLength
    }
    const palette = quantize(concat, 256, { format: 'rgba4444', oneBitAlpha: true })
    for (const frame of buffered.splice(0)) writeFrame(frame, palette)
    return palette
  }

  return {
    addFrame(frame: GifFrame): void {
      if (resolved.palette === 'global') {
        if (!globalPalette) {
          if (buffered.length < GLOBAL_PALETTE_WINDOW) {
            buffered.push({
              data: toUint8Array(frame.data).slice(),
              width: frame.width,
              height: frame.height,
              delayMs: frame.delayMs
            })
            return
          }
          globalPalette = buildGlobalPalette()
        }
        writeFrame(frame, globalPalette)
        return
      }
      const palette = quantize(toUint8Array(frame.data), 256, { format: 'rgba4444', oneBitAlpha: true })
      writeFrame(frame, palette)
    },
    finish(): Uint8Array {
      if (resolved.palette === 'global' && !globalPalette && buffered.length > 0) {
        globalPalette = buildGlobalPalette()
      }
      encoder.finish()
      return encoder.bytes()
    }
  }
}

/**
 * Maps RGBA pixels to palette indices with classic Floyd–Steinberg error
 * diffusion (7/16 right, 3/16 bottom-left, 5/16 bottom, 1/16 bottom-right).
 * Fully transparent pixels map to the transparent palette entry and neither
 * receive nor emit diffused error.
 */
function ditheredIndices(
  data: Uint8Array,
  width: number,
  height: number,
  palette: GifPaletteEntry[]
): Uint8Array {
  const out = new Uint8Array(width * height)
  const transparentIndex = palette.findIndex((color) => color[3] === 0)
  // Nearest-palette lookups memoized on the pixel's (r, g, b).
  const memo = new Map<number, number>()
  const nearest = (r: number, g: number, b: number): number => {
    const key = (r << 16) | (g << 8) | b
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    const index = nearestColorIndex(palette, [r, g, b])
    memo.set(key, index)
    return index
  }
  const diffuse = (
    row: Float32Array,
    slot: number,
    pixel: number,
    er: number,
    eg: number,
    eb: number,
    factor: number
  ): void => {
    if (data[pixel * 4 + 3] === 0) return
    row[slot] += er * factor
    row[slot + 1] += eg * factor
    row[slot + 2] += eb * factor
  }
  let current = new Float32Array(width * 3)
  let next = new Float32Array(width * 3)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x
      const offset = pixel * 4
      if (data[offset + 3] === 0) {
        out[pixel] =
          transparentIndex >= 0
            ? transparentIndex
            : nearest(data[offset], data[offset + 1], data[offset + 2])
        continue
      }
      const slot = x * 3
      const r = clampByte(data[offset] + current[slot])
      const g = clampByte(data[offset + 1] + current[slot + 1])
      const b = clampByte(data[offset + 2] + current[slot + 2])
      const index = nearest(r, g, b)
      out[pixel] = index
      const entry = palette[index]
      const er = r - entry[0]
      const eg = g - entry[1]
      const eb = b - entry[2]
      if (x + 1 < width) diffuse(current, slot + 3, pixel + 1, er, eg, eb, 7 / 16)
      if (y + 1 < height) {
        if (x > 0) diffuse(next, slot - 3, pixel + width - 1, er, eg, eb, 3 / 16)
        diffuse(next, slot, pixel + width, er, eg, eb, 5 / 16)
        if (x + 1 < width) diffuse(next, slot + 3, pixel + width + 1, er, eg, eb, 1 / 16)
      }
    }
    const swap = current
    current = next
    next = swap
    next.fill(0)
  }
  return out
}

function clampByte(value: number): number {
  const rounded = Math.round(value)
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded
}

/**
 * Encodes RGBA frames into an animated GIF with gifenc (pure JS). Thin
 * wrapper over the incremental encoder for callers that already hold every
 * frame (the CLI).
 */
export function encodeGif(frames: GifFrame[], options?: Partial<GifEncodeOptions>): Uint8Array {
  if (frames.length === 0) throw new Error('GIF export needs at least one frame')
  const encoder = createIncrementalGifEncoder(options)
  for (const frame of frames) encoder.addFrame(frame)
  return encoder.finish()
}

/** Delay in whole milliseconds between frames at the export fps. */
export function gifDelayMs(options: Pick<ExportOptions, 'fps'>): number {
  return Math.max(1, Math.round(1000 / options.fps))
}

function toUint8Array(data: Uint8Array | Uint8ClampedArray): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
