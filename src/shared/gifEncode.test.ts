import { describe, expect, it } from 'vitest'

import {
  DEFAULT_GIF_ENCODE_OPTIONS,
  createIncrementalGifEncoder,
  encodeGif,
  gifDelayMs,
  normalizeGifOptions
} from './gifEncode'

function solidFrame(value: number, alpha = 255, size = 4): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = value
    data[i * 4 + 1] = 0
    data[i * 4 + 2] = 255 - value
    data[i * 4 + 3] = alpha
  }
  return { data, width: size, height: size }
}

/** Index of the first Graphic Control Extension (21 F9 04 …) in the stream. */
function findGce(gif: Uint8Array): number {
  for (let i = 0; i < gif.length - 3; i++) {
    if (gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 0x04) return i
  }
  return -1
}

const NETSCAPE = 'NETSCAPE2.0'

function netscapeMatchesAt(gif: Uint8Array, start: number): boolean {
  for (let j = 0; j < NETSCAPE.length; j++) {
    if (gif[start + j] !== NETSCAPE.charCodeAt(j)) return false
  }
  return true
}

/** Index of the NETSCAPE2.0 application extension payload, or -1. */
function findNetscape(gif: Uint8Array): number {
  for (let i = 0; i <= gif.length - NETSCAPE.length; i++) {
    if (netscapeMatchesAt(gif, i)) return i
  }
  return -1
}

/** Loop count stored in the NETSCAPE extension ('N' index + 13, little-endian). */
function loopCount(gif: Uint8Array, netscapeIndex: number): number {
  return gif[netscapeIndex + 13] | (gif[netscapeIndex + 14] << 8)
}

function countNetscape(gif: Uint8Array): number {
  let count = 0
  for (let i = 0; i <= gif.length - NETSCAPE.length; i++) {
    if (netscapeMatchesAt(gif, i)) {
      count += 1
      i += NETSCAPE.length - 1
    }
  }
  return count
}

/** A 32x32 RGB diagonal gradient with more distinct colors than the palette. */
function gradientFrame(size = 32): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4
      data[offset] = x * 8
      data[offset + 1] = y * 8
      data[offset + 2] = (x * 8 + y * 8) / 2
      data[offset + 3] = 255
    }
  }
  return { data, width: size, height: size }
}

describe('encodeGif', () => {
  it('produces a GIF89a stream with one graphic block per frame and a trailer', () => {
    const gif = encodeGif([
      { ...solidFrame(10), delayMs: 100 },
      { ...solidFrame(200), delayMs: 100 }
    ])
    const header = String.fromCharCode(...gif.slice(0, 6))
    expect(header).toBe('GIF89a')
    expect(gif[gif.length - 1]).toBe(0x3b)
    let blocks = 0
    for (let i = 0; i < gif.length - 1; i++) {
      if (gif[i] === 0x21 && gif[i + 1] === 0xf9) blocks += 1
    }
    expect(blocks).toBe(2)
  })

  it('encodes the requested per-frame delay', () => {
    const gif = encodeGif([{ ...solidFrame(10), delayMs: 125 }])
    const gce = findGce(gif)
    expect(gce).toBeGreaterThan(0)
    // GCE: 21 F9 04 <flags> <delay lo> <delay hi> <transparent index> <00>.
    // GIF delays are stored in centiseconds: 125 ms → 13 cs (rounded up).
    const delay = gif[gce + 4] | (gif[gce + 5] << 8)
    expect(delay).toBe(13)
  })

  it('marks transparency when a frame carries alpha-0 pixels', () => {
    const gif = encodeGif([{ ...solidFrame(10, 0), delayMs: 100 }])
    const gce = findGce(gif)
    expect(gce).toBeGreaterThan(0)
    // Flags byte: bit 0 set means the transparent color index is used.
    expect((gif[gce + 3] & 0b1) === 1).toBe(true)
  })

  it('leaves fully opaque frames without the transparency flag', () => {
    const gif = encodeGif([{ ...solidFrame(10, 255), delayMs: 100 }])
    const gce = findGce(gif)
    expect(gce).toBeGreaterThan(0)
    expect((gif[gce + 3] & 0b1) === 0).toBe(true)
  })

  it('rejects an empty frame list', () => {
    expect(() => encodeGif([])).toThrow()
  })

  it('derives the delay from the export fps', () => {
    expect(gifDelayMs({ fps: 12 })).toBe(83)
    expect(gifDelayMs({ fps: 50 })).toBe(20)
  })
})

describe('createIncrementalGifEncoder', () => {
  it('produces the exact same bytes as the batch encoder', () => {
    const frames = [
      { ...solidFrame(10, 0), delayMs: 83 },
      { ...solidFrame(120), delayMs: 83 },
      { ...solidFrame(240, 128), delayMs: 83 }
    ]
    expect(encodeGif(frames)).toEqual(
      (() => {
        const encoder = createIncrementalGifEncoder()
        for (const frame of frames) encoder.addFrame(frame)
        return encoder.finish()
      })()
    )
  })

  it('preserves transparency flags and delays frame by frame', () => {
    const encoder = createIncrementalGifEncoder()
    encoder.addFrame({ ...solidFrame(10, 0), delayMs: 100 })
    const gif = encoder.finish()

    const gce = findGce(gif)
    expect(gce).toBeGreaterThan(0)
    expect((gif[gce + 3] & 0b1) === 1).toBe(true)
    expect(gif[gce + 4] | (gif[gce + 5] << 8)).toBe(10)
  })
})

describe('normalizeGifOptions', () => {
  it('falls back to the defaults for missing options', () => {
    expect(normalizeGifOptions()).toEqual(DEFAULT_GIF_ENCODE_OPTIONS)
    expect(normalizeGifOptions({})).toEqual(DEFAULT_GIF_ENCODE_OPTIONS)
  })

  it('clamps the loop count into [-1, 65535] via floor', () => {
    expect(normalizeGifOptions({ loop: -5 }).loop).toBe(-1)
    expect(normalizeGifOptions({ loop: 3.7 }).loop).toBe(3)
    expect(normalizeGifOptions({ loop: 70000 }).loop).toBe(65535)
    expect(normalizeGifOptions({ loop: -0.5 }).loop).toBe(-1)
    expect(normalizeGifOptions({ loop: 65535 }).loop).toBe(65535)
  })

  it('falls back to loop 0 for bogus loop values', () => {
    expect(normalizeGifOptions({ loop: Number.NaN }).loop).toBe(0)
    expect(normalizeGifOptions({ loop: Infinity }).loop).toBe(0)
    expect(normalizeGifOptions({ loop: '2' as unknown as number }).loop).toBe(0)
  })

  it('validates the palette mode and coerces dither to boolean', () => {
    expect(normalizeGifOptions({ palette: 'global' }).palette).toBe('global')
    expect(normalizeGifOptions({ palette: 'bogus' as 'global' }).palette).toBe('perFrame')
    expect(normalizeGifOptions({ dither: true }).dither).toBe(true)
    expect(normalizeGifOptions({ dither: 0 as unknown as boolean }).dither).toBe(false)
    expect(normalizeGifOptions({ dither: 'yes' as unknown as boolean }).dither).toBe(true)
  })
})

describe('gif encoding options', () => {
  it('keeps default options byte-identical to the plain encoder', () => {
    const frames = [
      { ...solidFrame(10, 0), delayMs: 83 },
      { ...solidFrame(120), delayMs: 83 },
      { ...solidFrame(240, 128), delayMs: 83 }
    ]
    const withDefaults = (() => {
      const encoder = createIncrementalGifEncoder(DEFAULT_GIF_ENCODE_OPTIONS)
      for (const frame of frames) encoder.addFrame(frame)
      return encoder.finish()
    })()
    expect(withDefaults).toEqual(encodeGif(frames))
    expect(encodeGif(frames, { palette: 'perFrame', dither: false, loop: 0 })).toEqual(
      encodeGif(frames)
    )
  })

  it('writes the NETSCAPE loop extension for 0 and 2 and omits it for -1', () => {
    const frame = { ...solidFrame(10), delayMs: 100 }
    const forever = encodeGif([frame], { loop: 0 })
    const twice = encodeGif([frame], { loop: 2 })
    const once = encodeGif([frame], { loop: -1 })

    const at = findNetscape(twice)
    expect(at).toBeGreaterThan(0)
    // 21 FF 0B 'NETSCAPE2.0' 03 01 <loop lo> <loop hi> 00
    expect([twice[at - 3], twice[at - 2], twice[at - 1]]).toEqual([0x21, 0xff, 0x0b])
    expect([twice[at + 11], twice[at + 12]]).toEqual([0x03, 0x01])
    expect(loopCount(twice, at)).toBe(2)

    const foreverAt = findNetscape(forever)
    expect(foreverAt).toBeGreaterThan(0)
    expect(loopCount(forever, foreverAt)).toBe(0)

    expect(findNetscape(once)).toBe(-1)

    // gifenc consumes `repeat` on the first frame only: one extension per stream.
    expect(countNetscape(encodeGif([frame, frame], { loop: 2 }))).toBe(1)
  })

  it('reuses one global palette across frames deterministically', () => {
    const frames = Array.from({ length: 20 }, (_, index) => ({
      ...solidFrame(index % 2 === 0 ? 255 : 0),
      delayMs: 50
    }))
    const first = encodeGif(frames, { palette: 'global' })
    const second = encodeGif(frames, { palette: 'global' })
    expect(first).toEqual(second)
    expect(first).not.toEqual(encodeGif(frames))
    expect(String.fromCharCode(...first.slice(0, 6))).toBe('GIF89a')
    expect(first[first.length - 1]).toBe(0x3b)
  })

  it('dithers a gradient frame differently from the plain mapping', () => {
    const frame = { ...gradientFrame(), delayMs: 50 }
    const plain = encodeGif([frame])
    const dithered = encodeGif([frame], { dither: true })
    expect(dithered).not.toEqual(plain)
    expect(String.fromCharCode(...dithered.slice(0, 6))).toBe('GIF89a')
  })

  it('maps palette-exact colors cleanly with and without dithering', () => {
    const opaque = { ...solidFrame(10), delayMs: 100 }
    const transparent = { ...solidFrame(10, 0), delayMs: 100 }
    expect(encodeGif([opaque], { dither: true })).toEqual(encodeGif([opaque]))
    expect(encodeGif([transparent], { dither: true })).toEqual(encodeGif([transparent]))

    // Two colors that land exactly in the quantized palette: zero mapping
    // error, so diffusion cannot change the result.
    const data = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255])
    const frame = { data, width: 2, height: 1, delayMs: 100 }
    expect(encodeGif([frame], { dither: true })).toEqual(encodeGif([frame]))
  })

  it('applies dithering and a global palette together', () => {
    const frames = [
      { ...gradientFrame(), delayMs: 33 },
      { ...gradientFrame(), delayMs: 33 }
    ]
    const dithered = encodeGif(frames, { palette: 'global', dither: true })
    expect(dithered).toEqual(encodeGif(frames, { palette: 'global', dither: true }))
    expect(dithered).not.toEqual(encodeGif(frames, { palette: 'global' }))
    expect(String.fromCharCode(...dithered.slice(0, 6))).toBe('GIF89a')
  })
})
