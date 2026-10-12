// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import { createStarterDocument } from '@shared/starterDocument'
import { validateScriptPayload } from '@shared/scripting/commands'

import { Editor } from '../editor'
import { getScriptRecorder } from './scriptRecorder'
import { showScriptConsole } from './scriptConsole'

function createEditor(): Editor {
  return new Editor(createStarterDocument(), {
    measureText: (line: string) => line.length * 10
  })
}

interface ConsoleHandles {
  recordButton: HTMLButtonElement
  insertButton: HTMLButtonElement
  recordCount: HTMLElement
  payloadInput: HTMLTextAreaElement
  output: HTMLElement
  closeButton: HTMLButtonElement
}

function openConsole(editor: Editor): ConsoleHandles {
  showScriptConsole(editor)
  const modal = document.querySelector('.script-modal')
  if (!modal) throw new Error('expected the script modal')
  return {
    recordButton: modal.querySelector('.script-record') as HTMLButtonElement,
    insertButton: modal.querySelector('.script-record-insert') as HTMLButtonElement,
    recordCount: modal.querySelector('.script-record-count') as HTMLElement,
    payloadInput: modal.querySelector('.script-input') as HTMLTextAreaElement,
    output: modal.querySelector('.script-output') as HTMLElement,
    closeButton: modal.querySelector('.modal-actions button') as HTMLButtonElement
  }
}

afterEach(() => {
  document.querySelectorAll('.modal-overlay').forEach((overlay) => overlay.remove())
})

describe('script console recording', () => {
  it('toggles recording, counts commits and inserts the captured payload', () => {
    const editor = createEditor()
    const ui = openConsole(editor)
    expect(ui.recordButton.textContent).toBe('Record')
    expect(ui.insertButton.disabled).toBe(true)

    ui.recordButton.click()
    expect(ui.recordButton.textContent).toBe('Stop recording')
    expect(ui.recordCount.textContent).toBe('Recording — 0 command(s)')

    editor.setFps(48)
    editor.setPalette(['#112233'])
    expect(ui.recordCount.textContent).toBe('Recording — 1 command(s)')

    ui.recordButton.click()
    expect(ui.recordButton.textContent).toBe('Record')
    expect(ui.recordCount.textContent).toBe('2 command(s) captured')
    expect(ui.insertButton.disabled).toBe(false)

    ui.insertButton.click()
    const { commands, errors } = validateScriptPayload(JSON.parse(ui.payloadInput.value))
    expect(errors).toEqual([])
    expect(commands).toEqual([
      { op: 'setFps', fps: 48 },
      { op: 'setPalette', colors: ['#112233'] }
    ])
    expect(ui.output.textContent).toContain('Inserted 2 recorded command(s)')
    expect(ui.recordCount.textContent).toBe('')
    expect(ui.insertButton.disabled).toBe(true)
  })

  it('stops an in-flight recording with nothing captured', () => {
    const editor = createEditor()
    const ui = openConsole(editor)

    ui.recordButton.click()
    ui.insertButton.click()
    expect(ui.output.textContent).toContain('Nothing was recorded.')
    expect(ui.recordButton.textContent).toBe('Record')
    expect(ui.payloadInput.value).toBe('')
    expect(ui.insertButton.disabled).toBe(true)
    expect(getScriptRecorder(editor).recording).toBe(false)
  })

  it('keeps the capture across a reopen and closes through Escape', () => {
    const editor = createEditor()
    const first = openConsole(editor)

    first.recordButton.click()
    editor.setFps(48)
    editor.setPalette(['#112233'])
    first.closeButton.click()
    expect(document.querySelector('.script-modal')).toBe(null)

    const second = openConsole(editor)
    expect(second.recordButton.textContent).toBe('Stop recording')
    expect(second.recordCount.textContent).toBe('Recording — 1 command(s)')

    second.insertButton.click()
    const { commands, errors } = validateScriptPayload(JSON.parse(second.payloadInput.value))
    expect(errors).toEqual([])
    expect(commands).toEqual([
      { op: 'setFps', fps: 48 },
      { op: 'setPalette', colors: ['#112233'] }
    ])

    const overlay = document.querySelector('.modal-overlay')
    if (!overlay) throw new Error('expected the modal overlay')
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.script-modal')).toBe(null)
  })
})
