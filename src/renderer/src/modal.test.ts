// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { el } from './dom'
import { createModal, showAlertDialog, showConfirmDialog } from './modal'

function pressKey(target: HTMLElement, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

async function microtask(): Promise<void> {
  await Promise.resolve()
}

afterEach(() => {
  document.body.textContent = ''
})

describe('createModal', () => {
  it('traps Tab and Shift+Tab inside the modal', async () => {
    const handle = createModal()
    const first = el('button', 'primary', 'One')
    const last = el('button', undefined, 'Two')
    handle.modal.append(first, last)
    await microtask()
    // The primary button receives the initial focus.
    expect(document.activeElement).toBe(first)

    last.focus()
    expect(pressKey(last, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    first.focus()
    expect(pressKey(first, 'Tab', true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
    // Between the boundaries the browser's natural order is left alone.
    first.focus()
    expect(pressKey(first, 'Tab').defaultPrevented).toBe(false)
  })

  it('closes on Escape and does not leak the key to the window listeners', async () => {
    const windowListener = vi.fn()
    window.addEventListener('keydown', windowListener)
    const handle = createModal()
    const button = el('button', 'primary', 'OK')
    handle.modal.append(button)
    await microtask()

    const event = pressKey(button, 'Escape')
    expect(event.defaultPrevented).toBe(true)
    expect(windowListener).not.toHaveBeenCalled()
    expect(document.querySelector('.modal-overlay')).toBeNull()
    window.removeEventListener('keydown', windowListener)
  })

  it('restores the focus that was active before the modal opened', async () => {
    const outside = el('button', undefined, 'Outside')
    document.body.appendChild(outside)
    outside.focus()

    const handle = createModal()
    const button = el('button', 'primary', 'Inside')
    handle.modal.append(button)
    await microtask()
    expect(document.activeElement).toBe(button)

    handle.close()
    expect(document.activeElement).toBe(outside)
    // A second close is a no-op.
    handle.close()
  })

  it('routes Escape and the caller close request through onRequestClose', async () => {
    const onRequestClose = vi.fn()
    const handle = createModal({ onRequestClose })
    handle.modal.append(el('button', 'primary', 'OK'))
    await microtask()

    pressKey(handle.overlay, 'Escape')
    expect(onRequestClose).toHaveBeenCalledTimes(1)
    // The overlay stays until the caller decides.
    expect(document.querySelector('.modal-overlay')).not.toBeNull()
  })

  it('uses the requested initial focus when provided', async () => {
    const input = el('input', 'custom')
    const handle = createModal({ initialFocus: input })
    handle.modal.append(el('button', 'primary', 'Button'), input)
    await microtask()

    expect(document.activeElement).toBe(input)
  })
})

describe('showConfirmDialog', () => {
  it('resolves true on the confirm button', async () => {
    const promise = showConfirmDialog({
      title: 'Unsaved changes',
      message: 'Discard unsaved changes?',
      confirmLabel: 'Discard'
    })
    await microtask()
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.modal-actions button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['Cancel', 'Discard'])
    expect(document.querySelector('.modal-title')?.textContent).toBe('Unsaved changes')
    expect(document.querySelector('.modal-subtitle')?.textContent).toBe('Discard unsaved changes?')

    buttons.find((button) => button.textContent === 'Discard')!.click()
    await expect(promise).resolves.toBe(true)
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })

  it('resolves false on Cancel, × and Escape', async () => {
    for (const close of ['cancel', 'close', 'escape'] as const) {
      const promise = showConfirmDialog({ title: 'Unsaved changes', message: 'Discard?' })
      await microtask()
      if (close === 'cancel') {
        ;[...document.querySelectorAll<HTMLButtonElement>('.modal-actions button')]
          .find((button) => button.textContent === 'Cancel')!
          .click()
      } else if (close === 'close') {
        document.querySelector<HTMLButtonElement>('.modal-close')!.click()
      } else {
        pressKey(document.querySelector<HTMLElement>('.modal .primary')!, 'Escape')
      }
      await expect(promise).resolves.toBe(false)
      expect(document.querySelector('.modal-overlay')).toBeNull()
    }
  })
})

describe('showAlertDialog', () => {
  it('resolves when OK is clicked', async () => {
    const promise = showAlertDialog({ title: 'Import failed', message: 'Could not read the image.' })
    await microtask()
    expect(document.querySelector('.modal-title')?.textContent).toBe('Import failed')
    expect(
      [...document.querySelectorAll<HTMLButtonElement>('.modal-actions button')].map(
        (button) => button.textContent
      )
    ).toEqual(['OK'])

    document.querySelector<HTMLButtonElement>('.modal-actions .primary')!.click()
    await expect(promise).resolves.toBeUndefined()
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })

  it('resolves when dismissed with Escape', async () => {
    const promise = showAlertDialog({ title: 'Import failed', message: 'Could not read the file.' })
    await microtask()
    pressKey(document.querySelector<HTMLElement>('.modal .primary')!, 'Escape')
    await expect(promise).resolves.toBeUndefined()
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })
})
