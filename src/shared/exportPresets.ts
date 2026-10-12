import {
  EXPORT_FORMATS,
  EXPORT_LIMITS,
  GIF_PALETTES,
  VIDEO_QUALITIES
} from './exportOptions'
import type { ExportFormat, ExportOptions, GifPaletteMode, VideoQuality } from './exportOptions'

/**
 * Persistent export presets ("named option sets" plus the last-used options):
 * a small JSON file in the application's user-data directory, kept separate
 * from `AppPreferences` because its entries are object-typed (the preference
 * schema only carries numbers and booleans) and because presets are a
 * document-independent, user-curated list rather than app configuration.
 * Untrusted file contents are validated field by field on every read and
 * write; anything malformed is dropped rather than repaired — the dialog
 * re-sanitizes against the live document when a preset is applied.
 */

export const EXPORT_PRESETS_FILE_VERSION = 1

/** Cap on stored presets; the oldest entry is evicted past it. */
export const MAX_EXPORT_PRESETS = 24

/** Cap on preset name length (after trimming). */
export const EXPORT_PRESET_NAME_MAX = 40

export interface ExportPreset {
  name: string
  options: ExportOptions
}

export interface ExportPresetsData {
  version: number
  presets: ExportPreset[]
  lastUsed: ExportOptions | null
}

export function emptyExportPresets(): ExportPresetsData {
  return { version: EXPORT_PRESETS_FILE_VERSION, presets: [], lastUsed: null }
}

/** Trimmed preset name within the length cap, or null for empty/non-string. */
export function normalizeExportPresetName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  return trimmed.slice(0, EXPORT_PRESET_NAME_MAX)
}

function readNumber(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  if (raw < min || raw > max) return null
  return raw
}

function readFrame(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null
  return raw
}

/** Strict shape validation of one stored option set: enum membership and
 * document-independent ranges only — frame bounds are re-clamped against the
 * live document when the preset is applied. */
function readExportOptions(raw: unknown): ExportOptions | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const format = EXPORT_FORMATS.find((entry) => entry.format === record.format)?.format as
    | ExportFormat
    | undefined
  const scale = readNumber(record.scale, EXPORT_LIMITS.scale.min, EXPORT_LIMITS.scale.max)
  const fps = readNumber(record.fps, EXPORT_LIMITS.fps.min, EXPORT_LIMITS.fps.max)
  const fromFrame = readFrame(record.fromFrame)
  const toFrame = readFrame(record.toFrame)
  const gifPalette = GIF_PALETTES.find((mode) => mode === record.gifPalette) as
    | GifPaletteMode
    | undefined
  const gifLoop = readNumber(record.gifLoop, -1, 65535)
  const videoQuality = VIDEO_QUALITIES.find((tier) => tier === record.videoQuality) as
    | VideoQuality
    | undefined
  if (
    !format ||
    scale === null ||
    fps === null ||
    fromFrame === null ||
    toFrame === null ||
    !gifPalette ||
    gifLoop === null ||
    !videoQuality ||
    typeof record.transparent !== 'boolean' ||
    typeof record.gifDither !== 'boolean'
  ) {
    return null
  }
  return {
    format,
    scale,
    fps,
    fromFrame,
    toFrame,
    transparent: record.transparent,
    gifPalette,
    gifDither: record.gifDither,
    gifLoop,
    videoQuality
  }
}

/** Coerces untrusted stored data into a valid preset set: malformed entries
 * are dropped, names are trimmed and capped, later duplicates lose to the
 * first use of a name, and the preset count is capped. */
export function sanitizeExportPresetsData(raw: unknown): ExportPresetsData {
  if (typeof raw !== 'object' || raw === null) return emptyExportPresets()
  const record = raw as { presets?: unknown; lastUsed?: unknown }
  const presets: ExportPreset[] = []
  if (Array.isArray(record.presets)) {
    for (const entry of record.presets) {
      if (presets.length >= MAX_EXPORT_PRESETS) break
      if (typeof entry !== 'object' || entry === null) continue
      const candidate = entry as { name?: unknown; options?: unknown }
      const name = normalizeExportPresetName(candidate.name)
      const options = readExportOptions(candidate.options)
      if (!name || !options) continue
      if (presets.some((preset) => preset.name === name)) continue
      presets.push({ name, options })
    }
  }
  return {
    version: EXPORT_PRESETS_FILE_VERSION,
    presets,
    lastUsed: readExportOptions(record.lastUsed)
  }
}

/** Inserts or replaces the preset under `name` (evicting the oldest entry
 * past the cap); a name that normalizes to empty leaves the data untouched. */
export function upsertExportPreset(
  data: ExportPresetsData,
  name: unknown,
  options: ExportOptions
): ExportPresetsData {
  const normalized = normalizeExportPresetName(name)
  if (!normalized) return data
  const presets = [...data.presets]
  const existing = presets.findIndex((preset) => preset.name === normalized)
  if (existing >= 0) {
    presets[existing] = { name: normalized, options }
  } else {
    presets.push({ name: normalized, options })
    if (presets.length > MAX_EXPORT_PRESETS) presets.splice(0, presets.length - MAX_EXPORT_PRESETS)
  }
  return { ...data, presets }
}

export function removeExportPreset(data: ExportPresetsData, name: string): ExportPresetsData {
  return { ...data, presets: data.presets.filter((preset) => preset.name !== name) }
}

/** The data with `options` recorded as last used. */
export function withLastUsed(data: ExportPresetsData, options: ExportOptions): ExportPresetsData {
  return { ...data, lastUsed: { ...options } }
}
