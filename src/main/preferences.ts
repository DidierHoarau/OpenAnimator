import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { app, ipcMain } from 'electron'

import { PREFERENCES_GET_CHANNEL, PREFERENCES_SET_CHANNEL } from '../shared/api'
import { DEFAULT_PREFERENCES, sanitizePreferences } from '../shared/preferences'
import type { AppPreferences } from '../shared/preferences'

/**
 * Persistent application preferences: a small JSON file in the application's
 * user-data directory, written atomically (temp + rename). Reads sanitize the
 * file through the shared pure `sanitizePreferences`, so a corrupted or
 * outdated file degrades to per-key defaults instead of breaking the editor.
 */
export class PreferencesStore {
  private readonly filePath: string

  constructor(baseDir: string) {
    this.filePath = join(baseDir, 'preferences.json')
  }

  async load(): Promise<AppPreferences> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      return sanitizePreferences(JSON.parse(raw))
    } catch {
      return { ...DEFAULT_PREFERENCES }
    }
  }

  async save(preferences: unknown): Promise<AppPreferences> {
    const sanitized = sanitizePreferences(preferences)
    await mkdir(dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.tmp`
    await writeFile(tempPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8')
    await rename(tempPath, this.filePath)
    return sanitized
  }
}

/** Registers the IPC handlers for the persistent preferences, backed by a
 * store in the application's user-data directory. */
export function registerPreferencesHandlers(): void {
  const store = new PreferencesStore(app.getPath('userData'))
  ipcMain.handle(PREFERENCES_GET_CHANNEL, (): Promise<AppPreferences> => store.load())
  ipcMain.handle(
    PREFERENCES_SET_CHANNEL,
    (_event, preferences: unknown): Promise<AppPreferences> => store.save(preferences)
  )
}
