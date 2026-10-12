import { describe, expect, it } from 'vitest'

import { createIncrementalGifEncoder, encodeGif, gifDelayMs } from './gifEncode'

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
