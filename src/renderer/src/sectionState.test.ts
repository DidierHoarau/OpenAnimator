import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SECTION_STATE,
  SECTION_STORAGE_KEY,
  loadSectionState,
  saveSectionState,
  type SectionState
} from './sectionState'

class MemoryStorage {
  private readonly entries = new Map<string, string>()

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value)
  }
}

describe('section state', () => {
  it('defaults to all sections expanded when nothing is stored', () => {
    const state = loadSectionState(new MemoryStorage())
    expect(state).toEqual({ layer: true, shape: true })
  })

  it('round-trips collapsed sections through storage', () => {
    const storage = new MemoryStorage()
    const state: SectionState = { layer: false, shape: true }
    saveSectionState(storage, state)
    expect(storage.getItem(SECTION_STORAGE_KEY)).toBe(JSON.stringify(state))
    expect(loadSectionState(storage)).toEqual(state)
  })

  it('falls back to defaults on corrupted JSON', () => {
    const storage = new MemoryStorage()
    storage.setItem(SECTION_STORAGE_KEY, '{not json')
    expect(loadSectionState(storage)).toEqual(DEFAULT_SECTION_STATE)
  })

  it('ignores entries of the wrong type and keeps valid ones', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      SECTION_STORAGE_KEY,
      JSON.stringify({ layer: 'yes', playback: 1, shape: true, unknown: false })
    )
    // The stored `playback` key belongs to a removed section and is ignored.
    expect(loadSectionState(storage)).toEqual({
      layer: true,
      shape: true
    })
  })

  it('falls back to defaults for non-object payloads', () => {
    const storage = new MemoryStorage()
    storage.setItem(SECTION_STORAGE_KEY, JSON.stringify([false, true]))
    expect(loadSectionState(storage)).toEqual(DEFAULT_SECTION_STATE)
  })
})
