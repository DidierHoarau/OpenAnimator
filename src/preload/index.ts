import { contextBridge, ipcRenderer } from 'electron'

import {
  APP_API_CHANNEL,
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
import type { OpenAnimatorApi } from '../shared/api'

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
  resetResourceStore: () => ipcRenderer.invoke(RESOURCE_RESET_CHANNEL)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  console.warn('OpenAnimator: context isolation is disabled, exposing the API on window directly')
  ;(window as unknown as { api: OpenAnimatorApi }).api = api
}
