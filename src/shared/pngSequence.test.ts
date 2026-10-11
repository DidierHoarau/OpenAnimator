import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { packPngSequence } from './pngSequence'

describe('packPngSequence', () => {
  it('packs the frames as zero-padded PNG entries in a ZIP', () => {
    const pngA = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 1])
    const pngB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2, 2])
    const zip = packPngSequence([pngA, pngB])
    const entries = unzipSync(zip)
    expect(Object.keys(entries).sort()).toEqual(['frame_0000.png', 'frame_0001.png'])
    expect([...entries['frame_0000.png']]).toEqual([...pngA])
    expect([...entries['frame_0001.png']]).toEqual([...pngB])
  })

  it('pads frame indices past 9999', () => {
    const frames = Array.from({ length: 10001 }, (_, i) => new Uint8Array([i % 256]))
    const entries = Object.keys(unzipSync(packPngSequence(frames)))
    expect(entries).toContain('frame_0000.png')
    expect(entries).toContain('frame_10000.png')
  })
})
