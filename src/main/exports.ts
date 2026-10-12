import { randomUUID } from 'node:crypto'
import { open, rename, unlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

import { dialog, ipcMain } from 'electron'

import {
  EXPORT_PICK_PATH_CHANNEL,
  EXPORT_STREAM_COMMIT_CHANNEL,
  EXPORT_STREAM_OPEN_CHANNEL,
  EXPORT_STREAM_WRITE_CHANNEL,
  EXPORT_WRITE_CHANNEL
} from '../shared/api'
import type {
  ExportPathRequest,
  ExportStreamOpenResult,
  ExportWriteResult,
  SaveAsResult
} from '../shared/api'

interface ExportStreamSession {
  handle: FileHandle
  tempPath: string
  destPath: string
}

/** Staged export writes in flight, keyed by the token handed to the renderer. */
const streamSessions = new Map<string, ExportStreamSession>()

/** Registers the IPC handlers for the export pipeline: the destination save
 * dialog, the atomic one-shot write, and the staged streaming write used by
 * the archive formats. */
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
        await writeFile(`${path}.tmp`, bytes)
        await rename(`${path}.tmp`, path)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    }
  )

  ipcMain.handle(
    EXPORT_STREAM_OPEN_CHANNEL,
    (_event, path: string): Promise<ExportStreamOpenResult> => openExportStream(path)
  )
  ipcMain.handle(
    EXPORT_STREAM_WRITE_CHANNEL,
    (_event, token: string, chunk: Uint8Array): Promise<ExportWriteResult> =>
      writeExportStream(token, chunk)
  )
  ipcMain.handle(
    EXPORT_STREAM_COMMIT_CHANNEL,
    (_event, token: string, commit: boolean): Promise<ExportWriteResult> =>
      commitExportStream(token, commit)
  )
}

/** Opens a staged write: bytes land in `<dest>.tmp` until committed. */
export async function openExportStream(path: string): Promise<ExportStreamOpenResult> {
  const tempPath = `${path}.tmp`
  try {
    const handle = await open(tempPath, 'w')
    const token = randomUUID()
    streamSessions.set(token, { handle, tempPath, destPath: path })
    return { ok: true, token }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/** Appends one chunk to a staged write. */
export async function writeExportStream(
  token: string,
  chunk: Uint8Array
): Promise<ExportWriteResult> {
  const session = streamSessions.get(token)
  if (!session) return { ok: false, error: 'Export stream is no longer open' }
  try {
    let offset = 0
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await session.handle.write(
        chunk,
        offset,
        chunk.byteLength - offset
      )
      if (bytesWritten <= 0) throw new Error('Export stream write made no progress')
      offset += bytesWritten
    }
    return { ok: true }
  } catch (error) {
    streamSessions.delete(token)
    await discardSession(session)
    return { ok: false, error: errorMessage(error) }
  }
}

/** Finishes a staged write: `commit` renames the temp onto the destination,
 * abort removes the temp. The destination is only ever created on commit. */
export async function commitExportStream(
  token: string,
  commit: boolean
): Promise<ExportWriteResult> {
  const session = streamSessions.get(token)
  if (!session) return { ok: false, error: 'Export stream is no longer open' }
  streamSessions.delete(token)
  try {
    await session.handle.close()
  } catch (error) {
    await unlink(session.tempPath).catch(() => undefined)
    return { ok: false, error: errorMessage(error) }
  }
  if (!commit) {
    await unlink(session.tempPath).catch(() => undefined)
    return { ok: true }
  }
  try {
    await rename(session.tempPath, session.destPath)
    return { ok: true }
  } catch (error) {
    await unlink(session.tempPath).catch(() => undefined)
    return { ok: false, error: errorMessage(error) }
  }
}

/** Closes and removes every staged export temp still open. Called on window
 * teardown so an interrupted session cannot leave `.tmp` files behind. */
export async function abortStagedExports(): Promise<void> {
  const sessions = [...streamSessions.values()]
  streamSessions.clear()
  await Promise.all(sessions.map((session) => discardSession(session)))
}

async function discardSession(session: ExportStreamSession): Promise<void> {
  await session.handle.close().catch(() => undefined)
  await unlink(session.tempPath).catch(() => undefined)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
