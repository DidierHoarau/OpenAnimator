import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { app, ipcMain } from 'electron'

import { EXPORT_PRESETS_GET_CHANNEL, EXPORT_PRESETS_SET_CHANNEL } from '../shared/api'
import type { ExportPresetsData } from '../shared/exportPresets'
import {
  emptyExportPresets,
  sanitizeExportPresetsData
} from '../shared/exportPresets'

/**
 * Persistent export presets ("named option sets" plus the last-used options):
 * a small JSON file in the application's user-data directory, so named
 * exports survive across documents and sessions. Data is validated and capped
 * through the shared sanitizer on both read and write; a missing or corrupted
 * file reads as an empty preset set.
 */
export class ExportPresetsStore {
  private readonly filePath: string

  constructor(baseDir: string) {
    this.filePath = join(baseDir, 'export-presets.json')
  }

  async load(): Promise<ExportPresetsData> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      return sanitizeExportPresetsData(JSON.parse(raw))
    } catch {
      return emptyExportPresets()
    }
  }

  async save(data: ExportPresetsData): Promise<boolean> {
    const sanitized = sanitizeExportPresetsData(data)
    await mkdir(dirname(this.filePath), { recursive: true })
    const payload = JSON.stringify(sanitized, null, 2)
    const tempPath = `${this.filePath}.tmp`
    await writeFile(tempPath, payload, 'utf8')
    await rename(tempPath, this.filePath)
    return true
  }
}

/** Registers the IPC handlers for the persistent export presets store. */
export function registerExportPresetsHandlers(): void {
  const store = new ExportPresetsStore(app.getPath('userData'))
  ipcMain.handle(EXPORT_PRESETS_GET_CHANNEL, (): Promise<ExportPresetsData> => store.load())
  ipcMain.handle(
    EXPORT_PRESETS_SET_CHANNEL,
    (_event, data: ExportPresetsData): Promise<boolean> => store.save(data)
  )
}
