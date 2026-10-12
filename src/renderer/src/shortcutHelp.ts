import { SHORTCUTS, SHORTCUT_CATEGORIES, displayKeysForPlatform } from '@shared/shortcuts'

import { el } from './dom'
import { createModal } from './modal'

/**
 * In-app keyboard-shortcuts cheat sheet (F1 / ?): the shortcut table grouped
 * by category. The dialog is a singleton — pressing the shortcut again closes
 * the open sheet instead of stacking another one.
 */

let openHandle: { close: () => void } | null = null

function isMacPlatform(): boolean {
  return /mac/i.test(navigator.userAgent)
}

/** Renders the whole shortcut table into `container` (also used by tests). */
export function renderShortcutTable(container: HTMLElement, isMac: boolean): void {
  for (const category of SHORTCUT_CATEGORIES) {
    const rows = SHORTCUTS.filter((row) => row.category === category)
    if (rows.length === 0) continue
    container.appendChild(el('h3', 'shortcut-category', category))
    const table = el('table', 'shortcut-table')
    for (const row of rows) {
      const tr = el('tr')
      const keys = el('td', 'shortcut-keys', displayKeysForPlatform(row.keys, isMac) || '—')
      const label = el('td', 'shortcut-label', row.label)
      tr.append(keys, label)
      table.appendChild(tr)
    }
    container.appendChild(table)
  }
}

export function showShortcutHelp(): void {
  if (openHandle) {
    openHandle.close()
    return
  }
  const handle = createModal({ modalClass: 'shortcut-modal', onRequestClose: () => close() })
  const close = (): void => {
    openHandle = null
    handle.close()
  }
  openHandle = { close }

  const header = el('div', 'modal-header')
  const closeButton = el('button', 'modal-close', '×')
  closeButton.title = 'Close the shortcut reference'
  closeButton.addEventListener('click', close)
  header.append(el('h2', 'modal-title', 'Keyboard Shortcuts'), closeButton)

  const body = el('div', 'shortcut-body')
  renderShortcutTable(body, isMacPlatform())
  const notes = el('div', 'shortcut-notes')
  notes.append(
    el('p', undefined, 'Ctrl+C / Ctrl+V act on the timeline keyframes while the timeline was the last clicked surface — otherwise on the selected scene objects.'),
    el('p', undefined, 'Ctrl+X (cut) and Ctrl+D (duplicate) always act on scene objects.'),
    el('p', undefined, 'Holding Space pans the stage; tapping it plays or pauses playback.'),
    el('p', undefined, 'Inside text fields native editing wins over every shortcut except the File menu entries and F1.')
  )
  body.appendChild(notes)
  handle.modal.append(header, body)
}
