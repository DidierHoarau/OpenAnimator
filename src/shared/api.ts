/** IPC channel used by the renderer to fetch application information. */
export const APP_API_CHANNEL = 'openanimator:app-info'

export interface AppVersions {
  app: string
  electron: string
  chrome: string
  node: string
}

/** API exposed to the renderer through the preload script. */
export interface OpenAnimatorApi {
  versions(): Promise<AppVersions>
}
