import { contextBridge, ipcRenderer } from 'electron'

import { APP_API_CHANNEL } from '../shared/api'
import type { OpenAnimatorApi } from '../shared/api'

const api: OpenAnimatorApi = {
  versions: () => ipcRenderer.invoke(APP_API_CHANNEL)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  console.warn('OpenAnimator: context isolation is disabled, exposing the API on window directly')
  ;(window as unknown as { api: OpenAnimatorApi }).api = api
}
