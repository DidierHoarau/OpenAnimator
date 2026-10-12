import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

import {
  APP_API_CHANNEL,
  APP_MENU_COMMAND_CHANNEL,
  DOCUMENT_OPEN_DIALOG_CHANNEL,
  DOCUMENT_READ_CHANNEL,
  DOCUMENT_SAVE_AS_CHANNEL,
  DOCUMENT_SAVE_TO_CHANNEL,
  EXPORT_PICK_PATH_CHANNEL,
  EXPORT_WRITE_CHANNEL,
  IMAGE_PICK_CHANNEL,
  LIBRARY_ADD_CHANNEL,
  LIBRARY_LIST_CHANNEL,
  LIBRARY_REMOVE_CHANNEL,
  LIBRARY_RENAME_CHANNEL,
  PALETTE_GET_CHANNEL,
  PALETTE_SET_CHANNEL,
  RECENT_ADD_CHANNEL,
  RECENT_LIST_CHANNEL,
  RESOURCE_ADD_CHANNEL,
  RESOURCE_PURGE_CHANNEL,
  RESOURCE_RESET_CHANNEL
} from '../shared/api'
import type { MenuCommand, OpenAnimatorApi } from '../shared/api'

const api: OpenAnimatorApi = {
  versions: () => ipcRenderer.invoke(APP_API_CHANNEL),
  saveProjectAs: (document) => ipcRenderer.invoke(DOCUMENT_SAVE_AS_CHANNEL, document),
  saveProjectTo: (path, document) => ipcRenderer.invoke(DOCUMENT_SAVE_TO_CHANNEL, path, document),
  openProjectDialog: () => ipcRenderer.invoke(DOCUMENT_OPEN_DIALOG_CHANNEL),
  readProjectFile: (path) => ipcRenderer.invoke(DOCUMENT_READ_CHANNEL, path),
  getRecentProjects: () => ipcRenderer.invoke(RECENT_LIST_CHANNEL),
  rememberProject: (path, name) => ipcRenderer.invoke(RECENT_ADD_CHANNEL, path, name),
  pickImageFile: (title) => ipcRenderer.invoke(IMAGE_PICK_CHANNEL, title),
  addResource: (bytes, fileName) => ipcRenderer.invoke(RESOURCE_ADD_CHANNEL, bytes, fileName),
  purgeUnusedResources: (document) => ipcRenderer.invoke(RESOURCE_PURGE_CHANNEL, document),
  resetResourceStore: () => ipcRenderer.invoke(RESOURCE_RESET_CHANNEL),
  listLibrary: () => ipcRenderer.invoke(LIBRARY_LIST_CHANNEL),
  addLibraryAsset: (asset, contextAssets) =>
    ipcRenderer.invoke(LIBRARY_ADD_CHANNEL, asset, contextAssets),
  removeLibraryAsset: (id) => ipcRenderer.invoke(LIBRARY_REMOVE_CHANNEL, id),
  renameLibraryAsset: (id, name) => ipcRenderer.invoke(LIBRARY_RENAME_CHANNEL, id, name),
  pickExportPath: (request) => ipcRenderer.invoke(EXPORT_PICK_PATH_CHANNEL, request),
  writeExportFile: (path, bytes) => ipcRenderer.invoke(EXPORT_WRITE_CHANNEL, path, bytes),
  loadGlobalPalette: () => ipcRenderer.invoke(PALETTE_GET_CHANNEL),
  saveGlobalPalette: (colors) => ipcRenderer.invoke(PALETTE_SET_CHANNEL, colors),
  onMenuCommand: (listener) => {
    const handler = (_event: IpcRendererEvent, command: MenuCommand): void => listener(command)
    ipcRenderer.on(APP_MENU_COMMAND_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(APP_MENU_COMMAND_CHANNEL, handler)
    }
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  console.warn('OpenAnimator: context isolation is disabled, exposing the API on window directly')
  ;(window as unknown as { api: OpenAnimatorApi }).api = api
}
