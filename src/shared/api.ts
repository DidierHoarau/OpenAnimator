/** IPC channel used by the renderer to fetch application information. */
export const APP_API_CHANNEL = 'openanimator:app-info'

/** IPC channel used by the application menu to dispatch editor commands. */
export const APP_MENU_COMMAND_CHANNEL = 'openanimator:menu-command'

/** IPC channel telling the renderer a newer version is available. */
export const APP_UPDATE_AVAILABLE_CHANNEL = 'openanimator:update-available'

/** IPC channel asking the main process to open a release page in the browser. */
export const APP_OPEN_RELEASE_CHANNEL = 'openanimator:open-release'

/** IPC channel asking the main process to open an allowlisted https URL. */
export const APP_OPEN_EXTERNAL_CHANNEL = 'openanimator:open-external'

/** IPC channels reading and writing the persistent preferences file. */
export const PREFERENCES_GET_CHANNEL = 'openanimator:preferences-get'
export const PREFERENCES_SET_CHANNEL = 'openanimator:preferences-set'

/** IPC channel delivering a `.oanim` path to open (file association, launch
 * argument, second instance or macOS open-file event). */
export const APP_OPEN_FILE_CHANNEL = 'openanimator:open-file'

/** IPC channel asking the renderer whether the window may close (main→renderer). */
export const APP_CLOSE_REQUEST_CHANNEL = 'openanimator:close-request'

/** IPC channel answering a close request with `allow: boolean` (renderer→main). */
export const APP_CLOSE_RESPONSE_CHANNEL = 'openanimator:close-response'

import type { AnimatorDocument, Asset } from './model'
import type { FontEmbeddingPolicy } from './fontPolicy'
import type { AppPreferences } from './preferences'
import type { RecoveryInfo } from './recovery'
import type { ShortcutId } from './shortcuts'

export const DOCUMENT_SAVE_AS_CHANNEL = 'openanimator:document-save-as'
export const DOCUMENT_SAVE_TO_CHANNEL = 'openanimator:document-save-to'
export const DOCUMENT_OPEN_DIALOG_CHANNEL = 'openanimator:document-open-dialog'
export const DOCUMENT_READ_CHANNEL = 'openanimator:document-read'
export const RECENT_LIST_CHANNEL = 'openanimator:recent-list'
export const RECENT_ADD_CHANNEL = 'openanimator:recent-add'
export const IMAGE_PICK_CHANNEL = 'openanimator:image-pick'
export const AUDIO_PICK_CHANNEL = 'openanimator:audio-pick'
export const RESOURCE_ADD_CHANNEL = 'openanimator:resource-add'
export const RESOURCE_PURGE_CHANNEL = 'openanimator:resource-purge'
export const RESOURCE_RESET_CHANNEL = 'openanimator:resource-reset'
export const LIBRARY_LIST_CHANNEL = 'openanimator:library-list'
export const LIBRARY_ADD_CHANNEL = 'openanimator:library-add'
export const LIBRARY_REMOVE_CHANNEL = 'openanimator:library-remove'
export const LIBRARY_RENAME_CHANNEL = 'openanimator:library-rename'
export const EXPORT_PICK_PATH_CHANNEL = 'openanimator:export-pick-path'
export const EXPORT_WRITE_CHANNEL = 'openanimator:export-write'
export const EXPORT_STREAM_OPEN_CHANNEL = 'openanimator:export-stream-open'
export const EXPORT_STREAM_WRITE_CHANNEL = 'openanimator:export-stream-write'
export const EXPORT_STREAM_COMMIT_CHANNEL = 'openanimator:export-stream-commit'
export const PALETTE_GET_CHANNEL = 'openanimator:palette-get'
export const PALETTE_SET_CHANNEL = 'openanimator:palette-set'
export const FONT_LIST_CHANNEL = 'openanimator:font-list'
export const FONT_READ_CHANNEL = 'openanimator:font-read'
export const FONT_POLICY_CHANNEL = 'openanimator:font-policy'
export const RECOVERY_WRITE_CHANNEL = 'openanimator:recovery-write'
export const RECOVERY_CHECK_CHANNEL = 'openanimator:recovery-check'
export const RECOVERY_READ_CHANNEL = 'openanimator:recovery-read'
export const RECOVERY_CLEAR_CHANNEL = 'openanimator:recovery-clear'
export const RECOVERY_LIST_UNSAVED_CHANNEL = 'openanimator:recovery-list-unsaved'

export interface AppVersions {
  app: string
  electron: string
  chrome: string
  node: string
}

/** Result of a "pick a destination file" dialog: canceled, or a path. */
export type PickPathResult = { canceled: true } | { canceled: false; path: string }

/** Result of a Save As flow: canceled, a written path, or a write failure. */
export type SaveAsResult = PickPathResult | { canceled: false; error: string }

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
  | { canceled: true; error?: string }
  | { canceled: false; fileName: string; bytes: Uint8Array }

/** Audio files are picked through the same raw-bytes contract as images. */
export type AudioPickResult = ImagePickResult

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

/** Save-dialog request for an export destination file. */
export interface ExportPathRequest {
  defaultName: string
  /** Electron file filters, e.g. `[{ name: 'GIF', extensions: ['gif'] }]`. */
  filters: Array<{ name: string; extensions: string[] }>
}

export type ExportWriteResult = { ok: true } | { ok: false; error: string }

/** Open result of a staged export write; the token addresses the stream. */
export type ExportStreamOpenResult = { ok: true; token: string } | { ok: false; error: string }

/** One installed system font family, with its upright weights. */
export interface SystemFont {
  family: string
  /** Available CSS weights, ascending, deduplicated. */
  weights: number[]
}

export type FontReadResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string }

/** Commands the application menu dispatches into the renderer: the full
 * shortcut-table id union, so menu, keyboard, cheat sheet and docs share one
 * namespace (`src/shared/shortcuts.ts`). */
export type MenuCommand = ShortcutId

/** Result of asking the main process to open an external URL. */
export type OpenExternalResult = { ok: true } | { ok: false; error: string }

/** Payload of the update-available notification. */
export interface UpdateAvailableInfo {
  version: string
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
  pickAudioFile(title?: string): Promise<AudioPickResult>
  addResource(bytes: Uint8Array, fileName: string): Promise<ResourceAddResult>
  purgeUnusedResources(document: AnimatorDocument): Promise<ResourcePurgeResult>
  resetResourceStore(): Promise<void>
  listLibrary(): Promise<LibraryListResult>
  addLibraryAsset(asset: Asset, contextAssets?: Asset[]): Promise<void>
  removeLibraryAsset(id: string): Promise<void>
  renameLibraryAsset(id: string, name: string): Promise<void>
  /** Asks the user for an export destination through a save dialog. */
  pickExportPath(request: ExportPathRequest): Promise<PickPathResult>
  /** Writes rendered export bytes to the chosen destination. */
  writeExportFile(path: string, bytes: Uint8Array): Promise<ExportWriteResult>
  /** Opens a staged export write: chunks go to `<path>.tmp` until commit. */
  openExportStream(path: string): Promise<ExportStreamOpenResult>
  /** Appends one chunk to a staged export write. */
  writeExportStream(token: string, chunk: Uint8Array): Promise<ExportWriteResult>
  /** Commits (atomic rename) or aborts (delete the temp) a staged write. */
  finishExportStream(token: string, commit: boolean): Promise<ExportWriteResult>
  /** Reads the persistent global color palette. */
  loadGlobalPalette(): Promise<string[]>
  /** Replaces the persistent global color palette. */
  saveGlobalPalette(colors: string[]): Promise<boolean>
  /** Lists installed system font families and their available weights. */
  listSystemFonts(): Promise<SystemFont[]>
  /** Reads the installed face nearest to (family, weight) as raw font bytes. */
  readSystemFont(family: string, weight: number): Promise<FontReadResult>
  /** Reads the effective font embedding policy (built-ins plus user rules). */
  getFontEmbeddingPolicy(): Promise<FontEmbeddingPolicy>
  /** Opens the GitHub release page of the given version in the browser. */
  openReleasePage(version: string): Promise<void>
  /** Opens an external URL in the browser; the main process only allows
   * `https:` URLs on its host allowlist (docs site, GitHub). */
  openExternal(url: string): Promise<OpenExternalResult>
  /** Reads the persistent application preferences (sanitized; defaults when
   * no preferences file exists yet). */
  getPreferences(): Promise<AppPreferences>
  /** Persists application preferences (sanitized and clamped by the main
   * process); resolves with the stored value. */
  savePreferences(preferences: AppPreferences): Promise<AppPreferences>
  /** Listens for application-menu commands; returns an unsubscribe function. */
  onMenuCommand(listener: (command: MenuCommand) => void): () => void
  /** Listens for update-available notifications (packaged builds); returns an
   * unsubscribe function. */
  onUpdateAvailable(listener: (info: UpdateAvailableInfo) => void): () => void
  /** Listens for `.oanim` paths to open; returns an unsubscribe function. */
  onOpenFile(listener: (path: string) => void): () => void
  /** Listens for window-close requests; returns an unsubscribe function. */
  onCloseRequest(listener: () => void): () => void
  /** Answers the latest close request: `allow` closes the window or quits. */
  respondToCloseRequest(allow: boolean): Promise<void>
  /** Writes an autosave recovery snapshot of the document. `path` is the
   * project path, or a session key for a never-saved document. */
  writeRecovery(path: string, document: AnimatorDocument, untitled: boolean): Promise<SaveToResult>
  /** Pending recovery snapshot for the project, when newer than the file. */
  checkRecovery(path: string): Promise<RecoveryInfo | null>
  /** Untitled-document recovery snapshots, newest first. */
  listUnsavedRecoveries(): Promise<RecoveryInfo[]>
  /** Reads the recovery snapshot of the project. */
  readRecovery(path: string): Promise<ReadResult>
  /** Deletes the recovery snapshot of the project. */
  clearRecovery(path: string): Promise<void>
}
