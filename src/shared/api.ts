/** IPC channel used by the renderer to fetch application information. */
export const APP_API_CHANNEL = 'openanimator:app-info'

import type { AnimatorDocument } from './model'

export const DOCUMENT_SAVE_AS_CHANNEL = 'openanimator:document-save-as'
export const DOCUMENT_SAVE_TO_CHANNEL = 'openanimator:document-save-to'
export const DOCUMENT_OPEN_DIALOG_CHANNEL = 'openanimator:document-open-dialog'
export const DOCUMENT_READ_CHANNEL = 'openanimator:document-read'
export const RECENT_LIST_CHANNEL = 'openanimator:recent-list'
export const RECENT_ADD_CHANNEL = 'openanimator:recent-add'

export interface AppVersions {
  app: string
  electron: string
  chrome: string
  node: string
}

export type SaveAsResult = { canceled: true } | { canceled: false; path: string }

export type SaveToResult = { ok: true } | { ok: false; error: string }

export type OpenDialogResult =
  | { canceled: true }
  | { canceled: false; path: string; document: AnimatorDocument | null; error: string | null }

export type ReadResult = { ok: true; document: AnimatorDocument } | { ok: false; error: string }

export interface RecentProject {
  path: string
  name: string
  lastOpenedAt: number
}

/** API exposed to the renderer through the preload script. */
export interface OpenAnimatorApi {
  versions(): Promise<AppVersions>
  saveProjectAs(document: AnimatorDocument): Promise<SaveAsResult>
  saveProjectTo(path: string, document: AnimatorDocument): Promise<SaveToResult>
  openProjectDialog(): Promise<OpenDialogResult>
  readProjectFile(path: string): Promise<ReadResult>
  getRecentProjects(): Promise<RecentProject[]>
  rememberProject(path: string, name: string): Promise<RecentProject[]>
}
