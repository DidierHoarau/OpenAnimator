import type { AnimatorDocument } from '@shared/model'

import type { Editor } from './editor'
import { el } from './dom'

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

async function loadProjectFromPath(
  editor: Editor,
  path: string,
  document: AnimatorDocument
): Promise<boolean> {
  document.name = projectNameFromPath(path)
  editor.filePath = path
  editor.setDocument(document)
  editor.dirty = false
  void window.api.rememberProject(path, document.name)
  return true
}

/**
 * Saves the document: to the current file when one is known (unless `as`),
 * through a Save As dialog otherwise.
 */
export async function saveDocument(editor: Editor, options: { as: boolean }): Promise<boolean> {
  if (!options.as && editor.filePath) {
    const result = await window.api.saveProjectTo(editor.filePath, editor.document)
    if (!result.ok) {
      window.alert(`Failed to save the project: ${result.error}`)
      return false
    }
    editor.dirty = false
    return true
  }
  const result = await window.api.saveProjectAs(editor.document)
  if (result.canceled) return false
  editor.document.name = projectNameFromPath(result.path)
  editor.markSaved(result.path)
  void window.api.rememberProject(result.path, editor.document.name)
  return true
}

/** Opens a project through a file dialog. Returns true when one was loaded. */
export async function openDocument(editor: Editor): Promise<boolean> {
  if (editor.dirty && !window.confirm('Discard unsaved changes?')) return false
  const result = await window.api.openProjectDialog()
  if (result.canceled) return false
  if (!result.document) {
    window.alert(`Could not open the project: ${result.error ?? 'unknown error'}`)
    return false
  }
  return loadProjectFromPath(editor, result.path, result.document)
}

/** Starts a new empty project after confirmation when there are unsaved changes. */
export async function newDocument(editor: Editor): Promise<boolean> {
  if (editor.dirty && !window.confirm('Discard unsaved changes and start a new project?')) {
    return false
  }
  editor.filePath = null
  editor.newDocument()
  editor.dirty = false
  return true
}

async function loadRecentProject(editor: Editor, path: string, overlay: HTMLElement): Promise<void> {
  const result = await window.api.readProjectFile(path)
  if (!result.ok) {
    window.alert(`Could not open the project: ${result.error}`)
    return
  }
  await loadProjectFromPath(editor, path, result.document)
  overlay.remove()
}

/** Startup dialog: start a new project, open a file or pick from the recent list. */
export function showStartupDialog(editor: Editor): void {
  const overlay = el('div', 'modal-overlay')
  const modal = el('div', 'modal')

  const header = el('div', 'modal-header')
  const closeButton = el('button', 'modal-close', '×')
  closeButton.title = 'Continue with the current document'
  closeButton.addEventListener('click', () => overlay.remove())
  header.append(el('h2', 'modal-title', 'OpenAnimator'), closeButton)

  const subtitle = el('p', 'modal-subtitle', 'Start a new project or open a recent one.')

  const actions = el('div', 'modal-actions')
  const newButton = el('button', undefined, 'New project')
  newButton.addEventListener('click', () => {
    void newDocument(editor).then((created) => {
      if (created) overlay.remove()
    })
  })
  const openButton = el('button', undefined, 'Open another file…')
  openButton.addEventListener('click', () => {
    void openDocument(editor).then((opened) => {
      if (opened) overlay.remove()
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
        if (editor.dirty && !window.confirm('Discard unsaved changes?')) return
        void loadRecentProject(editor, project.path, overlay)
      })
      list.appendChild(item)
    }
  })

  modal.append(header, subtitle, actions, listTitle, list)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
}
