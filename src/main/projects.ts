import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app, dialog, ipcMain } from 'electron'

import {
  DOCUMENT_OPEN_DIALOG_CHANNEL,
  DOCUMENT_READ_CHANNEL,
  DOCUMENT_SAVE_AS_CHANNEL,
  DOCUMENT_SAVE_TO_CHANNEL,
  RECENT_ADD_CHANNEL,
  RECENT_LIST_CHANNEL
} from '../shared/api'
import type {
  OpenDialogResult,
  ReadResult,
  RecentProject,
  SaveAsResult,
  SaveToResult
} from '../shared/api'
import { isAnimatorDocument } from '../shared/document'
import type { AnimatorDocument } from '../shared/model'
import { mergeRecentProject } from '../shared/recentProjects'

const PROJECT_FILE_FILTERS = [{ name: 'OpenAnimator project', extensions: ['oanim', 'json'] }]
const MAX_PROJECT_FILE_SIZE = 10 * 1024 * 1024

function recentStorePath(): string {
  return join(app.getPath('userData'), 'recent-projects.json')
}

function isRecentProject(value: unknown): value is RecentProject {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RecentProject>
  return (
    typeof candidate.path === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.lastOpenedAt === 'number'
  )
}

async function readRecentProjects(): Promise<RecentProject[]> {
  try {
    const raw = await readFile(recentStorePath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isRecentProject) : []
  } catch {
    return []
  }
}

function defaultFileName(name: string): string {
  const cleaned = name.replace(/[/\\?%*:|"<>.]/g, '-').trim()
  return `${cleaned || 'Untitled'}.oanim`
}

async function readProjectFile(
  path: string
): Promise<{ document: AnimatorDocument | null; error: string | null }> {
  try {
    const info = await stat(path)
    if (info.size > MAX_PROJECT_FILE_SIZE) {
      return { document: null, error: 'The file is too large (10 MB max).' }
    }
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isAnimatorDocument(parsed)) {
      return { document: null, error: 'This file is not a valid OpenAnimator project.' }
    }
    return { document: parsed, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { document: null, error: `Could not read the project file: ${message}` }
  }
}

/** Registers the IPC handlers for project files and the recent-projects store. */
export function registerProjectHandlers(): void {
  ipcMain.handle(DOCUMENT_SAVE_AS_CHANNEL, async (_event, document: AnimatorDocument): Promise<SaveAsResult> => {
    const result = await dialog.showSaveDialog({
      title: 'Save project as',
      filters: PROJECT_FILE_FILTERS,
      defaultPath: defaultFileName(document.name)
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      await writeFile(result.filePath, JSON.stringify(document, null, 2), 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      dialog.showErrorBox('Save failed', `Could not write the project file: ${message}`)
      return { canceled: true }
    }
    return { canceled: false, path: result.filePath }
  })

  ipcMain.handle(
    DOCUMENT_SAVE_TO_CHANNEL,
    async (_event, path: string, document: AnimatorDocument): Promise<SaveToResult> => {
      try {
        await writeFile(path, JSON.stringify(document, null, 2), 'utf8')
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: message }
      }
    }
  )

  ipcMain.handle(DOCUMENT_OPEN_DIALOG_CHANNEL, async (): Promise<OpenDialogResult> => {
    const result = await dialog.showOpenDialog({
      title: 'Open project',
      filters: PROJECT_FILE_FILTERS,
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    const path = result.filePaths[0]
    const { document, error } = await readProjectFile(path)
    return { canceled: false, path, document, error }
  })

  ipcMain.handle(DOCUMENT_READ_CHANNEL, async (_event, path: string): Promise<ReadResult> => {
    const { document, error } = await readProjectFile(path)
    if (error || !document) return { ok: false, error: error ?? 'Unknown error' }
    return { ok: true, document }
  })

  ipcMain.handle(RECENT_LIST_CHANNEL, (): Promise<RecentProject[]> => readRecentProjects())

  ipcMain.handle(
    RECENT_ADD_CHANNEL,
    async (_event, path: string, name: string): Promise<RecentProject[]> => {
      const updated = mergeRecentProject(await readRecentProjects(), path, name, Date.now())
      try {
        await writeFile(recentStorePath(), JSON.stringify(updated, null, 2), 'utf8')
      } catch (error) {
        console.warn('OpenAnimator: failed to persist the recent projects list', error)
      }
      return updated
    }
  )
}
