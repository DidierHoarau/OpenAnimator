// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDocument } from '@shared/document'
import type { ExportOptions } from '@shared/exportOptions'
import { Editor } from './editor'

import { showExportDialog } from './exportDialog'

const runExport = vi.fn()
vi.mock('./export/runExport', () => ({
  // createDefaultExportRunnerDeps is only touched when the real runner runs;
  // the dialog test mocks the runner itself.
  createDefaultExportRunnerDeps: () => ({}),
  runExport: (...args: unknown[]) => runExport(...args)
}))

function editor(frames = 8): Editor {
  const document = createDocument('promo', 960, 540, 12)
  document.frames = frames
  return new Editor(document)
}

const formatSelect = (overlay: HTMLElement): HTMLSelectElement =>
  overlay.querySelector<HTMLSelectElement>('.export-format')!

describe('showExportDialog', () => {
  beforeEach(() => {
    runExport.mockReset()
    document.body.textContent = ''
  })

  it('renders the fields with document-derived defaults', () => {
    showExportDialog(editor())
    const overlay = document.querySelector('.modal-overlay')!
    expect(overlay).not.toBeNull()
    expect(formatSelect(overlay).value).toBe('gif')
    const numbers = [...overlay.querySelectorAll<HTMLInputElement>('input[type="number"]')]
    expect(numbers.map((input) => input.value)).toEqual(['1', '12', '1', '8'])
    expect(overlay.textContent).toContain('Format')
    expect(overlay.textContent).toContain('Transparent background')
  })

  it('documents which formats carry audio and which stay silent', () => {
    showExportDialog(editor())
    const overlay = document.querySelector('.modal-overlay')!
    expect(overlay.textContent).toContain(
      'WebM and MP4 include the mixed audio tracks (audible audio layers); all other formats are silent.'
    )
  })

  it('offers all eight export formats', () => {
    showExportDialog(editor())
    const overlay = document.querySelector('.modal-overlay')!
    expect([...formatSelect(overlay).options].map((option) => option.value)).toEqual([
      'png-sequence',
      'gif',
      'webm',
      'mp4',
      'lottie',
      'dotlottie',
      'svg-animation',
      'spritesheet'
    ])
  })

  it('hands sanitized options to the runner and closes on success', async () => {
    runExport.mockResolvedValue(true)
    showExportDialog(editor())
    const overlay = document.querySelector('.modal-overlay')!

    const scale = overlay.querySelectorAll<HTMLInputElement>('input[type="number"]')[0]
    scale.value = '99'
    const from = overlay.querySelectorAll<HTMLInputElement>('input[type="number"]')[2]
    from.value = '0'
    overlay.querySelector<HTMLButtonElement>('.modal-actions .primary')!.click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(runExport).toHaveBeenCalledTimes(1)
    const options = runExport.mock.calls[0][1] as ExportOptions
    expect(options.scale).toBe(4)
    expect(options.fromFrame).toBe(0)
    expect(options.toFrame).toBe(7)
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })

  it('keeps the dialog open when the runner reports failure', async () => {
    runExport.mockResolvedValue(false)
    showExportDialog(editor())
    const overlay = document.querySelector('.modal-overlay')!

    overlay.querySelector<HTMLButtonElement>('.modal-actions .primary')!.click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(document.querySelector('.modal-overlay')).not.toBeNull()
    expect(overlay.querySelector('.export-form')?.classList.contains('hidden')).toBe(false)
  })

  it('disables the transparent option only for MP4', () => {
    showExportDialog(editor())
    const overlay = document.querySelector('.modal-overlay')!
    const transparent = overlay.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(transparent.disabled).toBe(false)

    formatSelect(overlay).value = 'mp4'
    formatSelect(overlay).dispatchEvent(new Event('change'))
    expect(transparent.disabled).toBe(true)
    expect(transparent.checked).toBe(false)

    formatSelect(overlay).value = 'webm'
    formatSelect(overlay).dispatchEvent(new Event('change'))
    expect(transparent.disabled).toBe(false)

    formatSelect(overlay).value = 'gif'
    formatSelect(overlay).dispatchEvent(new Event('change'))
    expect(transparent.disabled).toBe(false)
  })

  it('disables the resolution scale for the vector Lottie formats', () => {
    showExportDialog(editor())
    const overlay = document.querySelector('.modal-overlay')!
    const scale = overlay.querySelectorAll<HTMLInputElement>('input[type="number"]')[0]
    expect(scale.disabled).toBe(false)

    formatSelect(overlay).value = 'lottie'
    formatSelect(overlay).dispatchEvent(new Event('change'))
    expect(scale.disabled).toBe(true)

    formatSelect(overlay).value = 'dotlottie'
    formatSelect(overlay).dispatchEvent(new Event('change'))
    expect(scale.disabled).toBe(true)

    formatSelect(overlay).value = 'svg-animation'
    formatSelect(overlay).dispatchEvent(new Event('change'))
    expect(scale.disabled).toBe(false)
  })

  it('closes on the close and cancel buttons without running the export', () => {
    showExportDialog(editor())
    document.querySelector<HTMLButtonElement>('.modal-close')!.click()
    expect(document.querySelector('.modal-overlay')).toBeNull()
    expect(runExport).not.toHaveBeenCalled()

    showExportDialog(editor())
    const overlay = document.querySelector('.modal-overlay')!
    ;[...overlay.querySelectorAll<HTMLButtonElement>('.modal-actions button')]
      .find((button) => button.textContent === 'Cancel')!
      .click()
    expect(document.querySelector('.modal-overlay')).toBeNull()
    expect(runExport).not.toHaveBeenCalled()
  })
})
