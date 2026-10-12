import { el } from './dom'

/** Handle of an in-app modal: the overlay and modal elements plus a `close()`
 * that removes the overlay and restores the previously focused element. */
export interface ModalHandle {
  overlay: HTMLDivElement
  modal: HTMLDivElement
  close(): void
}

export interface ModalOptions {
  /** Extra CSS class for the modal box (e.g. `export-modal`). */
  modalClass?: string
  /** Close request (Escape or the caller's ×) instead of closing immediately —
   * e.g. to cancel a running export first. Defaults to `close()`. */
  onRequestClose?: () => void
  /** Element focused when the modal opens; defaults to the primary button,
   * else the first focusable control. */
  initialFocus?: HTMLElement
}

/** Focusable controls of a modal, in DOM order (disabled controls and
 * anything inside a `.hidden` subtree excluded). */
function focusableWithin(modal: HTMLElement): HTMLElement[] {
  const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  return [...modal.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => !element.hasAttribute('disabled') && !element.hidden && !element.closest('.hidden')
  )
}

function initialFocusTarget(modal: HTMLElement): HTMLElement | null {
  const primary = modal.querySelector<HTMLElement>('button.primary')
  if (primary) return primary
  return focusableWithin(modal).find((element) => !element.classList.contains('modal-close')) ?? null
}

/**
 * Creates a custom modal: an overlay appended to the body with focus trap
 * (Tab/Shift+Tab cycle the modal's controls), Escape-to-close and focus
 * restoration to the element focused before the modal opened. Escape is
 * stopped at the overlay so the app-level Escape shortcut (pen/stroke/
 * playback) never also fires. All listeners live on the overlay, so removing
 * it by other means stays safe.
 */
export function createModal(options: ModalOptions = {}): ModalHandle {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const overlay = el('div', 'modal-overlay')
  const modal = el('div', options.modalClass ? `modal ${options.modalClass}` : 'modal')
  modal.tabIndex = -1

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    overlay.remove()
    if (previousFocus && previousFocus.isConnected) previousFocus.focus()
  }
  const requestClose = (): void => {
    if (options.onRequestClose) options.onRequestClose()
    else close()
  }

  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      requestClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusables = focusableWithin(modal)
    if (focusables.length === 0) {
      event.preventDefault()
      modal.focus()
      return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    const inside = active instanceof HTMLElement && modal.contains(active)
    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault()
        last.focus()
      }
    } else if (!inside || active === last) {
      event.preventDefault()
      first.focus()
    }
  })

  overlay.appendChild(modal)
  document.body.appendChild(overlay)
  // Deferred so the caller's content (built right after this call) is in the
  // DOM before the initial focus target is picked. Content without any
  // focusable control (e.g. the shortcut cheat sheet) focuses the modal box
  // itself, so Escape and Tab still reach the overlay's key handler.
  queueMicrotask(() => {
    if (closed) return
    const target = options.initialFocus ?? initialFocusTarget(modal)
    if (target) target.focus()
    else modal.focus()
  })

  return { overlay, modal, close }
}

export interface ConfirmDialogOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
}

/** In-app replacement for `window.confirm`: resolves true on the confirm
 * button, false on Cancel, Escape or ×. */
export function showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      handle.close()
      resolve(value)
    }
    const handle = createModal({ onRequestClose: () => settle(false) })

    const header = el('div', 'modal-header')
    const closeButton = el('button', 'modal-close', '×')
    closeButton.title = 'Cancel'
    closeButton.addEventListener('click', () => settle(false))
    header.append(el('h2', 'modal-title', options.title), closeButton)

    const actions = el('div', 'modal-actions')
    const cancelButton = el('button', undefined, options.cancelLabel ?? 'Cancel')
    cancelButton.addEventListener('click', () => settle(false))
    const confirmButton = el('button', 'primary', options.confirmLabel ?? 'OK')
    confirmButton.addEventListener('click', () => settle(true))
    actions.append(cancelButton, confirmButton)

    handle.modal.append(header, el('p', 'modal-subtitle', options.message), actions)
  })
}

/** In-app replacement for `window.alert`: resolves when OK, Escape or ×
 * closes the dialog. */
export function showAlertDialog(options: { title: string; message: string }): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      handle.close()
      resolve()
    }
    const handle = createModal({ onRequestClose: settle })

    const header = el('div', 'modal-header')
    const closeButton = el('button', 'modal-close', '×')
    closeButton.title = 'Close this message'
    closeButton.addEventListener('click', settle)
    header.append(el('h2', 'modal-title', options.title), closeButton)

    const actions = el('div', 'modal-actions')
    const okButton = el('button', 'primary', 'OK')
    okButton.addEventListener('click', settle)
    actions.append(okButton)

    handle.modal.append(header, el('p', 'modal-subtitle', options.message), actions)
  })
}
