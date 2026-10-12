// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDocument } from '@shared/document'
import type { ExportOptions } from '@shared/exportOptions'
import { emptyExportPresets } from '@shared/exportPresets'
import type { ExportPresetsData } from '@shared/exportPresets'
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

let storedPresets: ExportPresetsData
const presetApi = {
  loadExportPresets: vi.fn(() => Promise.resolve(storedPresets)),
  saveExportPresets: vi.fn((data: ExportPresetsData) => {
    storedPresets = data
    return Promise.resolve(true)
  })
}

describe('showExportDialog', () => {
  beforeEach(() => {
    runExport.mockReset()
    document.body.textContent = ''
    storedPresets = emptyExportPresets()
    presetApi.loadExportPresets.mockClear()
    presetApi.saveExportPresets.mockClear()
    ;(window as unknown as { api: unknown }).api = presetApi
  })

  it('renders the fields with document-derived defaults', () => {
    showExportDialog(editor())
    const overlay = document.querySelector('.modal-overlay')!
    expect(overlay).not.toBeNull()
    expect(formatSelect(overlay).value).toBe('gif')
    // scale, fps, from, to, GIF loop count.
    const numbers = [...overlay.querySelectorAll<HTMLInputElement>('input[type="number"]')]
    expect(numbers.map((input) => input.value)).toEqual(['1', '12', '1', '8', '0'])
    expect(overlay.textContent).toContain('Format')
    expect(overlay.textContent).toContain('Transparent background')
    expect(overlay.textContent).toContain('Presets')
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

  it('shows the GIF and video-quality controls only for their formats', () => {
    showExportDialog(editor())
    const overlay = document.querySelector('.modal-overlay')!
    const gifFields = overlay.querySelector('.export-gif-fields')!
    const qualityLabel = [...overlay.querySelectorAll('.export-field-label')].find(
      (label) => label.textContent === 'Video quality'
    )!
    const qualityField = qualityLabel.closest('.export-field') as HTMLElement

    // GIF is the default: GIF controls visible, quality hidden.
    expect(gifFields.classList.contains('hidden')).toBe(false)
    expect(qualityField.classList.contains('hidden')).toBe(true)

    formatSelect(overlay).value = 'webm'
    formatSelect(overlay).dispatchEvent(new Event('change'))
    expect(gifFields.classList.contains('hidden')).toBe(true)
    expect(qualityField.classList.contains('hidden')).toBe(false)

    formatSelect(overlay).value = 'mp4'
    formatSelect(overlay).dispatchEvent(new Event('change'))
    expect(qualityField.classList.contains('hidden')).toBe(false)

    formatSelect(overlay).value = 'png-sequence'
    formatSelect(overlay).dispatchEvent(new Event('change'))
    expect(gifFields.classList.contains('hidden')).toBe(true)
    expect(qualityField.classList.contains('hidden')).toBe(true)
  })

  it('passes the GIF palette, dithering and loop choices to the runner', async () => {
    runExport.mockResolvedValue(false)
    showExportDialog(editor())
    const overlay = document.querySelector('.modal-overlay')!

    const palette = overlay.querySelector<HTMLSelectElement>('.export-gif-palette')!
    palette.value = 'global'
    const dither = overlay.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]
    dither.checked = true
    const loop = overlay.querySelectorAll<HTMLInputElement>('input[type="number"]')[4]
    loop.value = '3'
    overlay.querySelector<HTMLButtonElement>('.modal-actions .primary')!.click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const options = runExport.mock.calls[0][1] as ExportOptions
    expect(options.gifPalette).toBe('global')
    expect(options.gifDither).toBe(true)
    expect(options.gifLoop).toBe(3)
  })

  it('passes the video quality tier to the runner for webm exports', async () => {
    runExport.mockResolvedValue(false)
    showExportDialog(editor())
    const overlay = document.querySelector('.modal-overlay')!

    formatSelect(overlay).value = 'webm'
    formatSelect(overlay).dispatchEvent(new Event('change'))
    const quality = overlay.querySelector<HTMLSelectElement>('.export-video-quality')!
    quality.value = 'low'
    overlay.querySelector<HTMLButtonElement>('.modal-actions .primary')!.click()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const options = runExport.mock.calls[0][1] as ExportOptions
    expect(options.videoQuality).toBe('low')
  })

  it('applies the stored last-used settings when the dialog opens', async () => {
    storedPresets = {
      ...emptyExportPresets(),
      lastUsed: {
        format: 'webm',
        scale: 2,
        fps: 24,
        fromFrame: 0,
        toFrame: 3,
        transparent: true,
        gifPalette: 'perFrame',
        gifDither: false,
        gifLoop: 0,
        videoQuality: 'low'
      }
    }
    showExportDialog(editor(8))
    const overlay = document.querySelector('.modal-overlay')!

    await vi.waitFor(() => expect(formatSelect(overlay).value).toBe('webm'))
    const numbers = [...overlay.querySelectorAll<HTMLInputElement>('input[type="number"]')]
    expect(numbers.map((input) => input.value)).toEqual(['2', '24', '1', '4', '0'])
    expect(overlay.querySelector<HTMLSelectElement>('.export-video-quality')!.value).toBe('low')
    expect(overlay.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
  })

  it('saves, applies and deletes named presets through the store', async () => {
    showExportDialog(editor())
    const overlay = document.querySelector('.modal-overlay')!
    await vi.waitFor(() => expect(presetApi.loadExportPresets).toHaveBeenCalled())

    const scale = overlay.querySelectorAll<HTMLInputElement>('input[type="number"]')[0]
    scale.value = '2'
    overlay.querySelector<HTMLInputElement>('.export-preset-name')!.value = 'Teaser'
    overlay.querySelector<HTMLButtonElement>('.export-preset-save')!.click()

    expect(presetApi.saveExportPresets).toHaveBeenCalledTimes(1)
    expect(storedPresets.presets.map((preset) => preset.name)).toEqual(['Teaser'])
    expect(storedPresets.presets[0].options.scale).toBe(2)

    // Reset the form, then load the preset back from the dropdown.
    scale.value = '1'
    const select = overlay.querySelector<HTMLSelectElement>('.export-preset-select')!
    expect([...select.options].map((option) => option.value)).toEqual(['', 'Teaser'])
    select.value = 'Teaser'
    select.dispatchEvent(new Event('change'))
    expect(scale.value).toBe('2')

    // Delete drops it from the store and the dropdown.
    overlay.querySelector<HTMLButtonElement>('.export-preset-delete')!.click()
    expect(presetApi.saveExportPresets).toHaveBeenCalledTimes(2)
    expect(storedPresets.presets).toEqual([])
    expect([...select.options].map((option) => option.value)).toEqual([''])
  })

  it('persists the last-used options after a successful export', async () => {
    runExport.mockResolvedValue(true)
    showExportDialog(editor())
    const overlay = document.querySelector('.modal-overlay')!
    await vi.waitFor(() => expect(presetApi.loadExportPresets).toHaveBeenCalled())

    overlay.querySelector<HTMLButtonElement>('.modal-actions .primary')!.click()
    await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).toBeNull())

    expect(storedPresets.lastUsed).toMatchObject({
      format: 'gif',
      scale: 1,
      fps: 12,
      fromFrame: 0,
      toFrame: 7,
      transparent: false
    })
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
