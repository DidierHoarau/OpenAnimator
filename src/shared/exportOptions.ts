import type { AnimatorDocument } from './model'
import { documentDuration } from './document'

/** Export output formats. PNG sequence, dotLottie and spritesheet ship as
 * ZIP archives; the vector formats have no raster resolution. */
export type ExportFormat =
  | 'png-sequence'
  | 'gif'
  | 'webm'
  | 'mp4'
  | 'lottie'
  | 'dotlottie'
  | 'svg-animation'
  | 'spritesheet'

export const EXPORT_FORMATS: Array<{ format: ExportFormat; label: string; extension: string }> = [
  { format: 'png-sequence', label: 'PNG sequence (ZIP, alpha)', extension: 'zip' },
  { format: 'gif', label: 'Animated GIF', extension: 'gif' },
  { format: 'webm', label: 'WebM video (VP9)', extension: 'webm' },
  { format: 'mp4', label: 'MP4 video (H.264)', extension: 'mp4' },
  { format: 'lottie', label: 'Lottie (bodymovin JSON)', extension: 'json' },
  { format: 'dotlottie', label: 'dotLottie (ZIP)', extension: 'lottie' },
  { format: 'svg-animation', label: 'Animated SVG (CSS keyframes)', extension: 'svg' },
  { format: 'spritesheet', label: 'Spritesheet (PNG atlas ZIP, alpha)', extension: 'zip' }
]

export const EXPORT_LIMITS = {
  scale: { min: 0.25, max: 4, fallback: 1 },
  fps: { min: 1, max: 60, fallback: 12 },
  maxWidth: 7680,
  maxHeight: 7680
} as const

/** GIF color strategies: a 256-color palette per frame (best quality) or
 * one palette for the whole animation (smaller, flicker-free). */
export type GifPaletteMode = 'perFrame' | 'global'
export const GIF_PALETTES: GifPaletteMode[] = ['perFrame', 'global']

/** MP4/WebM quality tiers, mapped to encoder quantizers/CRF values. */
export type VideoQuality = 'low' | 'medium' | 'high'
export const VIDEO_QUALITIES: VideoQuality[] = ['low', 'medium', 'high']

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
  /** GIF color strategy; only meaningful for `gif`. */
  gifPalette: GifPaletteMode
  /** Floyd–Steinberg dithering for GIF quantization. */
  gifDither: boolean
  /** GIF loop count: 0 loops forever, -1 plays once, n>0 repeats n times. */
  gifLoop: number
  /** MP4/WebM quality tier; only meaningful for the video formats. */
  videoQuality: VideoQuality
}

/** Default export options for a document: full range, native size and fps. */
export function defaultExportOptions(document: AnimatorDocument): ExportOptions {
  return {
    format: 'gif',
    scale: EXPORT_LIMITS.scale.fallback,
    fps: clampFps(document.fps),
    fromFrame: 0,
    toFrame: documentDuration(document) - 1,
    transparent: false,
    gifPalette: 'perFrame',
    gifDither: false,
    gifLoop: 0,
    // 'high' preserves the pre-option renderer behavior (QUALITY_HIGH); the
    // lower tiers are opt-in size/quality trade-offs.
    videoQuality: 'high'
  }
}

function clampFps(fps: number): number {
  if (!Number.isFinite(fps)) return EXPORT_LIMITS.fps.fallback
  return Math.min(EXPORT_LIMITS.fps.max, Math.max(EXPORT_LIMITS.fps.min, Math.round(fps)))
}

/**
 * Coerces untrusted export options (dialog fields, CLI flags, scripted
 * calls) into a valid, clamped set. Frame indices are clamped into the
 * document range and reordered; transparent is dropped for MP4 (no alpha
 * codec), and the vector Lottie formats pin scale to 1 — their resolution is
 * inherent to the consuming player.
 */
export function sanitizeExportOptions(
  raw: Partial<ExportOptions> | undefined,
  document: AnimatorDocument
): ExportOptions {
  const defaults = defaultExportOptions(document)
  const format = EXPORT_FORMATS.some((entry) => entry.format === raw?.format)
    ? (raw!.format as ExportFormat)
    : defaults.format
  const scaleNumber = Number(raw?.scale)
  const clampedScale = Number.isFinite(scaleNumber)
    ? Math.min(
        EXPORT_LIMITS.scale.max,
        Math.max(EXPORT_LIMITS.scale.min, scaleNumber)
      )
    : defaults.scale
  const scale = format === 'lottie' || format === 'dotlottie' ? 1 : clampedScale
  const lastFrame = documentDuration(document) - 1
  const from = clampFrame(Number(raw?.fromFrame), 0, lastFrame)
  const to = clampFrame(Number(raw?.toFrame), 0, lastFrame)
  return {
    format,
    scale,
    fps: clampFps(Number(raw?.fps)),
    fromFrame: Math.min(from, to),
    toFrame: Math.max(from, to),
    // Only MP4 is opaque-by-codec: every other format can carry alpha
    // (spritesheets and PNG sequences on empty areas, Lottie/SVG/WebM on
    // supporting players/encoders).
    transparent: format === 'mp4' ? false : Boolean(raw?.transparent),
    gifPalette: GIF_PALETTES.includes(raw?.gifPalette as GifPaletteMode)
      ? (raw!.gifPalette as GifPaletteMode)
      : defaults.gifPalette,
    gifDither: Boolean(raw?.gifDither),
    gifLoop: clampGifLoop(Number(raw?.gifLoop)),
    videoQuality: VIDEO_QUALITIES.includes(raw?.videoQuality as VideoQuality)
      ? (raw!.videoQuality as VideoQuality)
      : defaults.videoQuality
  }
}

function clampGifLoop(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(65535, Math.max(-1, Math.floor(value)))
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

/** ffmpeg CRF for a video quality tier: VP9 needs a wider range than x264
 * for the same perceived quality. Lower = better quality, bigger file. */
export function videoCrfFor(
  quality: VideoQuality,
  codec: 'vp9' | 'x264'
): number {
  if (codec === 'vp9') return quality === 'low' ? 40 : quality === 'high' ? 25 : 33
  return quality === 'low' ? 30 : quality === 'high' ? 18 : 23
}
