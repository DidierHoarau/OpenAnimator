import { el } from './dom'
import type { Editor } from './editor'
import { createModal } from './modal'
import { saveDocument } from './projects'

/**
 * Protects unsaved work on window close: the main process asks the renderer
 * whether the window may close, and a dirty document shows an in-app
 * Save / Discard / Cancel prompt (covering Window→Close, Cmd+Q and quit).
 * Save runs the regular save flow — Save As for untitled documents; a
 * canceled or failed save keeps the prompt open, so the window stays until
 * the user decides.
 */
export function registerCloseGuard(editor: Editor): void {
  let promptOpen = false
  window.api.onCloseRequest(() => {
    if (promptOpen) return
    if (!editor.dirty) {
      void window.api.respondToCloseRequest(true)
      return
    }
    promptOpen = true
    void showUnsavedChangesPrompt(editor).then((allow) => {
      promptOpen = false
      void window.api.respondToCloseRequest(allow)
    })
  })
}

function showUnsavedChangesPrompt(editor: Editor): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (allow: boolean): void => {
      if (settled) return
      settled = true
      handle.close()
      resolve(allow)
    }
    // `settle` only refers to the handle after creation; no synchronous call
    // happens inside `createModal`.
    const handle = createModal({ onRequestClose: () => settle(false) })

    const header = el('div', 'modal-header')
    const closeButton = el('button', 'modal-close', '×')
    closeButton.title = 'Keep the document open'
    closeButton.addEventListener('click', () => settle(false))
    header.append(el('h2', 'modal-title', 'Unsaved changes'), closeButton)

    const subtitle = el('p', 'modal-subtitle', 'Save the changes before closing?')

    const actions = el('div', 'modal-actions')
    const cancelButton = el('button', undefined, 'Cancel')
    cancelButton.title = 'Keep the window open'
    cancelButton.addEventListener('click', () => settle(false))
    const discardButton = el('button', undefined, 'Discard')
    discardButton.title = 'Close the window and lose the unsaved changes'
    discardButton.addEventListener('click', () => settle(true))
    const saveButton = el('button', 'primary', 'Save')
    saveButton.title = 'Save the document, then close the window'
    saveButton.addEventListener('click', () => {
      saveButton.disabled = true
      void saveDocument(editor, { as: !editor.filePath }).then((saved) => {
        if (saved) {
          settle(true)
          return
        }
        // Canceled Save As or a failed save: the prompt stays so the user
        // can retry, discard or cancel.
        saveButton.disabled = false
      })
    })
    actions.append(cancelButton, discardButton, saveButton)

    handle.modal.append(header, subtitle, actions)
  })
}
