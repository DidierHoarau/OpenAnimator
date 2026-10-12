import { el } from '../dom'
import type { Editor } from '../editor'
import { createModal } from '../modal'
import { validateScriptPayload } from '@shared/scripting/commands'
import type { ScriptIssue } from '@shared/scripting/commands'
import { SCRIPT_EXAMPLES } from '@shared/scripting/examples'
import {
  executeScriptCommands,
  type ScriptExportBridge,
  type ScriptGlobalPaletteBridge,
  type ScriptImportAudioBridge,
  type ScriptImportImageBridge,
  type ScriptLibraryBridge,
  type ScriptPreferencesBridge
} from './execute'
import { getScriptRecorder } from './scriptRecorder'

/** Options of the console; `library` enables the My Library commands
 * (the renderer passes `window.api`), `preferences` the settings command,
 * `globalPalette` the global palette commands and `export`/`importImage`/
 * `importAudio` the file-IO commands (see `scriptBridges.ts`). */
export interface ScriptConsoleOptions {
  library?: ScriptLibraryBridge
  preferences?: ScriptPreferencesBridge
  globalPalette?: ScriptGlobalPaletteBridge
  export?: ScriptExportBridge
  importImage?: ScriptImportImageBridge
  importAudio?: ScriptImportAudioBridge
}

/**
 * Script console: paste (or generate) a JSON command payload, validate it
 * against the command schema, and run it through the same editor pipeline as
 * UI gestures. Validation errors and per-command issues are shown inline so
 * the payload can be repaired and retried (validate-and-retry flow).
 *
 * The Record toggle arms the per-editor script recorder: every committed
 * gesture — drags included — is diffed into commands, and Stop & insert
 * prefills the payload with the capture. Running it goes through the normal
 * Validate/Run path; the recorder never executes anything itself.
 */
export function showScriptConsole(editor: Editor, options: ScriptConsoleOptions = {}): void {
  const payloadInput = el('textarea', 'script-input') as HTMLTextAreaElement
  payloadInput.spellcheck = false
  payloadInput.placeholder =
    'Paste a {"commands": [...]} payload, or pick an example below. See docs/scripting.md.'
  payloadInput.rows = 14

  const recorder = getScriptRecorder(editor)

  let closeConsole = (): void => {}
  const { modal, close } = createModal({
    modalClass: 'script-modal',
    initialFocus: payloadInput,
    onRequestClose: () => closeConsole()
  })
  let unsubscribeRecorder: (() => void) | null = null
  closeConsole = (): void => {
    unsubscribeRecorder?.()
    unsubscribeRecorder = null
    close()
  }

  const header = el('div', 'modal-header')
  const closeButton = el('button', 'modal-close', '×')
  closeButton.title = 'Close the script console'
  closeButton.addEventListener('click', closeConsole)
  header.append(el('h2', 'modal-title', 'Script console'), closeButton)

  const exampleSelect = el('select', 'script-example') as HTMLSelectElement
  exampleSelect.appendChild(document.createElement('option'))
  ;(exampleSelect.firstChild as HTMLOptionElement).value = ''
  ;(exampleSelect.firstChild as HTMLOptionElement).textContent = 'Load an example…'
  SCRIPT_EXAMPLES.forEach((example, index) => {
    const option = document.createElement('option')
    option.value = String(index)
    option.textContent = `${example.name} — ${example.description}`
    exampleSelect.appendChild(option)
  })
  exampleSelect.addEventListener('change', () => {
    const example = SCRIPT_EXAMPLES[Number(exampleSelect.value)]
    if (example) payloadInput.value = JSON.stringify({ commands: example.commands }, null, 2)
  })

  const recordBar = el('div', 'script-record-bar')
  const recordButton = el('button', 'script-record', 'Record')
  recordButton.title = 'Record every committed gesture as script commands'
  const insertButton = el('button', 'script-record-insert', 'Stop & insert')
  insertButton.title = 'Stop recording and insert the captured commands into the payload'
  const recordCount = el('span', 'script-record-count')
  recordBar.append(recordButton, insertButton, recordCount)

  const output = el('pre', 'script-output hidden')

  const actions = el('div', 'modal-actions')
  const cancelButton = el('button', undefined, 'Close')
  const validateButton = el('button', undefined, 'Validate')
  const runButton = el('button', 'primary', 'Run script')
  cancelButton.addEventListener('click', closeConsole)
  actions.append(cancelButton, validateButton, runButton)

  const showIssues = (title: string, issues: ScriptIssue[], notes: readonly string[] = []): void => {
    output.classList.remove('hidden')
    output.textContent = [
      title,
      ...notes.map((note) => `note: ${note}`),
      ...issues.map((issue) => `#${issue.index} [${issue.severity}] ${issue.message}`)
    ].join('\n')
  }

  const syncRecordUi = (): void => {
    const recording = recorder.recording
    recordButton.textContent = recording ? 'Stop recording' : 'Record'
    recordButton.classList.toggle('active', recording)
    insertButton.disabled = !recording && recorder.steps === 0
    if (recording) recordCount.textContent = `Recording — ${recorder.steps} command(s)`
    else if (recorder.steps > 0) recordCount.textContent = `${recorder.steps} command(s) captured`
    else recordCount.textContent = ''
  }

  recordButton.addEventListener('click', () => {
    if (recorder.recording) recorder.stop()
    else recorder.start()
  })

  insertButton.addEventListener('click', () => {
    const { commands, unsupported } = recorder.take()
    if (commands.length === 0) {
      showIssues('Nothing was recorded.', [], unsupported)
      return
    }
    payloadInput.value = JSON.stringify({ commands }, null, 2)
    showIssues(
      `Inserted ${commands.length} recorded command(s) into the payload — validate and run them.`,
      [],
      unsupported
    )
  })

  validateButton.addEventListener('click', () => {
    let payload: unknown
    try {
      payload = JSON.parse(payloadInput.value)
    } catch (error) {
      showIssues('The payload is not valid JSON:', [
        { index: 0, message: error instanceof Error ? error.message : String(error), severity: 'error' }
      ])
      return
    }
    const { commands, errors } = validateScriptPayload(payload)
    if (errors.length > 0) {
      showIssues(`Schema errors (${errors.length}):`, issuesFromMessages(errors))
    } else {
      showIssues(`Payload is valid — ${commands.length} command(s) ready to run.`, [])
    }
  })

  runButton.addEventListener('click', () => {
    void (async () => {
      let payload: unknown
      try {
        payload = JSON.parse(payloadInput.value)
      } catch (error) {
        showIssues('The payload is not valid JSON:', [
          { index: 0, message: error instanceof Error ? error.message : String(error), severity: 'error' }
        ])
        return
      }
      const { commands, errors } = validateScriptPayload(payload)
      if (errors.length > 0) {
        showIssues(`Schema errors (${errors.length}) — nothing ran:`, issuesFromMessages(errors))
        return
      }
      const result = await executeScriptCommands(editor, commands, {
        library: options.library,
        preferences: options.preferences,
        globalPalette: options.globalPalette,
        export: options.export,
        importImage: options.importImage,
        importAudio: options.importAudio
      })
      if (result.issues.length === 0) {
        showIssues(`Applied ${result.applied} of ${commands.length} command(s) with no issues.`, [])
      } else {
        showIssues(
          `Applied ${result.applied} of ${commands.length} command(s), ${result.issues.length} issue(s):`,
          result.issues
        )
      }
    })()
  })

  unsubscribeRecorder = recorder.onChange(syncRecordUi)
  syncRecordUi()

  modal.append(header, exampleSelect, recordBar, payloadInput, output, actions)
  payloadInput.focus()
}

function issuesFromMessages(messages: string[]): ScriptIssue[] {
  return messages.map((message, index) => ({ index, message, severity: 'error' as const }))
}
