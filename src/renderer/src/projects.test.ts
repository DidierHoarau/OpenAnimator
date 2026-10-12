// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReadResult } from '@shared/api'
import { createDocument } from '@shared/document'

import { Editor } from './editor'
import { showRecoveryDialog } from './projects'

const RECOVERY_PATH = '/tmp/project.oanim'

function editorFor(): Editor {
  return new Editor(createDocument('recovery', 320, 180, 12))
}

function stubApi(result: ReadResult): {
  readRecovery: ReturnType<typeof vi.fn>
  clearRecovery: ReturnType<typeof vi.fn>
} {
  const readRecovery = vi.fn(async () => result)
  const clearRecovery = vi.fn(async () => undefined)
  window.api = { readRecovery, clearRecovery } as unknown as typeof window.api
  return { readRecovery, clearRecovery }
}

function actionButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.modal-actions button')].find(
    (candidate) => candidate.textContent === label
  )
  if (!button) throw new Error(`missing action button: ${label}`)
  return button
}

describe('showRecoveryDialog', () => {
  let previous: typeof window.api

  beforeEach(() => {
    previous = window.api
  })

  afterEach(() => {
    window.api = previous
    document.body.innerHTML = ''
  })

  it('renders the project name with Recover and Discard actions', () => {
    stubApi({ ok: false, error: 'unused' })
    showRecoveryDialog(editorFor(), RECOVERY_PATH, {
      path: RECOVERY_PATH,
      name: 'demo',
      savedAt: 1
    })

    expect(document.querySelector('.modal-title')?.textContent).toBe('Recover autosaved changes')
    expect(document.querySelector('.modal-subtitle')?.textContent).toContain('demo')
    expect(
      [...document.querySelectorAll('.modal-actions button')].map((button) => button.textContent)
    ).toEqual(['Recover', 'Discard'])
  })

  it('Recover loads the snapshot into the editor, keeps it on disk and closes the dialog', async () => {
    const recovered = createDocument('recovered', 640, 360, 24)
    const { readRecovery, clearRecovery } = stubApi({
      ok: true,
      document: recovered,
      resources: {}
    })
    const editor = editorFor()
    showRecoveryDialog(editor, RECOVERY_PATH, {
      path: RECOVERY_PATH,
      name: 'recovery',
      savedAt: 1
    })

    actionButton('Recover').click()

    await vi.waitFor(() => expect(editor.document).toBe(recovered))
    expect(readRecovery).toHaveBeenCalledWith(RECOVERY_PATH)
    // The recovered document is dirty so the next autosave re-snapshots it.
    expect(editor.dirty).toBe(true)
    expect(clearRecovery).not.toHaveBeenCalled()
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })

  it('Discard clears the snapshot and closes the dialog', async () => {
    const { clearRecovery } = stubApi({ ok: false, error: 'unused' })
    showRecoveryDialog(editorFor(), RECOVERY_PATH, {
      path: RECOVERY_PATH,
      name: 'recovery',
      savedAt: 1
    })

    actionButton('Discard').click()

    await vi.waitFor(() => expect(clearRecovery).toHaveBeenCalledWith(RECOVERY_PATH))
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })
})
