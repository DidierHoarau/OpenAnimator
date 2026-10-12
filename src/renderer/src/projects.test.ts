// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReadResult } from '@shared/api'
import { createDocument } from '@shared/document'

import { Editor } from './editor'
import {
  checkUntitledRecovery,
  saveRecoverySnapshot,
  sessionUntitledRecoveryKey,
  setUntitledRecoveryKey,
  showRecoveryDialog
} from './projects'

const RECOVERY_PATH = '/tmp/project.oanim'

function editorFor(): Editor {
  return new Editor(createDocument('recovery', 320, 180, 12))
}

interface ApiStub {
  readRecovery: ReturnType<typeof vi.fn>
  clearRecovery: ReturnType<typeof vi.fn>
  writeRecovery: ReturnType<typeof vi.fn>
  listUnsavedRecoveries: ReturnType<typeof vi.fn>
  saveProjectAs: ReturnType<typeof vi.fn>
  saveProjectTo: ReturnType<typeof vi.fn>
  rememberProject: ReturnType<typeof vi.fn>
  getFontEmbeddingPolicy: ReturnType<typeof vi.fn>
  readSystemFont: ReturnType<typeof vi.fn>
  addResource: ReturnType<typeof vi.fn>
}

function stubApi(overrides: Partial<ApiStub> = {}): ApiStub {
  const api: ApiStub = {
    readRecovery: vi.fn(async (): Promise<ReadResult> => ({ ok: false, error: 'unused' })),
    clearRecovery: vi.fn(async () => undefined),
    writeRecovery: vi.fn(async () => ({ ok: true })),
    listUnsavedRecoveries: vi.fn(async () => []),
    saveProjectAs: vi.fn(async () => ({ canceled: true })),
    saveProjectTo: vi.fn(async () => ({ ok: true })),
    rememberProject: vi.fn(async () => []),
    getFontEmbeddingPolicy: vi.fn(async () => ({ rules: [], defaultAllow: true })),
    readSystemFont: vi.fn(async () => ({ ok: false, error: 'none' })),
    addResource: vi.fn(async () => ({ resourceId: 'resource', deduped: false })),
    ...overrides
  }
  window.api = api as unknown as typeof window.api
  return api
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
    stubApi()
    showRecoveryDialog(editorFor(), {
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
      readRecovery: vi.fn(async () => ({ ok: true, document: recovered, resources: {} }))
    })
    const editor = editorFor()
    showRecoveryDialog(editor, {
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
    const { clearRecovery } = stubApi()
    showRecoveryDialog(editorFor(), {
      path: RECOVERY_PATH,
      name: 'recovery',
      savedAt: 1
    })

    actionButton('Discard').click()

    await vi.waitFor(() => expect(clearRecovery).toHaveBeenCalledWith(RECOVERY_PATH))
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })

  it('offers Save As… for untitled snapshots and Recover adopts their slot', async () => {
    const recovered = createDocument('draft', 640, 360, 24)
    stubApi({
      readRecovery: vi.fn(async () => ({ ok: true, document: recovered, resources: {} }))
    })
    setUntitledRecoveryKey('untitled/other-slot')
    const editor = editorFor()
    showRecoveryDialog(editor, {
      path: 'untitled/session-slot',
      name: 'draft',
      savedAt: 1,
      untitled: true
    })

    expect(document.querySelector('.modal-subtitle')?.textContent).toContain(
      'never-saved document'
    )
    expect(
      [...document.querySelectorAll('.modal-actions button')].map((button) => button.textContent)
    ).toEqual(['Recover', 'Save As…', 'Discard'])

    actionButton('Recover').click()

    await vi.waitFor(() => expect(editor.document).toBe(recovered))
    // The next autosave overwrites the recovered slot, not a fresh one.
    expect(sessionUntitledRecoveryKey()).toBe('untitled/session-slot')
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })

  it('Save As… recovers the snapshot, clears its slot and runs the Save As flow', async () => {
    const recovered = createDocument('draft', 640, 360, 24)
    const { saveProjectAs, clearRecovery } = stubApi({
      readRecovery: vi.fn(async () => ({ ok: true, document: recovered, resources: {} })),
      saveProjectAs: vi.fn(async () => ({ canceled: false, path: '/tmp/saved.oanim' }))
    })
    const editor = editorFor()
    showRecoveryDialog(editor, {
      path: 'untitled/session-slot',
      name: 'draft',
      savedAt: 1,
      untitled: true
    })

    actionButton('Save As…').click()

    await vi.waitFor(() => expect(editor.filePath).toBe('/tmp/saved.oanim'))
    expect(saveProjectAs).toHaveBeenCalledTimes(1)
    // The document now has a file: its untitled slot is done.
    expect(clearRecovery).toHaveBeenCalledWith('untitled/session-slot')
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })
})

describe('saveRecoverySnapshot', () => {
  let previous: typeof window.api

  beforeEach(() => {
    previous = window.api
  })

  afterEach(() => {
    window.api = previous
    document.body.innerHTML = ''
  })

  it('writes an untitled snapshot under the session key with the untitled flag', async () => {
    const { writeRecovery } = stubApi()
    setUntitledRecoveryKey('untitled/test-slot')
    const editor = editorFor()

    await saveRecoverySnapshot(editor)

    expect(writeRecovery).toHaveBeenCalledWith('untitled/test-slot', editor.document, true)
  })

  it('writes file-backed snapshots under the file path', async () => {
    const { writeRecovery } = stubApi()
    const editor = editorFor()
    editor.filePath = '/tmp/project.oanim'

    await saveRecoverySnapshot(editor)

    expect(writeRecovery).toHaveBeenCalledWith('/tmp/project.oanim', editor.document, false)
  })

  it('surfaces a failed autosave with a persistent message and stays silent on success', async () => {
    const { writeRecovery } = stubApi({
      writeRecovery: vi.fn(async () => ({ ok: false, error: 'disk full' }))
    })
    setUntitledRecoveryKey('untitled/test-slot')
    const editor = editorFor()
    const message = vi.fn()
    editor.onMessage(message)

    await saveRecoverySnapshot(editor)
    expect(message).toHaveBeenCalledWith('Autosave failed', {
      persistent: true,
      severity: 'info',
      details: undefined
    })

    message.mockClear()
    writeRecovery.mockResolvedValue({ ok: true })
    await saveRecoverySnapshot(editor)
    expect(message).not.toHaveBeenCalled()
  })
})

describe('checkUntitledRecovery', () => {
  let previous: typeof window.api

  beforeEach(() => {
    previous = window.api
  })

  afterEach(() => {
    window.api = previous
    document.body.innerHTML = ''
  })

  it('offers the newest unsaved snapshot through the recovery dialog', async () => {
    const { readRecovery } = stubApi({
      listUnsavedRecoveries: vi.fn(async () => [
        { path: 'untitled/newest', name: 'newest', savedAt: 20, untitled: true },
        { path: 'untitled/older', name: 'older', savedAt: 10, untitled: true }
      ]),
      readRecovery: vi.fn(async () => ({
        ok: true,
        document: createDocument('newest', 320, 180, 12),
        resources: {}
      }))
    })

    await checkUntitledRecovery(editorFor())
    expect(document.querySelector('.modal-title')?.textContent).toBe('Recover autosaved changes')

    actionButton('Recover').click()
    await vi.waitFor(() => expect(readRecovery).toHaveBeenCalledWith('untitled/newest'))
  })

  it('does nothing when no untitled snapshot is pending', async () => {
    stubApi({ listUnsavedRecoveries: vi.fn(async () => []) })
    await checkUntitledRecovery(editorFor())
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })
})
