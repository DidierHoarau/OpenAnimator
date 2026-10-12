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

  async function runPendingExport(): Promise<{
    overlay: HTMLElement
    signal: { canceled: boolean }
    resolveRun: (written: boolean) => void
  }> {
    let captured: { canceled: boolean } | null = null
    let resolveRun: (written: boolean) => void = () => undefined
    runExport.mockImplementation((_editor, _options, _deps, signal: { canceled: boolean }) => {
      captured = signal
      return new Promise<boolean>((resolve) => {
        resolveRun = resolve
      })
    })
    showExportDialog(editor())
    const overlay = document.querySelector<HTMLElement>('.modal-overlay')!
    overlay.querySelector<HTMLButtonElement>('.modal-actions .primary')!.click()
    await Promise.resolve()
    if (!captured) throw new Error('the runner did not receive a cancel signal')
    return { overlay, signal: captured, resolveRun }
  }

  it('sets the cancel signal on Cancel mid-export and closes when the runner settles', async () => {
    const { overlay, signal, resolveRun } = await runPendingExport()
    expect(signal.canceled).toBe(false)

    const cancelButton = [...overlay.querySelectorAll<HTMLButtonElement>('.modal-actions button')]
      .find((button) => button.textContent === 'Cancel')!
    cancelButton.click()

    expect(signal.canceled).toBe(true)
    expect(cancelButton.disabled).toBe(true)
    expect(document.querySelector('.export-progress-label')?.textContent).toBe('Cancelling…')
    // The dialog stays until the runner has actually stopped.
    expect(document.querySelector('.modal-overlay')).not.toBeNull()

    resolveRun(false)
    await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).toBeNull())
  })

  it('sets the cancel signal on the × mid-export and ignores a late successful finish', async () => {
    const { overlay, signal, resolveRun } = await runPendingExport()

    overlay.querySelector<HTMLButtonElement>('.modal-close')!.click()
    expect(signal.canceled).toBe(true)
    expect(document.querySelector('.modal-overlay')).not.toBeNull()

    resolveRun(true)
    await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).toBeNull())
  })

  it('keeps the dialog open when the runner fails without a cancel', async () => {
    const { overlay, signal, resolveRun } = await runPendingExport()
    expect(signal.canceled).toBe(false)

    resolveRun(false)
    await vi.waitFor(() =>
      expect(overlay.querySelector('.export-form')?.classList.contains('hidden')).toBe(false)
    )
    expect(document.querySelector('.modal-overlay')).not.toBeNull()
  })

  it('keeps the dialog open in a done state when the export carries diagnostics', async () => {
    const { overlay, resolveRun } = await runPendingExport()
    const deps = runExport.mock.calls[0][2] as {
      onDiagnostics?: (entries: string[]) => void
    }
    deps.onDiagnostics?.(['No font could be loaded for "Missing Font"'])

    resolveRun(true)
    await vi.waitFor(() =>
      expect(overlay.querySelector('.export-done')?.classList.contains('hidden')).toBe(false)
    )

    const details = overlay.querySelector<HTMLDetailsElement>('.export-diagnostics')!
    expect(details.open).toBe(true)
    expect(details.textContent).toContain('No font could be loaded for "Missing Font"')
    expect(overlay.textContent).toContain('1 diagnostic')
    expect(document.querySelector('.modal-overlay')).not.toBeNull()

    const close = [...overlay.querySelectorAll<HTMLButtonElement>('.modal-actions button')].find(
      (button) => button.textContent === 'Close'
    )!
    close.click()
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })
})
