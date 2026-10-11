import type { AnimatorDocument } from './model'
import { documentDuration } from './document'

/** Export output formats. PNG sequence ships as a ZIP of per-frame PNGs. */
export type ExportFormat = 'png-sequence' | 'gif' | 'webm' | 'mp4'

export const EXPORT_FORMATS: Array<{ format: ExportFormat; label: string; extension: string }> = [
  { format: 'png-sequence', label: 'PNG sequence (ZIP, alpha)', extension: 'zip' },
  { format: 'gif', label: 'Animated GIF', extension: 'gif' },
  { format: 'webm', label: 'WebM video (VP9)', extension: 'webm' },
  { format: 'mp4', label: 'MP4 video (H.264)', extension: 'mp4' }
]

export const EXPORT_LIMITS = {
  scale: { min: 0.25, max: 4, fallback: 1 },
  fps: { min: 1, max: 60, fallback: 12 },
  maxWidth: 7680,
  maxHeight: 7680
} as const

export interface ExportOptions {
  format: ExportFormat
  /** Resolution multiplier applied to the document size. */
  scale: number
  fps: number
  /** First frame of the range, inclusive (0-based). */
  fromFrame: number
  /** Last frame of the range, inclusive (0-based). */
  toFrame: number
  /** Omits the document background; only honored by alpha-capable formats. */
  transparent: boolean
}

/** Default export options for a document: full range, native size and fps. */
export function defaultExportOptions(document: AnimatorDocument): ExportOptions {
  return {
    format: 'gif',
    scale: EXPORT_LIMITS.scale.fallback,
    fps: clampFps(document.fps),
    fromFrame: 0,
    toFrame: documentDuration(document) - 1,
    transparent: false
  }
}

function clampFps(fps: number): number {
  if (!Number.isFinite(fps)) return EXPORT_LIMITS.fps.fallback
  return Math.min(EXPORT_LIMITS.fps.max, Math.max(EXPORT_LIMITS.fps.min, Math.round(fps)))
}

/**
 * Coerces untrusted export options (dialog fields, CLI flags, scripted
 * calls) into a valid, clamped set. Frame indices are clamped into the
 * document range and reordered; transparent is dropped for video formats,
 * which always render on an opaque background.
 */
export function sanitizeExportOptions(
  raw: Partial<ExportOptions> | undefined,
  document: AnimatorDocument
): ExportOptions {
  const defaults = defaultExportOptions(document)
  const scaleNumber = Number(raw?.scale)
  const scale = Number.isFinite(scaleNumber)
    ? Math.min(
        EXPORT_LIMITS.scale.max,
        Math.max(EXPORT_LIMITS.scale.min, scaleNumber)
      )
    : defaults.scale
  const lastFrame = documentDuration(document) - 1
  const from = clampFrame(Number(raw?.fromFrame), 0, lastFrame)
  const to = clampFrame(Number(raw?.toFrame), 0, lastFrame)
  const format = EXPORT_FORMATS.some((entry) => entry.format === raw?.format)
    ? (raw!.format as ExportFormat)
    : defaults.format
  return {
    format,
    scale,
    fps: clampFps(Number(raw?.fps)),
    fromFrame: Math.min(from, to),
    toFrame: Math.max(from, to),
    // Video codecs have no alpha: silently render on the background color.
    transparent: format === 'png-sequence' || format === 'gif' ? Boolean(raw?.transparent) : false
  }
}

function clampFrame(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** Pixel size of the exported raster for these options. */
export function exportPixelSize(
  document: AnimatorDocument,
  options: ExportOptions
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(document.width * options.scale)),
    height: Math.max(1, Math.round(document.height * options.scale))
  }
}

/** Number of frames the export will produce. */
export function exportFrameCount(options: ExportOptions): number {
  return options.toFrame - options.fromFrame + 1
}

/** File extension (without dot) for an export format. */
export function exportExtension(format: ExportFormat): string {
  return EXPORT_FORMATS.find((entry) => entry.format === format)?.extension ?? 'bin'
}
