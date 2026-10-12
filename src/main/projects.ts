import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app, dialog, ipcMain } from 'electron'

import {
  AUDIO_PICK_CHANNEL,
  DOCUMENT_OPEN_DIALOG_CHANNEL,
  DOCUMENT_READ_CHANNEL,
  DOCUMENT_SAVE_AS_CHANNEL,
  DOCUMENT_SAVE_TO_CHANNEL,
  IMAGE_PICK_CHANNEL,
  RECENT_ADD_CHANNEL,
  RECENT_LIST_CHANNEL,
  RESOURCE_ADD_CHANNEL,
  RESOURCE_PURGE_CHANNEL,
  RESOURCE_RESET_CHANNEL
} from '../shared/api'
import type {
  AudioPickResult,
  ImagePickResult,
  OpenDialogResult,
  ReadResult,
  RecentProject,
  ResourceAddResult,
  ResourcePurgeResult,
  SaveAsResult,
  SaveToResult
} from '../shared/api'
import { MigrationError, migrateDocument } from '../shared/migrate'
import type { AnimatorDocument } from '../shared/model'
import { mergeRecentProject } from '../shared/recentProjects'
import { isZipContainer, packProject, parseProject } from './projectContainer'
import type { ProjectResourceMap } from './projectContainer'
import { extensionOf, resourceStore } from './resources'

const PROJECT_FILE_FILTERS = [{ name: 'OpenAnimator project', extensions: ['oanim', 'json'] }]
const MAX_PROJECT_FILE_SIZE = 200 * 1024 * 1024

const IMAGE_FILE_FILTERS = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }
]

const AUDIO_FILE_FILTERS = [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg'] }]

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

function resourcesToRecord(resources: ProjectResourceMap): Record<string, Uint8Array> {
  const record: Record<string, Uint8Array> = {}
  for (const [resourceId, resource] of resources) record[resourceId] = resource.bytes
  return record
}

async function readProjectFile(
  path: string
): Promise<{ document: AnimatorDocument | null; resources: ProjectResourceMap; error: string | null }> {
  try {
    const info = await stat(path)
    if (info.size > MAX_PROJECT_FILE_SIZE) {
      return { document: null, resources: new Map(), error: 'The file is too large (200 MB max).' }
    }
    const bytes = await readFile(path)
    try {
      if (isZipContainer(bytes)) {
        const parsed = parseProject(bytes)
        return { document: parsed.document, resources: parsed.resources, error: null }
      }
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
      return { document: migrateDocument(parsed), resources: new Map(), error: null }
    } catch (error) {
      if (error instanceof MigrationError) {
        return {
          document: null,
          resources: new Map(),
          error: `This file is not a valid OpenAnimator project. ${error.message}`
        }
      }
      throw error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { document: null, resources: new Map(), error: `Could not read the project file: ${message}` }
  }
}

/** Serializes the document with its referenced resources and writes it
 * atomically: the container is written to a temp file first, then renamed. */
async function writeProjectFile(path: string, document: AnimatorDocument): Promise<void> {
  const bytes = packProject(document, resourceStore.all())
  const tempPath = `${path}.tmp`
  await writeFile(tempPath, bytes)
  await rename(tempPath, path)
}

/** Registers the IPC handlers for project files, resources and the
 * recent-projects store. */
export function registerProjectHandlers(): void {
  ipcMain.handle(DOCUMENT_SAVE_AS_CHANNEL, async (_event, document: AnimatorDocument): Promise<SaveAsResult> => {
    const result = await dialog.showSaveDialog({
      title: 'Save project as',
      filters: PROJECT_FILE_FILTERS,
      defaultPath: defaultFileName(document.name)
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      await writeProjectFile(result.filePath, document)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { canceled: false, error: message }
    }
    return { canceled: false, path: result.filePath }
  })

  ipcMain.handle(
    DOCUMENT_SAVE_TO_CHANNEL,
    async (_event, path: string, document: AnimatorDocument): Promise<SaveToResult> => {
      try {
        await writeProjectFile(path, document)
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
    const { document, resources, error } = await readProjectFile(path)
    if (document) resourceStore.reset(resources)
    return {
      canceled: false,
      path,
      document,
      error,
      resources: document ? resourcesToRecord(resources) : {}
    }
  })

  ipcMain.handle(DOCUMENT_READ_CHANNEL, async (_event, path: string): Promise<ReadResult> => {
    const { document, resources, error } = await readProjectFile(path)
    if (error || !document) return { ok: false, error: error ?? 'Unknown error' }
    resourceStore.reset(resources)
    return { ok: true, document, resources: resourcesToRecord(resources) }
  })

  ipcMain.handle(
    IMAGE_PICK_CHANNEL,
    async (_event, title: string): Promise<ImagePickResult> => {
      const result = await dialog.showOpenDialog({
        title,
        filters: IMAGE_FILE_FILTERS,
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) return { canceled: true }
      const path = result.filePaths[0]
      try {
        const bytes = await readFile(path)
        const fileName = path.split(/[\\/]/).pop() ?? path
        return { canceled: false, fileName, bytes: new Uint8Array(bytes) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { canceled: true, error: `Could not read the image file: ${message}` }
      }
    }
  )

  ipcMain.handle(
    AUDIO_PICK_CHANNEL,
    async (_event, title: string): Promise<AudioPickResult> => {
      const result = await dialog.showOpenDialog({
        title,
        filters: AUDIO_FILE_FILTERS,
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) return { canceled: true }
      const path = result.filePaths[0]
      try {
        const bytes = await readFile(path)
        const fileName = path.split(/[\\/]/).pop() ?? path
        return { canceled: false, fileName, bytes: new Uint8Array(bytes) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { canceled: true, error: `Could not read the audio file: ${message}` }
      }
    }
  )

  ipcMain.handle(
    RESOURCE_ADD_CHANNEL,
    async (_event, bytes: Uint8Array, fileName: string): Promise<ResourceAddResult> => {
      return resourceStore.add(new Uint8Array(bytes), extensionOf(fileName))
    }
  )

  ipcMain.handle(
    RESOURCE_PURGE_CHANNEL,
    async (_event, document: AnimatorDocument): Promise<ResourcePurgeResult> => {
      return { removed: resourceStore.purgeUnused(document) }
    }
  )

  ipcMain.handle(RESOURCE_RESET_CHANNEL, (): void => {
    resourceStore.reset(new Map())
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
