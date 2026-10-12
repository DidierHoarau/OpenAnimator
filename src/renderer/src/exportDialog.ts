import { el } from './dom'
import type { Editor } from './editor'
import {
  defaultExportOptions,
  sanitizeExportOptions,
  EXPORT_FORMATS,
  GIF_PALETTES,
  VIDEO_QUALITIES
} from '@shared/exportOptions'
import type { ExportOptions } from '@shared/exportOptions'
import {
  emptyExportPresets,
  normalizeExportPresetName,
  removeExportPreset,
  upsertExportPreset,
  withLastUsed,
  EXPORT_PRESET_NAME_MAX
} from '@shared/exportPresets'
import type { ExportPresetsData } from '@shared/exportPresets'
import { createModal } from './modal'
import type { ModalHandle } from './modal'
import { createDefaultExportRunnerDeps, runExport } from './export/runExport'

/**
 * Export dialog: format, resolution scale, fps, frame range and transparent
 * background — plus format-specific controls (GIF palette/dither/loop, video
 * quality) and named export presets backed by the userData store (the last
 * used settings reapply when the dialog opens). All values are sanitized
 * through the shared export-options module before the runner sees them.
 * Cancel (button, × or Escape) mid-export sets the runner's cancel signal;
 * the dialog closes once the runner settles. A successful export carrying
 * diagnostics stays open in a done state with a collapsible list of them.
 */
export function showExportDialog(editor: Editor): void {
  const initial = defaultExportOptions(editor.document)

  const signal = { canceled: false }
  let running = false
  let diagnostics: string[] = []
  let modalHandle: ModalHandle | null = null
  let presetsData: ExportPresetsData = emptyExportPresets()
  /** Set on the first user edit; blocks the async last-used application. */
  let touched = false

  const cancelExport = (): void => {
    if (signal.canceled) return
    signal.canceled = true
    cancelButton.disabled = true
    closeButton.disabled = true
    progressLabel.textContent = 'Cancelling…'
  }
  const requestClose = (): void => {
    if (running) {
      cancelExport()
      return
    }
    modalHandle?.close()
  }

  modalHandle = createModal({ modalClass: 'export-modal', onRequestClose: requestClose })
  const { modal } = modalHandle

  const header = el('div', 'modal-header')
  const closeButton = el('button', 'modal-close', '×')
  closeButton.title = 'Close the export dialog'
  closeButton.addEventListener('click', requestClose)
  header.append(el('h2', 'modal-title', 'Export animation'), closeButton)

  const form = el('div', 'export-form')
  form.addEventListener('input', () => {
    touched = true
  })
  form.addEventListener('change', () => {
    touched = true
  })

  // Presets: the dropdown loads a named preset, Save stores the current
  // settings under the typed name, Delete drops the selected preset.
  const presetSelect = el('select', 'export-preset-select') as HTMLSelectElement
  const presetNameInput = document.createElement('input')
  presetNameInput.type = 'text'
  presetNameInput.className = 'export-preset-name'
  presetNameInput.placeholder = 'Preset name'
  presetNameInput.maxLength = EXPORT_PRESET_NAME_MAX
  const savePresetButton = el('button', 'export-preset-save', 'Save preset')
  const deletePresetButton = el('button', 'export-preset-delete', 'Delete')
  const presetsField = el('div', 'export-field')
  presetsField.append(
    el('span', 'export-field-label', 'Presets'),
    row(presetSelect, deletePresetButton),
    row(presetNameInput, savePresetButton)
  )

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

  const gifPaletteSelect = el('select', 'export-gif-palette') as HTMLSelectElement
  const gifPaletteLabels: Record<(typeof GIF_PALETTES)[number], string> = {
    perFrame: 'Per-frame palette (best quality)',
    global: 'Global palette (smaller, steady)'
  }
  for (const palette of GIF_PALETTES) {
    const option = document.createElement('option')
    option.value = palette
    option.textContent = gifPaletteLabels[palette]
    gifPaletteSelect.appendChild(option)
  }
  gifPaletteSelect.value = initial.gifPalette

  const gifDitherInput = document.createElement('input')
  gifDitherInput.type = 'checkbox'
  gifDitherInput.checked = initial.gifDither

  const gifLoopInput = numberInput(initial.gifLoop, -1, 65535, 1)
  const gifLoopField = labeledField(
    'GIF loop count (0 = forever)',
    row(gifLoopInput, el('span', 'export-range-sep', '−1 plays once'))
  )

  const gifFields = el('div', 'export-gif-fields')
  gifFields.append(
    labeledField('GIF palette', gifPaletteSelect),
    labeledField('Dithering (Floyd–Steinberg)', gifDitherInput),
    gifLoopField
  )

  const qualitySelect = el('select', 'export-video-quality') as HTMLSelectElement
  const qualityLabels: Record<(typeof VIDEO_QUALITIES)[number], string> = {
    low: 'Low (smallest file)',
    medium: 'Medium',
    high: 'High (best quality)'
  }
  for (const tier of VIDEO_QUALITIES) {
    const option = document.createElement('option')
    option.value = tier
    option.textContent = qualityLabels[tier]
    qualitySelect.appendChild(option)
  }
  qualitySelect.value = initial.videoQuality
  const qualityField = labeledField('Video quality', qualitySelect)

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

  form.append(
    presetsField,
    formatField,
    scaleField,
    fpsField,
    rangeField,
    transparentField,
    gifFields,
    qualityField,
    transparentHint,
    audioHint
  )

  const progressWrap = el('div', 'export-progress hidden')
  const progressBar = el('div', 'export-progress-bar')
  progressWrap.appendChild(progressBar)
  const progressLabel = el('span', 'export-progress-label', '')

  // Done state, shown only when a successful export carries diagnostics.
  const doneWrap = el('div', 'export-done hidden')
  const doneTitle = el('p', 'export-done-title', '')
  const diagnosticsDetails = el('details', 'export-diagnostics')
  const diagnosticsSummary = el('summary', undefined, '')
  const diagnosticsList = el('ul', 'export-diagnostics-list')
  diagnosticsDetails.append(diagnosticsSummary, diagnosticsList)
  doneWrap.append(doneTitle, diagnosticsDetails)

  const actions = el('div', 'modal-actions')
  const exportButton = el('button', 'primary', 'Export…')
  const cancelButton = el('button', undefined, 'Cancel')
  cancelButton.addEventListener('click', requestClose)
  actions.append(cancelButton, exportButton)

  // MP4 is the only format that cannot carry an alpha channel; Lottie and
  // dotLottie are vector output, so the raster scale does not apply to them.
  const syncFormatAvailability = (): void => {
    const format = formatSelect.value
    const opaqueOnly = format === 'mp4'
    transparentInput.disabled = opaqueOnly
    if (opaqueOnly) transparentInput.checked = false
    scaleInput.disabled = format === 'lottie' || format === 'dotlottie'
    gifFields.classList.toggle('hidden', format !== 'gif')
    qualityField.classList.toggle('hidden', format !== 'webm' && format !== 'mp4')
  }
  formatSelect.addEventListener('change', syncFormatAvailability)
  syncFormatAvailability()

  const readOptions = (): ExportOptions =>
    sanitizeExportOptions(
      {
        format: formatSelect.value as ExportOptions['format'],
        scale: Number(scaleInput.value),
        fps: Number(fpsInput.value),
        fromFrame: Number(fromInput.value) - 1,
        toFrame: Number(toInput.value) - 1,
        transparent: transparentInput.checked,
        gifPalette: gifPaletteSelect.value as ExportOptions['gifPalette'],
        gifDither: gifDitherInput.checked,
        gifLoop: Number(gifLoopInput.value),
        videoQuality: qualitySelect.value as ExportOptions['videoQuality']
      },
      editor.document
    )

  const applyOptionsToControls = (options: ExportOptions): void => {
    formatSelect.value = options.format
    scaleInput.value = String(options.scale)
    fpsInput.value = String(options.fps)
    fromInput.value = String(options.fromFrame + 1)
    toInput.value = String(options.toFrame + 1)
    transparentInput.checked = options.transparent
    gifPaletteSelect.value = options.gifPalette
    gifDitherInput.checked = options.gifDither
    gifLoopInput.value = String(options.gifLoop)
    qualitySelect.value = options.videoQuality
    syncFormatAvailability()
  }

  const refreshPresetSelect = (selected = presetSelect.value): void => {
    presetSelect.replaceChildren()
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = presetsData.presets.length
      ? 'Load a preset…'
      : 'No presets yet'
    presetSelect.appendChild(placeholder)
    for (const preset of presetsData.presets) {
      const option = document.createElement('option')
      option.value = preset.name
      option.textContent = preset.name
      presetSelect.appendChild(option)
    }
    presetSelect.value = presetsData.presets.some((preset) => preset.name === selected)
      ? selected
      : ''
  }

  const persistPresets = (): void => {
    void window.api.saveExportPresets(presetsData).catch(() => undefined)
  }

  presetSelect.addEventListener('change', () => {
    const preset = presetsData.presets.find((entry) => entry.name === presetSelect.value)
    if (!preset) return
    presetNameInput.value = preset.name
    applyOptionsToControls(sanitizeExportOptions(preset.options, editor.document))
  })

  savePresetButton.addEventListener('click', () => {
    const name = normalizeExportPresetName(presetNameInput.value)
    if (!name) {
      presetNameInput.focus()
      return
    }
    presetsData = upsertExportPreset(presetsData, name, readOptions())
    presetNameInput.value = name
    refreshPresetSelect(name)
    persistPresets()
  })

  deletePresetButton.addEventListener('click', () => {
    const name = presetSelect.value || normalizeExportPresetName(presetNameInput.value)
    if (!name) return
    presetsData = removeExportPreset(presetsData, name)
    presetNameInput.value = ''
    refreshPresetSelect('')
    persistPresets()
  })

  refreshPresetSelect()
  void window.api
    .loadExportPresets()
    .then((data) => {
      presetsData = data
      refreshPresetSelect()
      // Last-used settings reapply on open unless the user already edited.
      if (!touched && data.lastUsed) {
        applyOptionsToControls(sanitizeExportOptions(data.lastUsed, editor.document))
      }
    })
    .catch(() => undefined)

  const showDiagnostics = (entries: string[]): void => {
    form.classList.add('hidden')
    progressWrap.classList.add('hidden')
    progressLabel.classList.add('hidden')
    exportButton.classList.add('hidden')
    cancelButton.textContent = 'Close'
    doneTitle.textContent = `Export finished with ${entries.length} diagnostic${entries.length === 1 ? '' : 's'} to review.`
    diagnosticsSummary.textContent = `${entries.length} diagnostic${entries.length === 1 ? '' : 's'}`
    diagnosticsList.replaceChildren(...entries.map((entry) => el('li', undefined, entry)))
    diagnosticsDetails.open = true
    doneWrap.classList.remove('hidden')
  }

  exportButton.addEventListener('click', () => {
    const options = readOptions()
    diagnostics = []
    running = true
    form.classList.add('hidden')
    progressWrap.classList.remove('hidden')
    exportButton.disabled = true
    void runExport(editor, options, {
      ...createDefaultExportRunnerDeps(editor),
      onProgress: ({ done, total }) => {
        progressBar.style.width = `${Math.round((done / total) * 100)}%`
        progressLabel.textContent = `Rendering frame ${done} of ${total}…`
      },
      onDiagnostics: (entries) => {
        diagnostics = entries
      }
    }, signal).then((written) => {
      running = false
      if (written && !signal.canceled) {
        presetsData = withLastUsed(presetsData, options)
        persistPresets()
      }
      if (signal.canceled) modalHandle?.close()
      else if (written && diagnostics.length > 0) showDiagnostics(diagnostics)
      else if (written) modalHandle?.close()
      else {
        // Failure: restore the form so the options stay editable.
        form.classList.remove('hidden')
        progressWrap.classList.add('hidden')
        exportButton.disabled = false
      }
    })
  })

  modal.append(header, form, progressWrap, progressLabel, doneWrap, actions)
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
