import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { app, dialog, ipcMain } from 'electron'

import { PALETTE_GET_CHANNEL, PALETTE_IMPORT_CHANNEL, PALETTE_SET_CHANNEL } from '../shared/api'
import type { PaletteImportResult } from '../shared/api'
import { normalizePaletteColors } from '../shared/document'

const PALETTE_VERSION = 1

/**
 * Persistent global color palette ("My palette"): a small JSON file in the
 * application's user-data directory, so swatches survive across documents
 * and sessions. Colors are validated, normalized and capped on both read
 * and write; a missing or corrupted file reads as an empty palette.
 */
export class PaletteStore {
  private readonly filePath: string

  constructor(baseDir: string) {
    this.filePath = join(baseDir, 'palette.json')
  }

  async load(): Promise<string[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return []
      const colors = (parsed as { colors?: unknown }).colors
      return Array.isArray(colors) ? normalizePaletteColors(colors as string[]) : []
    } catch {
      return []
    }
  }

  async save(colors: string[]): Promise<boolean> {
    const normalized = normalizePaletteColors(colors)
    await mkdir(dirname(this.filePath), { recursive: true })
    const payload = JSON.stringify({ version: PALETTE_VERSION, colors: normalized }, null, 2)
    const tempPath = `${this.filePath}.tmp`
    await writeFile(tempPath, payload, 'utf8')
    await rename(tempPath, this.filePath)
    return true
  }
}

/** The dialog and file system surface of the palette import (injectable for
 * tests; the handler passes Electron's dialog and `fs.readFile`). */
export interface PaletteImportDeps {
  showOpenDialog(options: {
    title: string
    filters: Array<{ name: string; extensions: string[] }>
    properties: ['openFile']
  }): Promise<{ canceled: boolean; filePaths: string[] }>
  readFile(path: string, encoding: 'utf8'): Promise<string>
}

/** Asks for a GIMP palette (`.gpl`) file and reads it as UTF-8 text;
 * cancellation and read failures both come back as `{ canceled: true }`. */
export async function importPaletteFile(deps: PaletteImportDeps): Promise<PaletteImportResult> {
  const result = await deps.showOpenDialog({
    title: 'Import GIMP palette',
    filters: [{ name: 'GIMP palette', extensions: ['gpl'] }],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return { canceled: true }
  const path = result.filePaths[0]
  try {
    const text = await deps.readFile(path, 'utf8')
    return { canceled: false, fileName: path.split(/[\\/]/).pop() ?? path, text }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { canceled: true, error: `Could not read the palette file: ${message}` }
  }
}

/** Registers the IPC handlers for the persistent global palette, backed by a
 * store in the application's user-data directory, plus the `.gpl` import
 * dialog. */
export function registerPaletteHandlers(): void {
  const store = new PaletteStore(app.getPath('userData'))
  ipcMain.handle(PALETTE_GET_CHANNEL, (): Promise<string[]> => store.load())
  ipcMain.handle(
    PALETTE_SET_CHANNEL,
    (_event, colors: string[]): Promise<boolean> => store.save(colors)
  )
  ipcMain.handle(PALETTE_IMPORT_CHANNEL, (): Promise<PaletteImportResult> =>
    importPaletteFile({
      showOpenDialog: (options) => dialog.showOpenDialog(options),
      readFile: (path, encoding) => readFile(path, encoding)
    })
  )
}
