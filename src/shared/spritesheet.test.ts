import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  blitFrameIntoAtlas,
  buildSpritesheetMetadata,
  computeSpritesheetGrid,
  packSpritesheet
} from './spritesheet'

describe('computeSpritesheetGrid', () => {
  it('lays frames out near-square', () => {
    expect(computeSpritesheetGrid(12, 100, 100)).toEqual({
      columns: 4,
      rows: 3,
      width: 400,
      height: 300
    })
  })

  it('derives rows from the column count', () => {
    expect(computeSpritesheetGrid(5, 64, 64)).toEqual({
      columns: 3,
      rows: 2,
      width: 192,
      height: 128
    })
  })

  it('keeps both sides within maxDimension by clamping the column count', () => {
    // 6 frames of 140×100 in a 300 px square: the pixel-square would use 3
    // columns, but 3×140 exceeds 300, so the count is capped at 2.
    expect(computeSpritesheetGrid(6, 140, 100, 300)).toEqual({
      columns: 2,
      rows: 3,
      width: 280,
      height: 300
    })
  })

  it('uses a single column when the frame leaves no other option', () => {
    expect(computeSpritesheetGrid(3, 300, 100, 400)).toEqual({
      columns: 1,
      rows: 3,
      width: 300,
      height: 300
    })
  })

  it('rejects an empty frame list', () => {
    expect(() => computeSpritesheetGrid(0, 100, 100)).toThrow('at least one frame')
  })

  it('rejects non-positive frame dimensions', () => {
    expect(() => computeSpritesheetGrid(2, 0, 100)).toThrow('dimensions must be positive')
  })

  it('rejects a single frame larger than maxDimension', () => {
    expect(() => computeSpritesheetGrid(1, 8000, 100, 7680)).toThrow('exceeds the maximum')
  })

  it('rejects a sheet that cannot fit in the atlas', () => {
    expect(() => computeSpritesheetGrid(20, 300, 300, 400)).toThrow('do not fit')
  })
})

describe('buildSpritesheetMetadata', () => {
  const grid = computeSpritesheetGrid(3, 10, 20)

  it('emits TexturePacker JSON-Hash frames named frame_%04d', () => {
    const metadata = buildSpritesheetMetadata({
      frameCount: 3,
      frameWidth: 10,
      frameHeight: 20,
      grid,
      fps: 12,
      fromFrame: 4,
      toFrame: 6,
      version: '1.2.3'
    })
    expect(Object.keys(metadata.frames)).toEqual(['frame_0000', 'frame_0001', 'frame_0002'])
    expect(metadata.frames.frame_0000.frame).toEqual({ x: 0, y: 0, w: 10, h: 20 })
    expect(metadata.frames.frame_0002.frame).toEqual({ x: 20, y: 0, w: 10, h: 20 })
    expect(metadata.frames.frame_0000.rotated).toBe(false)
    expect(metadata.frames.frame_0000.trimmed).toBe(false)
    expect(metadata.frames.frame_0000.spriteSourceSize).toEqual({ x: 0, y: 0, w: 10, h: 20 })
    expect(metadata.frames.frame_0000.sourceSize).toEqual({ w: 10, h: 20 })
  })

  it('records the atlas meta and the openanimator playback block', () => {
    const metadata = buildSpritesheetMetadata({
      frameCount: 3,
      frameWidth: 10,
      frameHeight: 20,
      grid,
      fps: 12,
      fromFrame: 4,
      toFrame: 6,
      version: '1.2.3'
    })
    expect(metadata.meta).toEqual({
      app: 'OpenAnimator',
      version: '1.2.3',
      image: 'atlas.png',
      format: 'RGBA8888',
      size: { w: grid.width, h: grid.height },
      scale: 1
    })
    expect(metadata.openanimator).toEqual({ fps: 12, fromFrame: 4, toFrame: 6, frameCount: 3 })
  })
})

describe('blitFrameIntoAtlas', () => {
  it('copies RGBA rows into the atlas rectangle', () => {
    const atlas = new Uint8Array(6 * 4 * 4)
    const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    blitFrameIntoAtlas(atlas, 6, { rgba, width: 2, height: 2 }, 2, 1)
    // Row 0 of the frame lands at y=1, x=2: byte offset ((1·6)+2)·4 = 32.
    expect([...atlas.slice(32, 40)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // Row 1 lands one atlas row further down: offset ((2·6)+2)·4 = 56.
    expect([...atlas.slice(56, 64)]).toEqual([9, 10, 11, 12, 13, 14, 15, 16])
    // Everything else stays zeroed.
    expect(atlas[31]).toBe(0)
    expect(atlas[40]).toBe(0)
    expect(atlas[55]).toBe(0)
  })

  it('writes into the top-left corner untouched by row math', () => {
    const atlas = new Uint8Array(2 * 2 * 4)
    const rgba = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6])
    blitFrameIntoAtlas(atlas, 2, { rgba, width: 2, height: 2 }, 0, 0)
    expect([...atlas]).toEqual([...rgba])
  })
})

describe('packSpritesheet', () => {
  it('zips the atlas PNG together with its JSON metadata', () => {
    const grid = computeSpritesheetGrid(2, 8, 8)
    const metadata = buildSpritesheetMetadata({
      frameCount: 2,
      frameWidth: 8,
      frameHeight: 8,
      grid,
      fps: 24,
      fromFrame: 0,
      toFrame: 1,
      version: '0.18.0'
    })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const zip = unzipSync(packSpritesheet(png, metadata))
    expect(Object.keys(zip).sort()).toEqual(['atlas.json', 'atlas.png'])
    expect([...zip['atlas.png']]).toEqual([...png])
    const parsed: unknown = JSON.parse(strFromU8(zip['atlas.json']))
    expect(parsed).toEqual(metadata)
  })
})
