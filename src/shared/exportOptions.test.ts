import { describe, expect, it } from 'vitest'

import { createDocument } from './document'
import {
  defaultExportOptions,
  exportExtension,
  exportFrameCount,
  exportPixelSize,
  sanitizeExportOptions
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
      transparent: false
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
    // Video formats have no alpha; the flag is dropped.
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
  })
})
