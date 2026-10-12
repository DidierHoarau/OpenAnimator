import { describe, expect, it } from 'vitest'

import { createDocument } from './document'
import { defaultExportOptions, sanitizeExportOptions } from './exportOptions'
import type { ExportOptions } from './exportOptions'
import {
  EXPORT_PRESET_NAME_MAX,
  MAX_EXPORT_PRESETS,
  emptyExportPresets,
  normalizeExportPresetName,
  removeExportPreset,
  sanitizeExportPresetsData,
  upsertExportPreset,
  withLastUsed
} from './exportPresets'

function options(): ExportOptions {
  return defaultExportOptions(createDocument('demo', 320, 180, 12))
}

describe('export presets data', () => {
  it('round-trips a valid preset file', () => {
    const data = {
      version: 1,
      presets: [{ name: 'Tiny GIF', options: options() }],
      lastUsed: options()
    }
    expect(sanitizeExportPresetsData(data)).toEqual(data)
    expect(sanitizeExportPresetsData(sanitizeExportPresetsData(data))).toEqual(data)
  })

  it('reads garbage files as empty', () => {
    expect(sanitizeExportPresetsData(null)).toEqual(emptyExportPresets())
    expect(sanitizeExportPresetsData('nope')).toEqual(emptyExportPresets())
    expect(sanitizeExportPresetsData({ presets: 'nope', lastUsed: 42 })).toEqual(
      emptyExportPresets()
    )
  })

  it('drops malformed presets and keeps the valid ones', () => {
    const good = { name: 'Keep', options: options() }
    const bad = [
      { name: '  ', options: options() },
      { name: 42, options: options() },
      { name: 'No options' },
      { name: 'Bad scale', options: { ...options(), scale: 99 } },
      { name: 'Bad format', options: { ...options(), format: 'avi' } },
      { name: 'Bad frame', options: { ...options(), fromFrame: 1.5 } },
      { name: 'Bad palette', options: { ...options(), gifPalette: 'nope' } },
      { name: 'Bad quality', options: { ...options(), videoQuality: 'ultra' } },
      { name: 'Bad dither', options: { ...options(), gifDither: 1 } },
      { name: 'Bad loop', options: { ...options(), gifLoop: -9 } },
      'nope',
      null
    ]
    const data = sanitizeExportPresetsData({ presets: [...bad, good] })
    expect(data.presets).toEqual([good])
    expect(data.lastUsed).toBeNull()
  })

  it('drops an invalid lastUsed back to null', () => {
    expect(sanitizeExportPresetsData({ lastUsed: { ...options(), fps: 999 } }).lastUsed).toBeNull()
    expect(sanitizeExportPresetsData({ lastUsed: options() }).lastUsed).toEqual(options())
  })

  it('trims names, caps their length and resolves duplicates to the first use', () => {
    const first = { name: 'Hero', options: options() }
    const data = sanitizeExportPresetsData({
      presets: [
        { name: '  Hero  ', options: options() },
        { name: 'Hero', options: { ...options(), format: 'webm' } },
        { name: 'x'.repeat(100), options: options() }
      ]
    })
    expect(data.presets[0]).toEqual(first)
    expect(data.presets).toHaveLength(2)
    expect(data.presets[1].name).toHaveLength(EXPORT_PRESET_NAME_MAX)
  })

  it('caps the stored preset count', () => {
    const presets = Array.from({ length: MAX_EXPORT_PRESETS + 5 }, (_, index) => ({
      name: `Preset ${index}`,
      options: options()
    }))
    const data = sanitizeExportPresetsData({ presets })
    expect(data.presets).toHaveLength(MAX_EXPORT_PRESETS)
    expect(data.presets[0].name).toBe('Preset 0')
  })

  it('normalizes names and rejects empty ones', () => {
    expect(normalizeExportPresetName('  Web high  ')).toBe('Web high')
    expect(normalizeExportPresetName('')).toBeNull()
    expect(normalizeExportPresetName('   ')).toBeNull()
    expect(normalizeExportPresetName(7)).toBeNull()
    expect(normalizeExportPresetName('y'.repeat(80))).toBe('y'.repeat(EXPORT_PRESET_NAME_MAX))
  })

  it('upserts presets: replace in place, append, evict the oldest past the cap', () => {
    let data = emptyExportPresets()
    data = upsertExportPreset(data, 'A', options())
    data = upsertExportPreset(data, 'B', options())
    const replaced = upsertExportPreset(data, 'A', { ...options(), format: 'mp4' })
    expect(replaced.presets.map((preset) => preset.name)).toEqual(['A', 'B'])
    expect(replaced.presets[0].options.format).toBe('mp4')

    for (let index = 0; index < MAX_EXPORT_PRESETS + 2; index += 1) {
      data = upsertExportPreset(data, `P${index}`, options())
    }
    expect(data.presets).toHaveLength(MAX_EXPORT_PRESETS)
    expect(data.presets[0].name).toBe('P2')
    expect(upsertExportPreset(data, '   ', options())).toEqual(data)
  })

  it('removes presets by exact name and records last-used options', () => {
    let data = upsertExportPreset(emptyExportPresets(), 'Keep', options())
    data = upsertExportPreset(data, 'Drop', options())
    data = removeExportPreset(data, 'Drop')
    expect(data.presets.map((preset) => preset.name)).toEqual(['Keep'])

    const used = sanitizeExportOptions({ format: 'webm', fps: 24 }, createDocument('demo', 320, 180, 12))
    const recorded = withLastUsed(data, used)
    expect(recorded.lastUsed).toEqual(used)
    expect(recorded.presets).toEqual(data.presets)
    used.fps = 99
    expect(recorded.lastUsed?.fps).toBe(24)
  })
})
