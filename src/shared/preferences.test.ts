import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PREFERENCES,
  PREFERENCE_LIMITS,
  mergePreferences,
  sanitizePreferences
} from './preferences'

describe('sanitizePreferences', () => {
  it('returns the defaults for absent or non-object input', () => {
    expect(sanitizePreferences(undefined)).toEqual(DEFAULT_PREFERENCES)
    expect(sanitizePreferences(null)).toEqual(DEFAULT_PREFERENCES)
    expect(sanitizePreferences('nope')).toEqual(DEFAULT_PREFERENCES)
    expect(sanitizePreferences(42)).toEqual(DEFAULT_PREFERENCES)
  })

  it('keeps valid values and drops unknown keys', () => {
    const result = sanitizePreferences({
      stageWidth: 1280,
      stageHeight: 720,
      fps: 30,
      autosaveEnabled: false,
      autosaveIdleMs: 4000,
      brushSize: 12,
      brushOpacity: 0.5,
      undoDepth: 250,
      gridSize: 40,
      showDemoOnNew: false,
      somethingElse: true
    })
    expect(result).toEqual({
      stageWidth: 1280,
      stageHeight: 720,
      fps: 30,
      autosaveEnabled: false,
      autosaveIdleMs: 4000,
      brushSize: 12,
      brushOpacity: 0.5,
      undoDepth: 250,
      gridSize: 40,
      showDemoOnNew: false
    })
    expect('somethingElse' in result).toBe(false)
  })

  it('clamps out-of-range values into their windows', () => {
    const low = sanitizePreferences({
      stageWidth: 1,
      stageHeight: 999999,
      fps: 0,
      autosaveIdleMs: 10,
      brushSize: 0,
      brushOpacity: -3,
      undoDepth: 1,
      gridSize: 1
    })
    expect(low.stageWidth).toBe(PREFERENCE_LIMITS.stageWidth.min)
    expect(low.stageHeight).toBe(PREFERENCE_LIMITS.stageHeight.max)
    expect(low.fps).toBe(1)
    expect(low.autosaveIdleMs).toBe(500)
    expect(low.brushSize).toBe(1)
    expect(low.brushOpacity).toBe(0.05)
    expect(low.undoDepth).toBe(10)
    expect(low.gridSize).toBe(4)

    const high = sanitizePreferences({
      stageWidth: 999999,
      fps: 1000,
      autosaveIdleMs: 9999999,
      brushSize: 500,
      brushOpacity: 12,
      undoDepth: 9999,
      gridSize: 9999
    })
    expect(high.stageWidth).toBe(8192)
    expect(high.fps).toBe(120)
    expect(high.autosaveIdleMs).toBe(60000)
    expect(high.brushSize).toBe(64)
    expect(high.brushOpacity).toBe(1)
    expect(high.undoDepth).toBe(500)
    expect(high.gridSize).toBe(200)
  })

  it('falls back per key on wrong types and rounds integer fields', () => {
    const result = sanitizePreferences({
      stageWidth: 'wide',
      fps: 29.6,
      autosaveEnabled: 'yes',
      brushOpacity: 0.3333,
      gridSize: 20.4
    })
    expect(result.stageWidth).toBe(DEFAULT_PREFERENCES.stageWidth)
    expect(result.fps).toBe(30)
    expect(result.autosaveEnabled).toBe(true)
    expect(result.brushOpacity).toBe(0.3333)
    expect(result.gridSize).toBe(20)
  })

  it('rejects NaN and Infinity', () => {
    const result = sanitizePreferences({ stageWidth: NaN, fps: Infinity, undoDepth: -Infinity })
    expect(result.stageWidth).toBe(DEFAULT_PREFERENCES.stageWidth)
    expect(result.fps).toBe(DEFAULT_PREFERENCES.fps)
    expect(result.undoDepth).toBe(DEFAULT_PREFERENCES.undoDepth)
  })

  it('uses the given base for partial merges', () => {
    const base = { ...DEFAULT_PREFERENCES, stageWidth: 1280, gridSize: 48 }
    const merged = sanitizePreferences({ fps: 12 }, base)
    expect(merged.stageWidth).toBe(1280)
    expect(merged.gridSize).toBe(48)
    expect(merged.fps).toBe(12)
  })
})

describe('mergePreferences', () => {
  it('merges a partial patch over the base and sanitizes it', () => {
    const base = { ...DEFAULT_PREFERENCES, stageWidth: 1280 }
    const merged = mergePreferences(base, { gridSize: 9999, autosaveEnabled: false, junk: 1 })
    expect(merged.stageWidth).toBe(1280)
    expect(merged.gridSize).toBe(200)
    expect(merged.autosaveEnabled).toBe(false)
    expect(merged.fps).toBe(DEFAULT_PREFERENCES.fps)
  })

  it('ignores non-object patches', () => {
    const base = { ...DEFAULT_PREFERENCES, undoDepth: 123 }
    expect(mergePreferences(base, null)).toEqual(base)
    expect(mergePreferences(base, 'x')).toEqual(base)
  })
})
