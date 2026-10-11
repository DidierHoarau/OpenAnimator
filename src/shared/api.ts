/** IPC channel used by the renderer to fetch application information. */
export const APP_API_CHANNEL = 'openanimator:app-info'

import type { AnimatorDocument, Asset } from './model'

export const DOCUMENT_SAVE_AS_CHANNEL = 'openanimator:document-save-as'
export const DOCUMENT_SAVE_TO_CHANNEL = 'openanimator:document-save-to'
export const DOCUMENT_OPEN_DIALOG_CHANNEL = 'openanimator:document-open-dialog'
export const DOCUMENT_READ_CHANNEL = 'openanimator:document-read'
export const RECENT_LIST_CHANNEL = 'openanimator:recent-list'
export const RECENT_ADD_CHANNEL = 'openanimator:recent-add'
export const IMAGE_PICK_CHANNEL = 'openanimator:image-pick'
export const RESOURCE_ADD_CHANNEL = 'openanimator:resource-add'
export const RESOURCE_PURGE_CHANNEL = 'openanimator:resource-purge'
export const RESOURCE_RESET_CHANNEL = 'openanimator:resource-reset'
export const LIBRARY_LIST_CHANNEL = 'openanimator:library-list'
export const LIBRARY_ADD_CHANNEL = 'openanimator:library-add'
export const LIBRARY_REMOVE_CHANNEL = 'openanimator:library-remove'
export const LIBRARY_RENAME_CHANNEL = 'openanimator:library-rename'

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
  | {
      canceled: false
      path: string
      document: AnimatorDocument | null
      error: string | null
      /** Binary resources referenced by the document, keyed by content digest. */
      resources: Record<string, Uint8Array>
    }

export type ReadResult =
  | { ok: true; document: AnimatorDocument; resources: Record<string, Uint8Array> }
  | { ok: false; error: string }

export type ImagePickResult =
  | { canceled: true }
  | { canceled: false; fileName: string; bytes: Uint8Array }

export type ResourceAddResult = { resourceId: string; deduped: boolean }

export type ResourcePurgeResult = { removed: number }

export interface RecentProject {
  path: string
  name: string
  lastOpenedAt: number
}

/** Binary resource of the global library, with its encoded-file extension. */
export interface LibraryResource {
  bytes: Uint8Array
  ext: string
}

/** Contents of the global "My Library": asset index plus every referenced
 * resource's bytes (keyed by content digest). */
export interface LibraryListResult {
  assets: Asset[]
  resources: Record<string, LibraryResource>
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
  pickImageFile(title?: string): Promise<ImagePickResult>
  addResource(bytes: Uint8Array, fileName: string): Promise<ResourceAddResult>
  purgeUnusedResources(document: AnimatorDocument): Promise<ResourcePurgeResult>
  resetResourceStore(): Promise<void>
  listLibrary(): Promise<LibraryListResult>
  addLibraryAsset(asset: Asset, contextAssets?: Asset[]): Promise<void>
  removeLibraryAsset(id: string): Promise<void>
  renameLibraryAsset(id: string, name: string): Promise<void>
}
