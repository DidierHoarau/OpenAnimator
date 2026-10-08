import type { OpenAnimatorApi } from '../shared/api'

declare global {
  interface Window {
    api: OpenAnimatorApi
  }
}

export {}
