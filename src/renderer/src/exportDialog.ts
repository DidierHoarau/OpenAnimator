import { el } from './dom'
import type { Editor } from './editor'
import { defaultExportOptions, sanitizeExportOptions, EXPORT_FORMATS } from '@shared/exportOptions'
import type { ExportOptions } from '@shared/exportOptions'
import { createDefaultExportRunnerDeps, runExport } from './export/runExport'

/**
 * Export dialog: format, resolution scale, fps, frame range and transparent
 * background, with a progress bar and a Cancel button while the export runs.
 * All values are sanitized through the shared export-options module before
 * the runner sees them.
 */
export function showExportDialog(editor: Editor): void {
  const initial = defaultExportOptions(editor.document)

  const overlay = el('div', 'modal-overlay')
  const modal = el('div', 'modal export-modal')

  const header = el('div', 'modal-header')
  const closeButton = el('button', 'modal-close', '×')
  closeButton.title = 'Close the export dialog'
  header.append(el('h2', 'modal-title', 'Export animation'), closeButton)

  const form = el('div', 'export-form')

  const formatSelect = el('select', 'export-format') as HTMLSelectElement
  for (const entry of EXPORT_FORMATS) {
    const option = document.createElement('option')
    option.value = entry.format
    option.textContent = entry.label
    formatSelect.appendChild(option)
  }
  formatSelect.value = initial.format
  const formatField = labeledField('Format', formatSelect)

  const scaleInput = numberInput(initial.scale, 0.25, 4, 0.25)
  const scaleField = labeledField('Resolution scale', scaleInput)

  const fpsInput = numberInput(initial.fps, 1, 60, 1)
  const fpsField = labeledField('Frames per second', fpsInput)

  const fromInput = numberInput(initial.fromFrame + 1, 1, Math.max(1, editor.document.frames ?? 1), 1)
  const toInput = numberInput(initial.toFrame + 1, 1, Math.max(1, editor.document.frames ?? 1), 1)
  const rangeField = labeledField(
    'Frame range',
    row(fromInput, el('span', 'export-range-sep', '–'), toInput)
  )

  const transparentInput = document.createElement('input')
  transparentInput.type = 'checkbox'
  transparentInput.checked = initial.transparent
  const transparentField = labeledField('Transparent background', transparentInput)

  const transparentHint = el(
    'p',
    'modal-subtitle',
    'PNG, GIF, WebM (alpha VP9), Lottie, animated SVG and spritesheet exports can keep transparency; MP4 is always opaque. WebM transparency depends on the environment encoder.'
  )

  const audioHint = el(
    'p',
    'modal-subtitle',
    'WebM and MP4 include the mixed audio tracks (audible audio layers); all other formats are silent.'
  )

  form.append(formatField, scaleField, fpsField, rangeField, transparentField, transparentHint, audioHint)

  const progressWrap = el('div', 'export-progress hidden')
  const progressBar = el('div', 'export-progress-bar')
  progressWrap.appendChild(progressBar)
  const progressLabel = el('span', 'export-progress-label', '')

  const actions = el('div', 'modal-actions')
  const exportButton = el('button', 'primary', 'Export…')
  const cancelButton = el('button', undefined, 'Cancel')
  cancelButton.addEventListener('click', () => overlay.remove())
  closeButton.addEventListener('click', () => overlay.remove())
  actions.append(cancelButton, exportButton)

  // MP4 is the only format that cannot carry an alpha channel; Lottie and
  // dotLottie are vector output, so the raster scale does not apply to them.
  const syncFormatAvailability = (): void => {
    const format = formatSelect.value
    const opaqueOnly = format === 'mp4'
    transparentInput.disabled = opaqueOnly
    if (opaqueOnly) transparentInput.checked = false
    scaleInput.disabled = format === 'lottie' || format === 'dotlottie'
  }
  formatSelect.addEventListener('change', syncFormatAvailability)
  syncFormatAvailability()

  exportButton.addEventListener('click', () => {
    const raw: Partial<ExportOptions> = {
      format: formatSelect.value as ExportOptions['format'],
      scale: Number(scaleInput.value),
      fps: Number(fpsInput.value),
      fromFrame: Number(fromInput.value) - 1,
      toFrame: Number(toInput.value) - 1,
      transparent: transparentInput.checked
    }
    const options = sanitizeExportOptions(raw, editor.document)
    const signal = { canceled: false }
    form.classList.add('hidden')
    progressWrap.classList.remove('hidden')
    exportButton.disabled = true
    void runExport(editor, options, {
      ...createDefaultExportRunnerDeps(editor),
      onProgress: ({ done, total }) => {
        progressBar.style.width = `${Math.round((done / total) * 100)}%`
        progressLabel.textContent = `Rendering frame ${done} of ${total}…`
      }
    }, signal).then((written) => {
      if (written || signal.canceled) overlay.remove()
      else {
        // Failure: restore the form so the options stay editable.
        form.classList.remove('hidden')
        progressWrap.classList.add('hidden')
        exportButton.disabled = false
      }
    })
  })

  modal.append(header, form, progressWrap, progressLabel, actions)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
}

function labeledField(label: string, control: HTMLElement): HTMLElement {
  const field = el('label', 'export-field')
  field.append(el('span', 'export-field-label', label), control)
  return field
}

function numberInput(value: number, min: number, max: number, step: number): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'number'
  input.value = String(value)
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  return input
}

function row(...children: HTMLElement[]): HTMLElement {
  const container = el('div', 'export-row')
  container.append(...children)
  return container
}
