import './style.css'

import { isAnimatorDocument } from '@shared/document'
import { createStarterDocument } from '@shared/starterDocument'
import type { AnimatorDocument } from '@shared/model'

import { el } from './dom'
import { Editor } from './editor'
import type { Tool } from './editor'
import { StageView } from './stage'
import { TimelineView } from './timeline'

const STORAGE_KEY = 'openanimator:document'

function loadDocument(): AnimatorDocument {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (isAnimatorDocument(parsed)) return parsed
    }
  } catch (error) {
    console.warn('OpenAnimator: failed to restore the previous document', error)
  }
  return createStarterDocument()
}

function persistDocument(editor: Editor): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(editor.document))
  } catch (error) {
    console.warn('OpenAnimator: failed to save the document', error)
  }
}

function buildToolbar(editor: Editor): HTMLElement {
  const toolbar = el('header', 'toolbar')
  toolbar.appendChild(el('span', 'title', 'OpenAnimator'))

  const tools = el('div', 'group')
  const toolButtons: Array<[Tool, string, string]> = [
    ['select', 'Select', 'Select and move shapes (V)'],
    ['rect', 'Rectangle', 'Draw a rectangle (R)'],
    ['ellipse', 'Ellipse', 'Draw an ellipse (O)']
  ]
  for (const [tool, label, title] of toolButtons) {
    const button = el('button', undefined, label)
    button.title = title
    button.dataset.tool = tool
    button.addEventListener('click', () => editor.setTool(tool))
    tools.appendChild(button)
  }
  toolbar.appendChild(tools)

  toolbar.appendChild(el('span', 'sep'))

  const view = el('div', 'group')
  const onion = el('button', undefined, 'Onion skin')
  onion.title = 'Toggle onion skinning of neighbouring frames'
  onion.classList.add('toggle')
  onion.addEventListener('click', () => editor.toggleOnionSkin())
  view.appendChild(onion)
  toolbar.appendChild(view)

  toolbar.appendChild(el('span', 'sep'))

  const docs = el('div', 'group')
  const newButton = el('button', undefined, 'New')
  newButton.title = 'Start a new empty document'
  newButton.addEventListener('click', () => {
    if (window.confirm('Discard the current document and start a new one?')) editor.newDocument()
  })
  const saveButton = el('button', undefined, 'Save')
  saveButton.title = 'Save the document in the browser storage'
  saveButton.addEventListener('click', () => persistDocument(editor))
  docs.append(newButton, saveButton)
  toolbar.appendChild(docs)

  editor.onUiChange(() => {
    for (const button of tools.querySelectorAll('button[data-tool]')) {
      button.classList.toggle('active', button.getAttribute('data-tool') === editor.tool)
    }
    onion.classList.toggle('active', editor.onionSkin)
  })
  return toolbar
}

function buildStatusbar(editor: Editor): HTMLElement {
  const statusbar = el('footer', 'statusbar')
  const frameInfo = el('span')
  const layerInfo = el('span')
  const toolInfo = el('span')
  const versionInfo = el('span')
  statusbar.append(frameInfo, layerInfo, toolInfo, versionInfo)

  const update = (): void => {
    frameInfo.textContent = `frame ${editor.currentFrame + 1} / ${editor.duration}`
    layerInfo.textContent = `layer: ${editor.currentLayer?.name ?? '-'}`
    toolInfo.textContent = `tool: ${editor.tool}${editor.selectedShapeId ? ' · selected' : ''}`
  }
  editor.onFrameChange(update)
  editor.onDocChange(update)
  editor.onUiChange(update)
  update()

  void window.api
    .versions()
    .then((versions) => {
      versionInfo.textContent = `OpenAnimator v${versions.app} · Electron ${versions.electron}`
    })
    .catch((error: unknown) => {
      console.warn('OpenAnimator: failed to load application information', error)
    })
  return statusbar
}

function registerKeyboard(editor: Editor): void {
  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return
    switch (event.key) {
      case 'v':
      case 'V':
        editor.setTool('select')
        break
      case 'r':
      case 'R':
        editor.setTool('rect')
        break
      case 'o':
      case 'O':
        editor.setTool('ellipse')
        break
      case ' ':
        event.preventDefault()
        editor.togglePlay()
        break
      case 'Escape':
        editor.stopPlayback()
        break
      case 'F5':
        event.preventDefault()
        editor.insertFrameHere()
        break
      case 'F6':
        event.preventDefault()
        editor.insertKeyframeHere()
        break
      case 'F7':
        event.preventDefault()
        editor.insertBlankKeyframeHere()
        break
      case 'Delete':
      case 'Backspace':
        event.preventDefault()
        editor.deleteSelected()
        break
      case 'ArrowLeft':
        event.preventDefault()
        editor.nudgeSelected(event.shiftKey ? -10 : -1, 0)
        break
      case 'ArrowRight':
        event.preventDefault()
        editor.nudgeSelected(event.shiftKey ? 10 : 1, 0)
        break
      case 'ArrowUp':
        event.preventDefault()
        editor.nudgeSelected(0, event.shiftKey ? -10 : -1)
        break
      case 'ArrowDown':
        event.preventDefault()
        editor.nudgeSelected(0, event.shiftKey ? 10 : 1)
        break
      default:
        break
    }
  })
}

async function bootstrap(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) throw new Error('Missing #app root element')

  const editor = new Editor(loadDocument())

  const layout = el('div', 'layout')
  const workspace = el('main', 'workspace')
  const timelineHost = el('section', 'timeline')
  layout.append(buildToolbar(editor), workspace, timelineHost, buildStatusbar(editor))
  root.appendChild(layout)

  new StageView(editor, workspace)
  new TimelineView(editor, timelineHost)
  registerKeyboard(editor)

  // Debounced autosave on every document change.
  let saveTimer: number | undefined
  editor.onDocChange(() => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => persistDocument(editor), 400)
  })
}

void bootstrap()
