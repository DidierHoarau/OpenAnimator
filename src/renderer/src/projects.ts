import type { AnimatorDocument } from '@shared/model'
import type { RecoveryInfo } from '@shared/recovery'

import type { Editor } from './editor'
import { el } from './dom'
import { reconcileEmbeddedFonts, syncSessionFonts } from './fontEmbedding'
import { createModal, showAlertDialog, showConfirmDialog } from './modal'
import { getPreferences } from './preferences'

function pathBasename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function projectNameFromPath(path: string): string {
  const base = pathBasename(path)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem || base
}

function formatRelativeTime(timestamp: number): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const minutes = Math.round((Date.now() - timestamp) / 60000)
  if (Math.abs(minutes) < 60) return rtf.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return rtf.format(-hours, 'hour')
  return rtf.format(-Math.round(hours / 24), 'day')
}

/** File name shown in the status bar for the current project. */
export function fileLabel(editor: Editor): string {
  return editor.filePath ? pathBasename(editor.filePath) : 'unsaved'
}

/** Recovery slot of never-saved documents: one key per app session (or the
 * adopted key of a recovered snapshot), so untitled autosaves always land in
 * the same slot and a crash cannot lose unsaved work. */
let untitledRecoveryKey: string | null = null

export function sessionUntitledRecoveryKey(): string {
  if (!untitledRecoveryKey) untitledRecoveryKey = `untitled/${crypto.randomUUID()}`
  return untitledRecoveryKey
}

/** Recovered untitled documents keep the slot they came from. */
export function setUntitledRecoveryKey(key: string): void {
  untitledRecoveryKey = key
}

/** Recovery key the document snapshots under: the file path, or the session
 * key for untitled documents. */
function activeRecoveryKey(editor: Editor): string {
  return editor.filePath ?? sessionUntitledRecoveryKey()
}

async function loadProjectFromPath(
  editor: Editor,
  path: string,
  document: AnimatorDocument,
  resources: Record<string, Uint8Array> = {}
): Promise<boolean> {
  document.name = projectNameFromPath(path)
  editor.filePath = path
  editor.setDocument(document, resources)
  editor.dirty = false
  void window.api.rememberProject(path, document.name)
  // The embedded subsets register as FontFaces once their bytes are in the
  // session cache; views re-render when the faces are ready.
  void syncSessionFonts(editor)
  void checkPendingRecovery(editor, path)
  return true
}

/** Offers the autosave recovery snapshot when one is newer than the file. */
async function checkPendingRecovery(editor: Editor, path: string): Promise<void> {
  const info = await window.api.checkRecovery(path)
  if (info) showRecoveryDialog(editor, info)
}

/** Offers the newest never-saved snapshot (e.g. left by a crash) at startup. */
export async function checkUntitledRecovery(editor: Editor): Promise<void> {
  const unsaved = await window.api.listUnsavedRecoveries()
  const newest = unsaved[0]
  if (newest) showRecoveryDialog(editor, newest)
}

/**
 * Recovery dialog for an autosave snapshot: Recover loads it into the editor
 * (the dirty flag makes the next autosave re-snapshot) and adopts the slot of
 * untitled snapshots so the next autosave overwrites the same one. Untitled
 * snapshots additionally offer Save As…. Discard deletes it, closing keeps
 * it for later.
 */
export function showRecoveryDialog(editor: Editor, info: RecoveryInfo): void {
  const untitled = info.untitled === true
  const { modal, close } = createModal()

  const header = el('div', 'modal-header')
  const closeButton = el('button', 'modal-close', '×')
  closeButton.title = 'Keep the autosaved changes for later'
  closeButton.addEventListener('click', close)
  header.append(el('h2', 'modal-title', 'Recover autosaved changes'), closeButton)

  const subtitle = el(
    'p',
    'modal-subtitle',
    untitled
      ? 'OpenAnimator found autosaved changes for a never-saved document.'
      : `OpenAnimator found autosaved changes for ${info.name} newer than the last save.`
  )

  const recoverIntoEditor = async (): Promise<boolean> => {
    const result = await window.api.readRecovery(info.path)
    if (!result.ok) {
      void showAlertDialog({
        title: 'Recovery failed',
        message: `Could not read the autosaved changes: ${result.error}`
      })
      return false
    }
    if (untitled) setUntitledRecoveryKey(info.path)
    editor.setDocument(result.document, result.resources)
    void syncSessionFonts(editor)
    return true
  }

  const actions = el('div', 'modal-actions')
  const recoverButton = el('button', 'primary', 'Recover')
  recoverButton.title = 'Open the document as of the last autosave'
  recoverButton.addEventListener('click', () => {
    recoverButton.disabled = true
    void recoverIntoEditor().then((recovered) => {
      recoverButton.disabled = false
      if (!recovered) return
      editor.showMessage('Recovered autosaved changes')
      close()
    })
  })

  actions.append(recoverButton)
  if (untitled) {
    const saveAsButton = el('button', undefined, 'Save As…')
    saveAsButton.title = 'Recover the document and save it to a file right away'
    saveAsButton.addEventListener('click', () => {
      saveAsButton.disabled = true
      void recoverIntoEditor().then((recovered) => {
        saveAsButton.disabled = false
        if (!recovered) return
        close()
        // A canceled Save As keeps the recovered (dirty) document open.
        void saveDocument(editor, { as: true })
      })
    })
    actions.append(saveAsButton)
  }
  const discardButton = el('button', undefined, 'Discard')
  discardButton.title = 'Delete the autosaved changes'
  discardButton.addEventListener('click', () => {
    void window.api.clearRecovery(info.path)
    close()
  })
  actions.append(discardButton)

  modal.append(header, subtitle, actions)
}

/**
 * Saves the document: to the current file when one is known (unless `as`),
 * through a Save As dialog otherwise. Saving is blocked while a symbol is
 * being edited in isolation — the scratch document must never reach disk.
 */
export async function saveDocument(editor: Editor, options: { as: boolean }): Promise<boolean> {
  if (editor.editingAssetId) {
    editor.showMessage('Finish editing the symbol before saving')
    return false
  }
  try {
    // Embed the font subsets the document renders so the .oanim keeps its
    // typography off-system; failures never block the save itself.
    await reconcileEmbeddedFonts(editor)
  } catch (error) {
    console.warn('OpenAnimator: font embedding failed, saving without new subsets', error)
  }
  if (!options.as && editor.filePath) {
    const result = await window.api.saveProjectTo(editor.filePath, editor.document)
    if (!result.ok) {
      void showAlertDialog({
        title: 'Save failed',
        message: `Failed to save the project: ${result.error}`
      })
      return false
    }
    editor.dirty = false
    void window.api.clearRecovery(editor.filePath)
    return true
  }
  const result = await window.api.saveProjectAs(editor.document)
  if (result.canceled) return false
  if ('error' in result) {
    void showAlertDialog({
      title: 'Save failed',
      message: `Could not write the project file: ${result.error}`
    })
    return false
  }
  const previousPath = editor.filePath
  editor.document.name = projectNameFromPath(result.path)
  editor.markSaved(result.path)
  void window.api.rememberProject(result.path, editor.document.name)
  void window.api.clearRecovery(result.path)
  if (previousPath && previousPath !== result.path) void window.api.clearRecovery(previousPath)
  // A formerly untitled document now has a file: its session slot is done.
  if (!previousPath && untitledRecoveryKey) void window.api.clearRecovery(untitledRecoveryKey)
  return true
}

/**
 * Writes the debounced autosave as a recovery snapshot — the project file
 * itself only ever changes through an explicit save. Untitled documents are
 * snapshotted under the session key too, so a crash cannot lose them.
 * Embedded font subsets are reconciled first (best-effort, as in
 * `saveDocument`) so the snapshot matches what a save would produce.
 */
export async function saveRecoverySnapshot(editor: Editor): Promise<void> {
  try {
    await reconcileEmbeddedFonts(editor)
  } catch (error) {
    console.warn('OpenAnimator: font embedding failed, snapshotting without new subsets', error)
  }
  const untitled = !editor.filePath
  const result = await window.api.writeRecovery(activeRecoveryKey(editor), editor.document, untitled)
  if (!result.ok) {
    console.warn('OpenAnimator: failed to write the recovery snapshot', result.error)
    // Persistent: a silent autosave failure would keep the user believing
    // their work is protected.
    editor.showMessage('Autosave failed', { persistent: true })
  }
}

/**
 * Opens a project handed over by the OS (file association, second instance or
 * macOS open-file). The startup dialog, when still open, is dismissed first.
 */
export async function openProjectFromPath(editor: Editor, path: string): Promise<void> {
  if (
    editor.dirty &&
    !(await showConfirmDialog({
      title: 'Unsaved changes',
      message: 'Discard unsaved changes?',
      confirmLabel: 'Discard'
    }))
  ) {
    return
  }
  const result = await window.api.readProjectFile(path)
  if (!result.ok) {
    void showAlertDialog({
      title: 'Open failed',
      message: `Could not open the project: ${result.error}`
    })
    return
  }
  for (const overlay of document.querySelectorAll('.modal-overlay')) overlay.remove()
  await loadProjectFromPath(editor, path, result.document, result.resources)
}

/** Opens a project through a file dialog. Returns true when one was loaded. */
export async function openDocument(editor: Editor): Promise<boolean> {
  if (
    editor.dirty &&
    !(await showConfirmDialog({
      title: 'Unsaved changes',
      message: 'Discard unsaved changes?',
      confirmLabel: 'Discard'
    }))
  ) {
    return false
  }
  const result = await window.api.openProjectDialog()
  if (result.canceled) return false
  if (!result.document) {
    void showAlertDialog({
      title: 'Open failed',
      message: `Could not open the project: ${result.error ?? 'unknown error'}`
    })
    return false
  }
  return loadProjectFromPath(editor, result.path, result.document, result.resources)
}

/** Starts a new empty project after confirmation when there are unsaved changes.
 * Stage size, frame rate and the demo-scene choice come from the persisted
 * preferences. */
export async function newDocument(editor: Editor): Promise<boolean> {
  if (
    editor.dirty &&
    !(await showConfirmDialog({
      title: 'Unsaved changes',
      message: 'Discard unsaved changes and start a new project?',
      confirmLabel: 'Discard'
    }))
  ) {
    return false
  }
  const preferences = getPreferences()
  editor.filePath = null
  editor.newDocument({
    width: preferences.stageWidth,
    height: preferences.stageHeight,
    fps: preferences.fps,
    demo: preferences.showDemoOnNew
  })
  editor.dirty = false
  void window.api.resetResourceStore()
  return true
}

async function loadRecentProject(editor: Editor, path: string, overlay: HTMLElement): Promise<void> {
  const result = await window.api.readProjectFile(path)
  if (!result.ok) {
    void showAlertDialog({
      title: 'Open failed',
      message: `Could not open the project: ${result.error}`
    })
    return
  }
  await loadProjectFromPath(editor, path, result.document, result.resources)
  overlay.remove()
}

/** Startup dialog: start a new project, open a file or pick from the recent list. */
export function showStartupDialog(editor: Editor): void {
  const { overlay, modal, close } = createModal()

  const header = el('div', 'modal-header')
  const closeButton = el('button', 'modal-close', '×')
  closeButton.title = 'Continue with the current document'
  closeButton.addEventListener('click', close)
  header.append(el('h2', 'modal-title', 'OpenAnimator'), closeButton)

  const subtitle = el('p', 'modal-subtitle', 'Start a new project or open a recent one.')

  const actions = el('div', 'modal-actions')
  const newButton = el('button', undefined, 'New project')
  newButton.addEventListener('click', () => {
    void newDocument(editor).then((created) => {
      if (created) close()
    })
  })
  const openButton = el('button', undefined, 'Open another file…')
  openButton.addEventListener('click', () => {
    void openDocument(editor).then((opened) => {
      if (opened) close()
    })
  })
  actions.append(newButton, openButton)

  const listTitle = el('h3', 'modal-section-title', 'Recent projects')
  const list = el('div', 'recent-list')
  void window.api.getRecentProjects().then((projects) => {
    if (projects.length === 0) {
      list.appendChild(el('p', 'modal-empty', 'No recent projects yet.'))
      return
    }
    for (const project of projects) {
      const item = el('button', 'recent-item')
      item.title = project.path
      const name = el('span', 'name', project.name)
      const path = el('span', 'path', project.path)
      const when = el('span', 'when', formatRelativeTime(project.lastOpenedAt))
      item.append(name, path, when)
      item.addEventListener('click', () => {
        void (async () => {
          if (
            editor.dirty &&
            !(await showConfirmDialog({
              title: 'Unsaved changes',
              message: 'Discard unsaved changes?',
              confirmLabel: 'Discard'
            }))
          ) {
            return
          }
          await loadRecentProject(editor, project.path, overlay)
        })()
      })
      list.appendChild(item)
    }
  })

  modal.append(header, subtitle, actions, listTitle, list)
}
