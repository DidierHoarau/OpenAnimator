// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDocument } from '@shared/document'

import { Editor } from './editor'
import { registerCloseGuard } from './closeGuard'

interface ApiStub {
  onCloseRequest: (listener: () => void) => () => void
  respondToCloseRequest: ReturnType<typeof vi.fn>
  saveProjectTo: ReturnType<typeof vi.fn>
  saveProjectAs: ReturnType<typeof vi.fn>
  clearRecovery: ReturnType<typeof vi.fn>
  rememberProject: ReturnType<typeof vi.fn>
}

function stubApi(): { api: ApiStub; requestClose: () => void } {
  let listener: (() => void) | null = null
  const api: ApiStub = {
    onCloseRequest: (value) => {
      listener = value
      return () => {
        listener = null
      }
    },
    respondToCloseRequest: vi.fn(async () => undefined),
    saveProjectTo: vi.fn(async () => ({ ok: true })),
    saveProjectAs: vi.fn(async () => ({ canceled: false, path: '/tmp/saved.oanim' })),
    clearRecovery: vi.fn(async () => undefined),
    rememberProject: vi.fn(async () => [])
  }
  window.api = api as unknown as typeof window.api
  return { api, requestClose: () => listener?.() }
}

function dirtyEditor(filePath: string | null = null): Editor {
  const editor = new Editor(createDocument('close-guard', 320, 180, 12))
  editor.filePath = filePath
  editor.dirty = true
  return editor
}

function actionButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.modal-actions button')].find(
    (candidate) => candidate.textContent === label
  )
  if (!button) throw new Error(`missing action button: ${label}`)
  return button
}

describe('registerCloseGuard', () => {
  let previous: typeof window.api

  beforeEach(() => {
    previous = window.api
  })

  afterEach(() => {
    window.api = previous
    document.body.innerHTML = ''
  })

  it('allows a clean document to close without a prompt', async () => {
    const { api, requestClose } = stubApi()
    const editor = dirtyEditor()
    editor.dirty = false
    registerCloseGuard(editor)

    requestClose()
    await vi.waitFor(() => expect(api.respondToCloseRequest).toHaveBeenCalledWith(true))
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })

  it('shows a Save / Discard / Cancel prompt for a dirty document', async () => {
    const { api, requestClose } = stubApi()
    registerCloseGuard(dirtyEditor('/tmp/doc.oanim'))

    requestClose()
    await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).not.toBeNull())
    expect(document.querySelector('.modal-title')?.textContent).toBe('Unsaved changes')
    expect(
      [...document.querySelectorAll('.modal-actions button')].map((button) => button.textContent)
    ).toEqual(['Cancel', 'Discard', 'Save'])
    expect(api.respondToCloseRequest).not.toHaveBeenCalled()
  })

  it('Save writes the document and allows the close on success', async () => {
    const { api, requestClose } = stubApi()
    const editor = dirtyEditor('/tmp/doc.oanim')
    registerCloseGuard(editor)

    requestClose()
    await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).not.toBeNull())
    actionButton('Save').click()

    await vi.waitFor(() => expect(api.respondToCloseRequest).toHaveBeenCalledWith(true))
    expect(api.saveProjectTo).toHaveBeenCalledWith('/tmp/doc.oanim', editor.document)
    expect(editor.dirty).toBe(false)
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })

  it('Save on an untitled document runs Save As and allows the close', async () => {
    const { api, requestClose } = stubApi()
    const editor = dirtyEditor(null)
    registerCloseGuard(editor)

    requestClose()
    await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).not.toBeNull())
    actionButton('Save').click()

    await vi.waitFor(() => expect(api.respondToCloseRequest).toHaveBeenCalledWith(true))
    expect(api.saveProjectAs).toHaveBeenCalledTimes(1)
    expect(editor.filePath).toBe('/tmp/saved.oanim')
  })

  it('a canceled Save As keeps the prompt open until the user decides', async () => {
    const { api, requestClose } = stubApi()
    api.saveProjectAs.mockResolvedValue({ canceled: true })
    registerCloseGuard(dirtyEditor(null))

    requestClose()
    await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).not.toBeNull())
    actionButton('Save').click()

    await vi.waitFor(() => expect(actionButton('Save').disabled).toBe(false))
    expect(api.respondToCloseRequest).not.toHaveBeenCalled()
    expect(document.querySelector('.modal-overlay')).not.toBeNull()

    actionButton('Discard').click()
    await vi.waitFor(() => expect(api.respondToCloseRequest).toHaveBeenCalledWith(true))
  })

  it('Discard allows the close without saving', async () => {
    const { api, requestClose } = stubApi()
    registerCloseGuard(dirtyEditor('/tmp/doc.oanim'))

    requestClose()
    await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).not.toBeNull())
    actionButton('Discard').click()

    await vi.waitFor(() => expect(api.respondToCloseRequest).toHaveBeenCalledWith(true))
    expect(api.saveProjectTo).not.toHaveBeenCalled()
  })

  it('Cancel denies the close and keeps the document', async () => {
    const { api, requestClose } = stubApi()
    registerCloseGuard(dirtyEditor('/tmp/doc.oanim'))

    requestClose()
    await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).not.toBeNull())
    actionButton('Cancel').click()

    await vi.waitFor(() => expect(api.respondToCloseRequest).toHaveBeenCalledWith(false))
    expect(document.querySelector('.modal-overlay')).toBeNull()
    expect(api.saveProjectTo).not.toHaveBeenCalled()
  })
})
