import './style.css'

import { createStarterDocument } from '@shared/starterDocument'

import { AudioSystem } from './audio'
import { detectAudioFormat, importAudioBytes, importAudioViaDialog } from './audioImport'
import { preloadDrawingCells } from './cellPreload'
import { el } from './dom'
import { Editor } from './editor'
import { importImageBytes, importImageViaDialog } from './imageImport'
import { registerKeyboard } from './keyboard'
import { LibraryView } from './library'
import { attachPanelSplitters } from './panelLayout'
import { PropertiesView } from './properties'
import { showExportDialog } from './exportDialog'
import { fileLabel, newDocument, openDocument, openProjectFromPath, saveDocument, saveRecoverySnapshot, showStartupDialog } from './projects'
import { showScriptConsole } from './scripting/scriptConsole'
import { StageView } from './stage'
import { TimelineView } from './timeline'
import { buildToolsPanel } from './toolsPanel'
import { showUpdateBanner } from './updateBanner'

function buildToolbar(editor: Editor, layout: HTMLElement, libraryView: LibraryView): HTMLElement {
  const toolbar = el('header', 'toolbar')
  toolbar.appendChild(el('span', 'title', 'OpenAnimator'))

  toolbar.appendChild(el('span', 'sep'))

  const view = el('div', 'group')
  const onion = el('button', undefined, 'Onion skin')
  onion.title = 'Toggle onion skinning of neighbouring frames'
  onion.classList.add('toggle')
  onion.addEventListener('click', () => editor.toggleOnionSkin())
  const library = el('button', undefined, 'Library')
  library.title = 'Toggle the asset library panel'
  library.classList.add('toggle')
  // The layout must drop the library column with the panel, or hiding the
  // library would leave its reserved grid space on the screen. Auto-open
  // (first asset) and persistence flow through the same notification.
  const syncLibraryLayout = (): void => {
    layout.classList.toggle('library-hidden', !libraryView.isVisible)
    library.classList.toggle('active', libraryView.isVisible)
  }
  library.addEventListener('click', () => libraryView.setVisible(!libraryView.isVisible))
  libraryView.onVisibilityChanged(syncLibraryLayout)
  syncLibraryLayout()
  const properties = el('button', undefined, 'Properties')
  properties.title = 'Toggle the properties panel'
  properties.classList.add('toggle')
  properties.classList.add('active')
  properties.addEventListener('click', () => {
    layout.classList.toggle('properties-hidden')
    properties.classList.toggle('active', !layout.classList.contains('properties-hidden'))
  })
  view.append(onion, library, properties)
  toolbar.appendChild(view)

  toolbar.appendChild(el('span', 'sep'))

  const history = el('div', 'group')
  const undoButton = el('button', undefined, 'Undo')
  undoButton.title = 'Undo the last change (Ctrl+Z)'
  undoButton.addEventListener('click', () => editor.undo())
  const redoButton = el('button', undefined, 'Redo')
  redoButton.title = 'Redo the last undone change (Ctrl+Shift+Z or Ctrl+Y)'
  redoButton.addEventListener('click', () => editor.redo())
  history.append(undoButton, redoButton)
  toolbar.appendChild(history)
  const syncHistory = (): void => {
    undoButton.disabled = !editor.canUndo
    redoButton.disabled = !editor.canRedo
  }
  editor.onDocChange(syncHistory)
  syncHistory()

  toolbar.appendChild(el('span', 'sep'))

  const docs = el('div', 'group')
  const importButton = el('button', undefined, 'Import Image…')
  importButton.title = 'Import an image onto the stage (Ctrl+I)'
  importButton.addEventListener('click', () => void importImageViaDialog(editor))
  const importAudioButton = el('button', undefined, 'Import Audio…')
  importAudioButton.title = 'Import a WAV, MP3 or OGG file as a new audio layer'
  importAudioButton.addEventListener('click', () => void importAudioViaDialog(editor))
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
  const exportButton = el('button', undefined, 'Export…')
  exportButton.title = 'Export the animation as PNG sequence, GIF or video'
  exportButton.addEventListener('click', () => showExportDialog(editor))
  const purgeButton = el('button', undefined, 'Purge Unused')
  purgeButton.title = 'Remove resources no object references from the session store'
  purgeButton.addEventListener('click', () => {
    void window.api.purgeUnusedResources(editor.document).then((result) => {
      editor.showMessage(
        result.removed === 0 ? 'No unused resources' : `Purged ${result.removed} unused resource(s)`
      )
    })
  })
  const scriptButton = el('button', undefined, 'Script…')
  scriptButton.title = 'Run a JSON command payload through the editor'
  scriptButton.addEventListener('click', () => showScriptConsole(editor))
  docs.append(importButton, importAudioButton, newButton, openButton, saveButton, saveAsButton, exportButton, purgeButton, scriptButton)
  toolbar.appendChild(docs)

  editor.onUiChange(() => {
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

/** OS drag-drop of image and audio files onto the workspace: images land at
 * the drop point, audio files import as new audio layers. */
function registerFileDrop(editor: Editor, workspace: HTMLElement, stageView: StageView): void {
  workspace.addEventListener('dragover', (event) => {
    event.preventDefault()
  })
  workspace.addEventListener('drop', (event) => {
    event.preventDefault()
    const file = event.dataTransfer?.files?.[0]
    if (!file) return
    const point = stageView.toStagePoint(event)
    void file.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer)
      if (detectAudioFormat(file.name, bytes)) {
        return void importAudioBytes(editor, file.name, bytes)
      }
      return void importImageBytes(editor, file.name, bytes, point)
    })
  })
}

/**
 * Global renderer error surfacing: uncaught errors and unhandled rejections
 * are logged with their stack and reported through the status bar, so a
 * broken view can never fail silently for the user.
 */
function registerErrorSurfacing(editor: Editor): void {
  const report = (kind: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`OpenAnimator: ${kind}`, error)
    editor.showMessage(`Unexpected error: ${message}`)
  }
  window.addEventListener('error', (event) => {
    if (event.error) report('uncaught error', event.error)
  })
  window.addEventListener('unhandledrejection', (event) => {
    report('unhandled rejection', event.reason)
  })
}

async function bootstrap(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) throw new Error('Missing #app root element')

  // The audio system reads resources through the editor, which does not exist
  // yet: resolve the editor lazily through a captured slot.
  let audioEditor: Editor | null = null
  const audio = new AudioSystem({
    getBlob: (resourceId) => audioEditor?.resources.getBlob(resourceId) ?? null
  })
  const editor = new Editor(createStarterDocument(), { audio })
  audioEditor = editor

  const layout = el('div', 'layout')
  const libraryHost = el('aside', 'library-panel')
  const workspace = el('main', 'workspace')
  const timelineHost = el('section', 'timeline')
  const propertiesHost = el('aside', 'properties-panel')
  const stageView = new StageView(editor, workspace)
  const libraryView = new LibraryView(editor, libraryHost, {
    api: window.api,
    dropTarget: { element: stageView.element, toStagePoint: (event) => stageView.toStagePoint(event) }
  })
  layout.append(
    buildToolbar(editor, layout, libraryView),
    libraryHost,
    buildToolsPanel(editor),
    workspace,
    propertiesHost,
    timelineHost,
    buildStatusbar(editor, stageView)
  )
  attachPanelSplitters(layout)
  root.appendChild(layout)

  const timelineView = new TimelineView(editor, timelineHost)
  new PropertiesView(editor, propertiesHost)
  registerKeyboard(editor, stageView, timelineView)
  registerFileDrop(editor, workspace, stageView)
  registerErrorSurfacing(editor)
  // Menu accelerators are consumed by the native menu before the page sees
  // them; the Edit menu routes Undo/Redo here. Inside form fields the DOM
  // editing history is replayed instead of touching the document.
  window.api.onMenuCommand((command) => {
    const target = document.activeElement
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement
    ) {
      document.execCommand(command)
      return
    }
    if (command === 'undo') editor.undo()
    else editor.redo()
  })
  // A `.oanim` handed over by the OS (file association, second instance or
  // macOS open-file) opens through the regular load path.
  window.api.onOpenFile((path) => void openProjectFromPath(editor, path))
  window.api.onUpdateAvailable((info) => showUpdateBanner(info))
  showStartupDialog(editor)

  // Warm the image cache for every drawing cell when playback starts so the
  // first pass does not flash blank cells.
  editor.onUiChange(() => {
    if (editor.playing) preloadDrawingCells(editor)
  })

  // Debounced autosave to a recovery snapshot; the project file itself is
  // only written by an explicit save. The scratch document of a symbol edit
  // session is never autosaved.
  let saveTimer: number | undefined
  editor.onDocChange(() => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      if (editor.editingAssetId) return
      if (editor.filePath && editor.dirty) void saveRecoverySnapshot(editor)
    }, 400)
  })
}

void bootstrap()
