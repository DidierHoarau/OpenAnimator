import './style.css'

import { createStarterDocument } from '@shared/starterDocument'

import { el } from './dom'
import { Editor } from './editor'
import type { Tool } from './editor'
import { PropertiesView } from './properties'
import { fileLabel, newDocument, openDocument, saveDocument, showStartupDialog } from './projects'
import { StageView } from './stage'
import { TimelineView } from './timeline'

function buildToolbar(editor: Editor, layout: HTMLElement): HTMLElement {
  const toolbar = el('header', 'toolbar')
  toolbar.appendChild(el('span', 'title', 'OpenAnimator'))

  const tools = el('div', 'group')
  const toolButtons: Array<[Tool, string, string]> = [
    ['select', 'Select', 'Select and move shapes (V)'],
    ['hand', 'Hand', 'Pan the stage view (H, or hold Space and drag)'],
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
  const properties = el('button', undefined, 'Properties')
  properties.title = 'Toggle the properties panel'
  properties.classList.add('toggle')
  properties.classList.add('active')
  properties.addEventListener('click', () => {
    layout.classList.toggle('properties-hidden')
    properties.classList.toggle('active', !layout.classList.contains('properties-hidden'))
  })
  view.append(onion, properties)
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

function buildStatusbar(editor: Editor, stageView: StageView): HTMLElement {
  const statusbar = el('footer', 'statusbar')
  const frameInfo = el('span')
  const layerInfo = el('span')
  const toolInfo = el('span')
  const zoomInfo = el('span')
  const fileInfo = el('span')
  const messageInfo = el('span')
  messageInfo.classList.add('statusbar-message')
  const versionInfo = el('span')
  statusbar.append(frameInfo, layerInfo, toolInfo, zoomInfo, fileInfo, messageInfo, versionInfo)

  const update = (): void => {
    frameInfo.textContent = `frame ${editor.currentFrame + 1} / ${editor.duration}`
    layerInfo.textContent = `layer: ${editor.currentLayer?.name ?? '-'}`
    const selection = editor.selectedNodeIds.length
    toolInfo.textContent = `tool: ${editor.tool}${
      selection > 0 ? ` \u00b7 ${selection > 1 ? `${selection} ` : ''}selected` : ''
    }`
    fileInfo.textContent = `file: ${fileLabel(editor)}`
  }
  editor.onFrameChange(update)
  editor.onDocChange(update)
  editor.onUiChange(update)
  zoomInfo.textContent = '100%'
  stageView.onViewChange = (scale) => {
    zoomInfo.textContent = `${Math.round(scale * 100)}%`
  }
  update()

  // Transient status-bar messages (e.g. auto-keyframe notification).
  let messageTimer: number | undefined
  editor.onMessage((message) => {
    messageInfo.textContent = message
    messageInfo.classList.add('visible')
    window.clearTimeout(messageTimer)
    messageTimer = window.setTimeout(() => {
      messageInfo.classList.remove('visible')
    }, 2000)
  })

  void window.api
    .versions()
    .then((versions) => {
      versionInfo.textContent = `OpenAnimator v${versions.app} \u00b7 Electron ${versions.electron}`
    })
    .catch((error: unknown) => {
      console.warn('OpenAnimator: failed to load application information', error)
    })
  return statusbar
}

function registerKeyboard(editor: Editor, stageView: StageView): void {
  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null
    const inTextField = target instanceof HTMLInputElement || target instanceof HTMLSelectElement
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        void saveDocument(editor, { as: event.shiftKey })
      } else if (key === 'o') {
        event.preventDefault()
        void openDocument(editor)
      } else if (inTextField) {
        // Let native text undo/redo keep working inside fields.
        return
      } else if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) editor.redo()
        else editor.undo()
      } else if (key === 'y') {
        event.preventDefault()
        editor.redo()
      } else if (key === 'g' && !inTextField) {
        event.preventDefault()
        if (event.shiftKey) editor.ungroupSelection()
        else editor.groupSelection()
      } else if (key === '0') {
        event.preventDefault()
        stageView.resetView()
      }
      return
    }
    if (inTextField) return
    switch (event.key) {
      case 'v':
      case 'V':
        editor.setTool('select')
        break
      case 'h':
      case 'H':
        editor.setTool('hand')
        break
      case 'r':
      case 'R':
        editor.setTool('rect')
        break
      case 'o':
      case 'O':
        editor.setTool('ellipse')
        break
      case '+':
      case '=':
        event.preventDefault()
        stageView.zoomIn()
        break
      case '-':
        event.preventDefault()
        stageView.zoomOut()
        break
      case ' ':
        event.preventDefault()
        stageView.setSpacePressed(true)
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
  window.addEventListener('keyup', (event) => {
    if (event.key !== ' ') return
    const target = event.target as HTMLElement | null
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return
    stageView.setSpacePressed(false)
    // A plain Space tap keeps toggling playback; Space consumed by a pan
    // drag does not.
    if (!stageView.spaceUsed) editor.togglePlay()
  })
}

async function bootstrap(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) throw new Error('Missing #app root element')

  const editor = new Editor(createStarterDocument())

  const layout = el('div', 'layout')
  const workspace = el('main', 'workspace')
  const timelineHost = el('section', 'timeline')
  const propertiesHost = el('aside', 'properties-panel')
  const stageView = new StageView(editor, workspace)
  layout.append(
    buildToolbar(editor, layout),
    workspace,
    propertiesHost,
    timelineHost,
    buildStatusbar(editor, stageView)
  )
  root.appendChild(layout)

  new TimelineView(editor, timelineHost)
  new PropertiesView(editor, propertiesHost)
  registerKeyboard(editor, stageView)
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
