import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_PREFERENCES } from '../shared/preferences'
import { PreferencesStore } from './preferences'

describe('PreferencesStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-prefs-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads the defaults when no file exists', async () => {
    const store = new PreferencesStore(dir)
    await expect(store.load()).resolves.toEqual(DEFAULT_PREFERENCES)
  })

  it('round-trips preferences through save/load', async () => {
    const store = new PreferencesStore(dir)
    const stored = await store.save({ ...DEFAULT_PREFERENCES, gridSize: 48, autosaveEnabled: false })
    expect(stored.gridSize).toBe(48)
    await expect(store.load()).resolves.toEqual({ ...DEFAULT_PREFERENCES, gridSize: 48, autosaveEnabled: false })
  })

  it('sanitizes on write and on read', async () => {
    const store = new PreferencesStore(dir)
    const stored = await store.save({ ...DEFAULT_PREFERENCES, undoDepth: 99999 })
    expect(stored.undoDepth).toBe(500)
    // A hand-edited corrupt file degrades to defaults per key.
    await writeFile(join(dir, 'preferences.json'), '{"gridSize": "big", "fps": 12}', 'utf8')
    const loaded = await store.load()
    expect(loaded.gridSize).toBe(DEFAULT_PREFERENCES.gridSize)
    expect(loaded.fps).toBe(12)
  })

  it('reads the defaults from a corrupted file', async () => {
    const store = new PreferencesStore(dir)
    await writeFile(join(dir, 'preferences.json'), 'not json at all', 'utf8')
    await expect(store.load()).resolves.toEqual(DEFAULT_PREFERENCES)
  })

  it('writes valid JSON with a trailing newline and no temp file left', async () => {
    const store = new PreferencesStore(dir)
    await store.save(DEFAULT_PREFERENCES)
    const raw = await readFile(join(dir, 'preferences.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual(DEFAULT_PREFERENCES)
    await expect(readFile(join(dir, 'preferences.json.tmp'), 'utf8')).rejects.toThrow()
  })
})
