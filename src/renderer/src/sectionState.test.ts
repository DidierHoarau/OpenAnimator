import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SECTION_STATE,
  LIBRARY_STORAGE_KEY,
  SECTION_STORAGE_KEY,
  loadLibraryVisible,
  loadSectionState,
  saveLibraryVisible,
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
    expect(state).toEqual({
      layer: true,
      shape: true,
      path: true,
      text: true,
      image: true,
      group: true,
      symbol: true,
      draw: true,
      cell: true,
      palette: true
    })
  })

  it('round-trips collapsed sections through storage', () => {
    const storage = new MemoryStorage()
    const state: SectionState = {
      layer: false,
      shape: true,
      path: false,
      text: true,
      image: true,
      group: false,
      symbol: true,
      draw: false,
      cell: true,
      palette: false
    }
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
      shape: true,
      path: true,
      text: true,
      image: true,
      group: true,
      symbol: true,
      draw: true,
      cell: true,
      palette: true
    })
  })

  it('falls back to defaults for non-object payloads', () => {
    const storage = new MemoryStorage()
    storage.setItem(SECTION_STORAGE_KEY, JSON.stringify([false, true]))
    expect(loadSectionState(storage)).toEqual(DEFAULT_SECTION_STATE)
  })
})

describe('library panel visibility', () => {
  it('is hidden by default and round-trips through storage', () => {
    const storage = new MemoryStorage()
    expect(loadLibraryVisible(storage)).toBe(false)
    saveLibraryVisible(storage, true)
    expect(storage.getItem(LIBRARY_STORAGE_KEY)).toBe('true')
    expect(loadLibraryVisible(storage)).toBe(true)
    saveLibraryVisible(storage, false)
    expect(loadLibraryVisible(storage)).toBe(false)
  })

  it('treats junk values as hidden', () => {
    const storage = new MemoryStorage()
    storage.setItem(LIBRARY_STORAGE_KEY, 'yes')
    expect(loadLibraryVisible(storage)).toBe(false)
  })
})
