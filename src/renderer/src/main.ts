import './style.css'

import { createStarterDocument } from '@shared/starterDocument'

import { el } from './dom'
import { Editor } from './editor'
import type { Tool } from './editor'
import { fileLabel, newDocument, openDocument, saveDocument, showStartupDialog } from './projects'
import { StageView } from './stage'
import { TimelineView } from './timeline'

function buildToolbar(editor: Editor, layout: HTMLElement): HTMLElement {
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
  view.append(onion)
  toolbar.appendChild(view)

  toolbar.appendChild(el('span', 'sep'))

  const docs = el('div', 'group')
  const newButton = el('button', undefined, 'New')
  newButton.title = 'Start a new project'
  newButton.addEventListener('click', () => void newDocument(editor))
  const openButton = el('button', undefined, 'Open…')
  openButton.title = 'Open a project file (Ctrl+O)'
  openButton.addEventListener('click', () => void openDocument(editor))
  const saveButton = el('button', undefined, 'Save')
  saveButton.title = 'Save the current project (Ctrl+S)'
  saveButton.addEventListener('click', () => void saveDocument(editor, { as: false }))
  const saveAsButton = el('button', undefined, 'Save As…')
  saveAsButton.title = 'Save the project to a new file (Ctrl+Shift+S)'
  saveAsButton.addEventListener('click', () => void saveDocument(editor, { as: true }))
  docs.append(newButton, openButton, saveButton, saveAsButton)
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
  const fileInfo = el('span')
  const versionInfo = el('span')
  statusbar.append(frameInfo, layerInfo, toolInfo, fileInfo, versionInfo)

  const update = (): void => {
    frameInfo.textContent = `frame ${editor.currentFrame + 1} / ${editor.duration}`
    layerInfo.textContent = `layer: ${editor.currentLayer?.name ?? '-'}`
    toolInfo.textContent = `tool: ${editor.tool}${editor.selectedShapeId ? ' · selected' : ''}`
    fileInfo.textContent = `file: ${fileLabel(editor)}`
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
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        void saveDocument(editor, { as: event.shiftKey })
      } else if (key === 'o') {
        event.preventDefault()
        void openDocument(editor)
      }
      return
    }
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

  const editor = new Editor(createStarterDocument())

  const layout = el('div', 'layout')
  const workspace = el('main', 'workspace')
  const timelineHost = el('section', 'timeline')
  layout.append(buildToolbar(editor, layout), workspace, timelineHost, buildStatusbar(editor))
  root.appendChild(layout)

  new StageView(editor, workspace)
  new TimelineView(editor, timelineHost)
  registerKeyboard(editor)
  showStartupDialog(editor)

  // Debounced autosave to the project file on every document change.
  let saveTimer: number | undefined
  editor.onDocChange(() => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      if (editor.filePath && editor.dirty) void saveDocument(editor, { as: false })
    }, 400)
  })
}

void bootstrap()
