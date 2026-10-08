import './style.css'

import { createDefaultScene } from '@shared/scene'

import { mountStage } from './stage'

async function bootstrap(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) throw new Error('Missing #app root element')

  mountStage(root, createDefaultScene())

  try {
    const versions = await window.api.versions()
    const footer = document.querySelector<HTMLSpanElement>('#versions')
    if (footer) {
      footer.textContent = `OpenAnimator v${versions.app} · Electron ${versions.electron} · Chromium ${versions.chrome} · Node ${versions.node}`
    }
  } catch (error) {
    console.error('Failed to load application information', error)
  }
}

void bootstrap()
