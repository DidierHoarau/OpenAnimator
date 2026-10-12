import { DEFAULT_PREFERENCES, PREFERENCE_LIMITS } from '@shared/preferences'
import type { AppPreferences } from '@shared/preferences'

import { el } from './dom'
import type { Editor } from './editor'
import { createModal } from './modal'
import { getPreferences, updatePreferences } from './preferences'

/**
 * Preferences dialog (Edit → Preferences…): edits the persisted application
 * preferences. Values affecting live editor state (grid, brush, undo depth,
 * autosave) take effect on save; stage size and fps apply to the next new
 * document — the dialog says so where relevant.
 */

interface NumberRow {
  row: HTMLElement
  input: HTMLInputElement
}

function numberRow(
  label: string,
  value: number,
  limits: { min: number; max: number },
  step: string,
  hint?: string
): NumberRow {
  const row = el('label', 'pref-row')
  const name = el('span', 'pref-label', label)
  const input = el('input', 'pref-input') as HTMLInputElement
  input.type = 'number'
  input.min = String(limits.min)
  input.max = String(limits.max)
  input.step = step
  input.value = String(value)
  row.append(name, input)
  if (hint) row.title = hint
  return { row, input }
}

function clampInput(input: HTMLInputElement, min: number, max: number, fallback: number): number {
  const parsed = Number(input.value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

export function showPreferencesDialog(editor: Editor): void {
  const current = getPreferences()
  const handle = createModal({ modalClass: 'preferences-modal' })

  const header = el('div', 'modal-header')
  const closeButton = el('button', 'modal-close', '×')
  closeButton.title = 'Close without saving'
  closeButton.addEventListener('click', () => handle.close())
  header.append(el('h2', 'modal-title', 'Preferences'), closeButton)

  const body = el('div', 'pref-body')

  const documentSection = el('section', 'pref-section')
  documentSection.appendChild(el('h3', 'pref-heading', 'New documents'))
  const width = numberRow('Stage width (px)', current.stageWidth, PREFERENCE_LIMITS.stageWidth, '1')
  const height = numberRow('Stage height (px)', current.stageHeight, PREFERENCE_LIMITS.stageHeight, '1')
  const fps = numberRow('Frame rate (fps)', current.fps, PREFERENCE_LIMITS.fps, '1')
  const demoRow = el('label', 'pref-row')
  const demo = el('input', 'pref-check') as HTMLInputElement
  demo.type = 'checkbox'
  demo.checked = current.showDemoOnNew
  demoRow.append(demo, el('span', 'pref-label', 'Start new documents from the demo scene'))
  documentSection.append(
    width.row,
    height.row,
    fps.row,
    demoRow,
    el('p', 'pref-note', 'Stage size and frame rate apply to the next new document; the demo scene scales to the chosen stage.')
  )
  body.appendChild(documentSection)

  const historySection = el('section', 'pref-section')
  historySection.appendChild(el('h3', 'pref-heading', 'History'))
  const undoDepth = numberRow('Undo depth (steps)', current.undoDepth, PREFERENCE_LIMITS.undoDepth, '1')
  historySection.append(undoDepth.row)
  body.appendChild(historySection)

  const toolsSection = el('section', 'pref-section')
  toolsSection.appendChild(el('h3', 'pref-heading', 'Tools'))
  const brushSize = numberRow('Brush size (px)', current.brushSize, PREFERENCE_LIMITS.brushSize, '1')
  const brushOpacity = numberRow('Brush opacity (0–1)', current.brushOpacity, PREFERENCE_LIMITS.brushOpacity, '0.05')
  const gridSize = numberRow('Grid size (px)', current.gridSize, PREFERENCE_LIMITS.gridSize, '1')
  toolsSection.append(brushSize.row, brushOpacity.row, gridSize.row)
  body.appendChild(toolsSection)

  const autosaveSection = el('section', 'pref-section')
  autosaveSection.appendChild(el('h3', 'pref-heading', 'Autosave'))
  const autosaveRow = el('label', 'pref-row')
  const autosave = el('input', 'pref-check') as HTMLInputElement
  autosave.type = 'checkbox'
  autosave.checked = current.autosaveEnabled
  autosaveRow.append(autosave, el('span', 'pref-label', 'Save recovery snapshots while editing'))
  const autosaveIdle = numberRow('Idle delay (ms)', current.autosaveIdleMs, PREFERENCE_LIMITS.autosaveIdleMs, '100')
  autosaveSection.append(autosaveRow, autosaveIdle.row)
  body.appendChild(autosaveSection)

  const actions = el('div', 'modal-actions')
  const resetButton = el('button', undefined, 'Defaults')
  resetButton.title = 'Fill the form with the default values (not saved yet)'
  resetButton.addEventListener('click', () => {
    width.input.value = String(DEFAULT_PREFERENCES.stageWidth)
    height.input.value = String(DEFAULT_PREFERENCES.stageHeight)
    fps.input.value = String(DEFAULT_PREFERENCES.fps)
    demo.checked = DEFAULT_PREFERENCES.showDemoOnNew
    undoDepth.input.value = String(DEFAULT_PREFERENCES.undoDepth)
    brushSize.input.value = String(DEFAULT_PREFERENCES.brushSize)
    brushOpacity.input.value = String(DEFAULT_PREFERENCES.brushOpacity)
    gridSize.input.value = String(DEFAULT_PREFERENCES.gridSize)
    autosave.checked = DEFAULT_PREFERENCES.autosaveEnabled
    autosaveIdle.input.value = String(DEFAULT_PREFERENCES.autosaveIdleMs)
  })
  const cancelButton = el('button', undefined, 'Cancel')
  cancelButton.addEventListener('click', () => handle.close())
  const saveButton = el('button', 'primary', 'Save')
  saveButton.addEventListener('click', () => {
    const patch: Partial<AppPreferences> = {
      stageWidth: clampInput(width.input, PREFERENCE_LIMITS.stageWidth.min, PREFERENCE_LIMITS.stageWidth.max, current.stageWidth),
      stageHeight: clampInput(height.input, PREFERENCE_LIMITS.stageHeight.min, PREFERENCE_LIMITS.stageHeight.max, current.stageHeight),
      fps: clampInput(fps.input, PREFERENCE_LIMITS.fps.min, PREFERENCE_LIMITS.fps.max, current.fps),
      showDemoOnNew: demo.checked,
      undoDepth: clampInput(undoDepth.input, PREFERENCE_LIMITS.undoDepth.min, PREFERENCE_LIMITS.undoDepth.max, current.undoDepth),
      brushSize: clampInput(brushSize.input, PREFERENCE_LIMITS.brushSize.min, PREFERENCE_LIMITS.brushSize.max, current.brushSize),
      brushOpacity: clampInput(brushOpacity.input, PREFERENCE_LIMITS.brushOpacity.min, PREFERENCE_LIMITS.brushOpacity.max, current.brushOpacity),
      gridSize: clampInput(gridSize.input, PREFERENCE_LIMITS.gridSize.min, PREFERENCE_LIMITS.gridSize.max, current.gridSize),
      autosaveEnabled: autosave.checked,
      autosaveIdleMs: clampInput(autosaveIdle.input, PREFERENCE_LIMITS.autosaveIdleMs.min, PREFERENCE_LIMITS.autosaveIdleMs.max, current.autosaveIdleMs)
    }
    void updatePreferences(patch).then(() => {
      editor.showMessage('Preferences saved')
      handle.close()
    })
  })
  actions.append(resetButton, cancelButton, saveButton)

  handle.modal.append(header, body, actions)
}
