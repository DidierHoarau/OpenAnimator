/**
 * Application preferences: the previously hardcoded editor defaults (stage
 * size, fps, autosave cadence, brush, undo depth, grid size, starter demo).
 * Persisted as `preferences.json` in userData; a pure sanitizer keeps a
 * corrupted or outdated file from breaking the editor — unknown keys are
 * dropped and out-of-range values clamp into their valid window.
 */

export interface AppPreferences {
  /** Stage size of the next new document (never resizes the current one). */
  stageWidth: number
  stageHeight: number
  /** Frame rate of the next new document, 1–120. */
  fps: number
  /** Autosave recovery snapshots on/off. */
  autosaveEnabled: boolean
  /** Autosave idle window in ms (the hard max-wait stays 20 s). */
  autosaveIdleMs: number
  /** Brush/eraser width in stage pixels, 1–64. */
  brushSize: number
  /** Brush stroke opacity, 0.05–1. */
  brushOpacity: number
  /** Undo history depth, 10–500 snapshots. */
  undoDepth: number
  /** Grid size in stage pixels, 4–200. */
  gridSize: number
  /** New documents start from the demo scene instead of a blank one. Off by
   * default (matching the previous hardcoded New behavior); the demo remains
   * the welcome document shown at startup. */
  showDemoOnNew: boolean
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  stageWidth: 960,
  stageHeight: 540,
  fps: 24,
  autosaveEnabled: true,
  autosaveIdleMs: 2500,
  brushSize: 6,
  brushOpacity: 1,
  undoDepth: 100,
  gridSize: 20,
  showDemoOnNew: false
}

export const PREFERENCE_LIMITS = {
  stageWidth: { min: 16, max: 8192 },
  stageHeight: { min: 16, max: 8192 },
  fps: { min: 1, max: 120 },
  autosaveIdleMs: { min: 500, max: 60000 },
  brushSize: { min: 1, max: 64 },
  brushOpacity: { min: 0.05, max: 1 },
  undoDepth: { min: 10, max: 500 },
  gridSize: { min: 4, max: 200 }
} as const

function clampNumber(value: unknown, min: number, max: number, integer: boolean, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const clamped = Math.min(max, Math.max(min, value))
  return integer ? Math.round(clamped) : clamped
}

/**
 * Sanitizes an untrusted preferences object. Every known key is clamped into
 * its valid window; missing or invalid keys fall back to `base` (the current
 * preferences for partial merges, the defaults otherwise).
 */
export function sanitizePreferences(raw: unknown, base: AppPreferences = DEFAULT_PREFERENCES): AppPreferences {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof AppPreferences, unknown>>
  return {
    stageWidth: clampNumber(source.stageWidth, PREFERENCE_LIMITS.stageWidth.min, PREFERENCE_LIMITS.stageWidth.max, true, base.stageWidth),
    stageHeight: clampNumber(source.stageHeight, PREFERENCE_LIMITS.stageHeight.min, PREFERENCE_LIMITS.stageHeight.max, true, base.stageHeight),
    fps: clampNumber(source.fps, PREFERENCE_LIMITS.fps.min, PREFERENCE_LIMITS.fps.max, true, base.fps),
    autosaveEnabled: typeof source.autosaveEnabled === 'boolean' ? source.autosaveEnabled : base.autosaveEnabled,
    autosaveIdleMs: clampNumber(source.autosaveIdleMs, PREFERENCE_LIMITS.autosaveIdleMs.min, PREFERENCE_LIMITS.autosaveIdleMs.max, true, base.autosaveIdleMs),
    brushSize: clampNumber(source.brushSize, PREFERENCE_LIMITS.brushSize.min, PREFERENCE_LIMITS.brushSize.max, true, base.brushSize),
    brushOpacity: clampNumber(source.brushOpacity, PREFERENCE_LIMITS.brushOpacity.min, PREFERENCE_LIMITS.brushOpacity.max, false, base.brushOpacity),
    undoDepth: clampNumber(source.undoDepth, PREFERENCE_LIMITS.undoDepth.min, PREFERENCE_LIMITS.undoDepth.max, true, base.undoDepth),
    gridSize: clampNumber(source.gridSize, PREFERENCE_LIMITS.gridSize.min, PREFERENCE_LIMITS.gridSize.max, true, base.gridSize),
    showDemoOnNew: typeof source.showDemoOnNew === 'boolean' ? source.showDemoOnNew : base.showDemoOnNew
  }
}

/** Merges a partial patch over the current preferences and sanitizes it. */
export function mergePreferences(base: AppPreferences, patch: unknown): AppPreferences {
  const source = (typeof patch === 'object' && patch !== null ? patch : {}) as Partial<Record<keyof AppPreferences, unknown>>
  const merged: Record<string, unknown> = { ...base }
  for (const key of Object.keys(DEFAULT_PREFERENCES) as Array<keyof AppPreferences>) {
    if (key in source) merged[key] = source[key]
  }
  return sanitizePreferences(merged, base)
}
