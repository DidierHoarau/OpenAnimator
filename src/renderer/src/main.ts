import './style.css'

import { AUTOSAVE_MAX_WAIT_MS, IdleDebouncer } from '@shared/idleDebounce'
import type { ShortcutId } from '@shared/shortcuts'
import { createStarterDocument } from '@shared/starterDocument'

import { AudioSystem } from './audio'
import { detectAudioFormat, importAudioBytes, importAudioViaDialog } from './audioImport'
import { preloadDrawingCells } from './cellPreload'
import { registerCloseGuard } from './closeGuard'
import { purgeUnusedResources, runEditorCommand } from './commands'
import type { CommandDeps } from './commands'
import { el } from './dom'
import { Editor } from './editor'
import { importImageBytes, importImageViaDialog } from './imageImport'
import { registerKeyboard } from './keyboard'
import { LibraryView } from './library'
import { attachPanelSplitters } from './panelLayout'
import { getPreferences, initPreferences, onPreferencesChanged, updatePreferences } from './preferences'
import { PropertiesView } from './properties'
import { showExportDialog } from './exportDialog'
import { checkUntitledRecovery, fileLabel, newDocument, openDocument, openProjectFromPath, saveDocument, saveRecoverySnapshot, showStartupDialog } from './projects'
import { showScriptConsole } from './scripting/scriptConsole'
import { StageView } from './stage'
import { TimelineView } from './timeline'
import { buildToolsPanel } from './toolsPanel'
import { showUpdateBanner } from './updateBanner'

/** Toolbar plus the panel toggles it owns, so the command router can reuse
 * the exact same actions as the toolbar buttons. */
interface ToolbarHandle {
  element: HTMLElement
  toggleLibrary(): void
  toggleProperties(): void
}

function buildToolbar(editor: Editor, layout: HTMLElement, libraryView: LibraryView): ToolbarHandle {
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
  const toggleLibrary = (): void => libraryView.setVisible(!libraryView.isVisible)
  library.addEventListener('click', toggleLibrary)
  libraryView.onVisibilityChanged(syncLibraryLayout)
  syncLibraryLayout()
  const properties = el('button', undefined, 'Properties')
  properties.title = 'Toggle the properties panel'
  properties.classList.add('toggle')
  properties.classList.add('active')
  const toggleProperties = (): void => {
    layout.classList.toggle('properties-hidden')
    properties.classList.toggle('active', !layout.classList.contains('properties-hidden'))
  }
  properties.addEventListener('click', toggleProperties)
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
  purgeButton.addEventListener('click', () => purgeUnusedResources(editor))
  const scriptButton = el('button', undefined, 'Script…')
  scriptButton.title = 'Run a JSON command payload through the editor'
  scriptButton.addEventListener('click', () =>
    showScriptConsole(editor, {
      library: window.api,
      preferences: { get: getPreferences, update: updatePreferences }
    })
  )
  docs.append(importButton, importAudioButton, newButton, openButton, saveButton, saveAsButton, exportButton, purgeButton, scriptButton)
  toolbar.appendChild(docs)

  editor.onUiChange(() => {
    onion.classList.toggle('active', editor.onionSkin)
  })
  return { element: toolbar, toggleLibrary, toggleProperties }
}

function buildStatusbar(editor: Editor, stageView: StageView): HTMLElement {
  const statusbar = el('footer', 'statusbar')
  const frameInfo = el('span')
  const layerInfo = el('span')
  const toolInfo = el('span')
  const zoomInfo = el('span')
  const fileInfo = el('span')
  const messageInfo = el('span', 'statusbar-message')
  const messageText = el('span', 'statusbar-message-text')
  const copyDetails = el('button', 'statusbar-details', 'Copy details')
  copyDetails.title = 'Copy the full error details to the system clipboard'
  copyDetails.hidden = true
  const dismissMessage = el('button', 'statusbar-dismiss', '×')
  dismissMessage.title = 'Dismiss this message'
  dismissMessage.hidden = true
  messageInfo.append(messageText, copyDetails, dismissMessage)
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

  // Status-bar messages: transient by default (2 s), persistent ones (e.g.
  // errors) stay visible until dismissed or replaced. Error messages carry
  // copyable details (stack traces) and a dismiss button.
  let messageTimer: number | undefined
  let currentDetails: string | null = null
  const hideMessage = (): void => {
    messageInfo.classList.remove('visible', 'persistent', 'severity-error')
  }
  copyDetails.addEventListener('click', () => {
    if (!currentDetails) return
    void navigator.clipboard
      .writeText(currentDetails)
      .then(() => {
        copyDetails.textContent = 'Copied'
        window.setTimeout(() => {
          copyDetails.textContent = 'Copy details'
        }, 1500)
      })
      .catch((error: unknown) => {
        console.warn('OpenAnimator: could not copy the error details', error)
      })
  })
  dismissMessage.addEventListener('click', hideMessage)
  editor.onMessage((message, options) => {
    messageText.textContent = message
    messageInfo.classList.add('visible')
    messageInfo.classList.toggle('persistent', options.persistent)
    messageInfo.classList.toggle('severity-error', options.severity === 'error')
    currentDetails = options.details ?? null
    copyDetails.hidden = currentDetails === null
    dismissMessage.hidden = !options.persistent
    window.clearTimeout(messageTimer)
    if (options.persistent) return
    messageTimer = window.setTimeout(() => {
      hideMessage()
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
 * are logged with their stack and reported through the persistent error
 * strip (with copyable details), so a broken view can never fail silently
 * for the user.
 */
function registerErrorSurfacing(editor: Editor): void {
  const report = (kind: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    const details =
      error instanceof Error ? (error.stack ?? `${error.name}: ${message}`) : String(error)
    console.error(`OpenAnimator: ${kind}`, error)
    editor.showMessage(`Unexpected error: ${message}`, {
      severity: 'error',
      persistent: true,
      details: `${kind}\n${details}`
    })
  }
  window.addEventListener('error', (event) => {
    if (event.error) report('uncaught error', event.error)
  })
  window.addEventListener('unhandledrejection', (event) => {
    report('unhandled rejection', event.reason)
  })
}

/** Menu commands routed into focused form fields: the DOM editing commands
 * run natively, so menu and keyboard behave exactly like the platform. */
function runTextEditCommand(command: ShortcutId): boolean {
  switch (command) {
    case 'edit.undo':
    case 'edit.redo':
    case 'edit.cut':
    case 'edit.copy':
    case 'edit.selectAll':
      document.execCommand(command.slice('edit.'.length))
      return true
    case 'edit.paste':
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) document.execCommand('insertText', false, text)
        })
        .catch((error: unknown) => {
          console.warn('OpenAnimator: could not read the system clipboard', error)
        })
      return true
    default:
      return false
  }
}

async function bootstrap(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>('#app')
  if (!root) throw new Error('Missing #app root element')

  // Preferences first: they shape the welcome document (stage size, fps) and
  // the live editor defaults (grid, brush, undo depth).
  const preferences = await initPreferences()

  // The audio system reads resources through the editor, which does not exist
  // yet: resolve the editor lazily through a captured slot.
  let audioEditor: Editor | null = null
  const audio = new AudioSystem({
    getBlob: (resourceId) => audioEditor?.resources.getBlob(resourceId) ?? null
  })
  // The welcome document is always the demo scene; `showDemoOnNew` only
  // affects File → New (see projects.ts).
  const startDocument = createStarterDocument(
    preferences.stageWidth,
    preferences.stageHeight,
    preferences.fps
  )
  const editor = new Editor(startDocument, { audio })
  audioEditor = editor
  editor.applyPreferences(preferences)

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
  const toolbar = buildToolbar(editor, layout, libraryView)
  layout.append(
    toolbar.element,
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
  const commandDeps: CommandDeps = {
    editor,
    stageView,
    timelineView,
    panels: { toggleLibrary: toolbar.toggleLibrary, toggleProperties: toolbar.toggleProperties }
  }
  registerKeyboard(commandDeps)
  registerFileDrop(editor, workspace, stageView)
  registerErrorSurfacing(editor)
  // Menu commands are the application menu's dispatch path: inside form
  // fields the DOM editing commands replay natively, everything else runs
  // through the same router the keyboard uses.
  window.api.onMenuCommand((command) => {
    const target = document.activeElement
    const inTextField =
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement
    if (inTextField && runTextEditCommand(command)) return
    runEditorCommand(command, commandDeps)
  })
  // A `.oanim` handed over by the OS (file association, second instance or
  // macOS open-file) opens through the regular load path.
  window.api.onOpenFile((path) => void openProjectFromPath(editor, path))
  window.api.onUpdateAvailable((info) => showUpdateBanner(info))
  registerCloseGuard(editor)
  showStartupDialog(editor)
  // A snapshot left behind by a crash of a never-saved document as well.
  void checkUntitledRecovery(editor)

  // Warm the image cache for every drawing cell when playback starts so the
  // first pass does not flash blank cells.
  editor.onUiChange(() => {
    if (editor.playing) preloadDrawingCells(editor)
  })

  // Idle-debounced autosave to a recovery snapshot (trailing window from the
  // preferences, forced at most 20 s after the first unsaved change); the
  // project file itself is only written by an explicit save. Untitled
  // documents are covered too — their session-keyed snapshot is the only
  // protection they have. The scratch document of a symbol edit session is
  // never autosaved; the guards are evaluated at run time.
  let autosave: IdleDebouncer | null = null
  const rebuildAutosave = (idleMs: number, enabled: boolean): void => {
    autosave?.cancel()
    autosave = enabled
      ? new IdleDebouncer(idleMs, AUTOSAVE_MAX_WAIT_MS, () => {
          if (editor.editingAssetId) return
          if (editor.dirty) void saveRecoverySnapshot(editor)
        })
      : null
  }
  rebuildAutosave(preferences.autosaveIdleMs, preferences.autosaveEnabled)
  editor.onDocChange(() => autosave?.schedule())
  // Preference edits take effect immediately: editor state (grid, brush,
  // undo depth) is re-applied and the autosave cadence is rebuilt.
  onPreferencesChanged((next) => {
    editor.applyPreferences(next)
    rebuildAutosave(next.autosaveIdleMs, next.autosaveEnabled)
  })
}

void bootstrap()
