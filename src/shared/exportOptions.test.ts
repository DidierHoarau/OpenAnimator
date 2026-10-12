import { describe, expect, it } from 'vitest'

import { createDocument } from './document'
import {
  defaultExportOptions,
  exportExtension,
  exportFrameCount,
  exportPixelSize,
  sanitizeExportOptions,
  videoCrfFor
} from './exportOptions'

describe('export options', () => {
  it('defaults to the full range at native size and document fps', () => {
    const document = createDocument('demo', 960, 540, 12)
    document.frames = 24
    const options = defaultExportOptions(document)
    expect(options).toEqual({
      format: 'gif',
      scale: 1,
      fps: 12,
      fromFrame: 0,
      toFrame: 23,
      transparent: false,
      gifPalette: 'perFrame',
      gifDither: false,
      gifLoop: 0,
      videoQuality: 'high'
    })
    expect(exportFrameCount(options)).toBe(24)
    expect(exportPixelSize(document, options)).toEqual({ width: 960, height: 540 })
  })

  it('sanitizes untrusted values into the valid ranges', () => {
    const document = createDocument('demo', 960, 540, 12)
    document.frames = 10
    const options = sanitizeExportOptions(
      {
        format: 'mp4' as never,
        scale: 99,
        fps: 0,
        fromFrame: -5,
        toFrame: 42,
        transparent: true
      },
      document
    )
    expect(options.format).toBe('mp4')
    expect(options.scale).toBe(4)
    expect(options.fps).toBe(1)
    expect(options.fromFrame).toBe(0)
    expect(options.toFrame).toBe(9)
    // MP4 has no alpha codec; the flag is dropped.
    expect(options.transparent).toBe(false)
  })

  it('keeps transparency for alpha-capable formats and reorders the range', () => {
    const document = createDocument('demo', 960, 540, 12)
    document.frames = 10
    const options = sanitizeExportOptions(
      { format: 'png-sequence', fromFrame: 5, toFrame: 2, transparent: true },
      document
    )
    expect(options.transparent).toBe(true)
    expect(options.fromFrame).toBe(2)
    expect(options.toFrame).toBe(5)
  })

  it('falls back to defaults for garbage input and unknown formats', () => {
    const document = createDocument('demo', 960, 540, 12)
    const options = sanitizeExportOptions({ format: 'avi' as never, fps: Number.NaN, scale: Number.NaN, fromFrame: Number.NaN, toFrame: Number.NaN }, document)
    expect(options.format).toBe('gif')
    expect(options.scale).toBe(1)
    expect(options.fps).toBe(12)
    expect(options.fromFrame).toBe(0)
    expect(options.toFrame).toBe(0)
  })

  it('maps formats to file extensions', () => {
    expect(exportExtension('png-sequence')).toBe('zip')
    expect(exportExtension('gif')).toBe('gif')
    expect(exportExtension('webm')).toBe('webm')
    expect(exportExtension('mp4')).toBe('mp4')
    expect(exportExtension('lottie')).toBe('json')
    expect(exportExtension('dotlottie')).toBe('lottie')
    expect(exportExtension('svg-animation')).toBe('svg')
    expect(exportExtension('spritesheet')).toBe('zip')
  })

  it('keeps transparency for the new alpha-capable formats and pins vector scale', () => {
    const document = createDocument('demo', 960, 540, 12)
    document.frames = 10
    for (const format of ['webm', 'svg-animation', 'spritesheet'] as const) {
      const options = sanitizeExportOptions({ format, scale: 2, transparent: true }, document)
      expect(options.transparent).toBe(true)
      expect(options.scale).toBe(2)
    }
    // The vector Lottie formats ignore the raster scale entirely.
    for (const format of ['lottie', 'dotlottie'] as const) {
      const options = sanitizeExportOptions({ format, scale: 3, transparent: true }, document)
      expect(options.scale).toBe(1)
      expect(options.transparent).toBe(true)
    }
  })

  it('drops transparency only for MP4 among the new formats', () => {
    const document = createDocument('demo', 960, 540, 12)
    document.frames = 10
    const mp4 = sanitizeExportOptions({ format: 'mp4', transparent: true }, document)
    expect(mp4.transparent).toBe(false)
    const webm = sanitizeExportOptions({ format: 'webm', transparent: true }, document)
    expect(webm.transparent).toBe(true)
  })

  it('passes through valid GIF and video quality options', () => {
    const document = createDocument('demo', 960, 540, 12)
    document.frames = 10
    const options = sanitizeExportOptions(
      { format: 'gif', gifPalette: 'global', gifDither: true, gifLoop: 3, videoQuality: 'low' },
      document
    )
    expect(options.gifPalette).toBe('global')
    expect(options.gifDither).toBe(true)
    expect(options.gifLoop).toBe(3)
    expect(options.videoQuality).toBe('low')
  })

  it('clamps GIF loop counts and falls back for garbage option values', () => {
    const document = createDocument('demo', 960, 540, 12)
    document.frames = 10
    const clamped = sanitizeExportOptions(
      { gifPalette: 'sparkly' as never, gifDither: 1 as never, gifLoop: 1e9, videoQuality: 'ultra' as never },
      document
    )
    expect(clamped.gifPalette).toBe('perFrame')
    expect(clamped.gifDither).toBe(true)
    expect(clamped.gifLoop).toBe(65535)
    expect(clamped.videoQuality).toBe('high')

    const negative = sanitizeExportOptions({ gifLoop: -7.5 }, document)
    expect(negative.gifLoop).toBe(-1)
    const nano = sanitizeExportOptions({ gifLoop: Number.NaN }, document)
    expect(nano.gifLoop).toBe(0)
  })

  it('maps video quality tiers to ffmpeg CRF values per codec', () => {
    expect(videoCrfFor('low', 'vp9')).toBe(40)
    expect(videoCrfFor('medium', 'vp9')).toBe(33)
    expect(videoCrfFor('high', 'vp9')).toBe(25)
    expect(videoCrfFor('low', 'x264')).toBe(30)
    expect(videoCrfFor('medium', 'x264')).toBe(23)
    expect(videoCrfFor('high', 'x264')).toBe(18)
  })
})
