import { rename, writeFile } from 'node:fs/promises'

import { dialog, ipcMain } from 'electron'

import { EXPORT_PICK_PATH_CHANNEL, EXPORT_WRITE_CHANNEL } from '../shared/api'
import type { ExportPathRequest, ExportWriteResult, SaveAsResult } from '../shared/api'

/** Registers the IPC handlers for the export pipeline: the destination save
 * dialog and the atomic write of the rendered bytes. */
export function registerExportHandlers(): void {
  ipcMain.handle(
    EXPORT_PICK_PATH_CHANNEL,
    async (_event, request: ExportPathRequest): Promise<SaveAsResult> => {
      const result = await dialog.showSaveDialog({
        title: 'Export animation',
        filters: request.filters,
        defaultPath: request.defaultName
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      return { canceled: false, path: result.filePath }
    }
  )

  ipcMain.handle(
    EXPORT_WRITE_CHANNEL,
    async (_event, path: string, bytes: Uint8Array): Promise<ExportWriteResult> => {
      try {
        // Written to a temp file first, then renamed, so a failed export
        // never leaves a truncated file behind.
        const tempPath = `${path}.tmp`
        await writeFile(tempPath, bytes)
        await rename(tempPath, path)
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: message }
      }
    }
  )
}
