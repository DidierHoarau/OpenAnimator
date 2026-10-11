import { el } from '../dom'
import type { Editor } from '../editor'
import { validateScriptPayload } from '@shared/scripting/commands'
import type { ScriptIssue } from '@shared/scripting/commands'
import { SCRIPT_EXAMPLES } from '@shared/scripting/examples'
import { executeScriptCommands } from './execute'

/**
 * Script console: paste (or generate) a JSON command payload, validate it
 * against the command schema, and run it through the same editor pipeline as
 * UI gestures. Validation errors and per-command issues are shown inline so
 * the payload can be repaired and retried (validate-and-retry flow).
 */
export function showScriptConsole(editor: Editor): void {
  const overlay = el('div', 'modal-overlay')
  const modal = el('div', 'modal script-modal')

  const header = el('div', 'modal-header')
  const closeButton = el('button', 'modal-close', '×')
  closeButton.title = 'Close the script console'
  header.append(el('h2', 'modal-title', 'Script console'), closeButton)

  const payloadInput = el('textarea', 'script-input') as HTMLTextAreaElement
  payloadInput.spellcheck = false
  payloadInput.placeholder =
    'Paste a {"commands": [...]} payload, or pick an example below. See docs/scripting.md.'
  payloadInput.rows = 14

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

  const output = el('pre', 'script-output hidden')

  const actions = el('div', 'modal-actions')
  const cancelButton = el('button', undefined, 'Close')
  const validateButton = el('button', undefined, 'Validate')
  const runButton = el('button', 'primary', 'Run script')
  cancelButton.addEventListener('click', () => overlay.remove())
  closeButton.addEventListener('click', () => overlay.remove())
  actions.append(cancelButton, validateButton, runButton)

  const showIssues = (title: string, issues: ScriptIssue[]): void => {
    output.classList.remove('hidden')
    output.textContent = [
      title,
      ...issues.map((issue) => `#${issue.index} [${issue.severity}] ${issue.message}`)
    ].join('\n')
  }

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
    const result = executeScriptCommands(editor, commands)
    if (result.issues.length === 0) {
      showIssues(`Applied ${result.applied} of ${commands.length} command(s) with no issues.`, [])
    } else {
      showIssues(
        `Applied ${result.applied} of ${commands.length} command(s), ${result.issues.length} issue(s):`,
        result.issues
      )
    }
  })

  modal.append(header, exampleSelect, payloadInput, output, actions)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
  payloadInput.focus()
}

function issuesFromMessages(messages: string[]): ScriptIssue[] {
  return messages.map((message, index) => ({ index, message, severity: 'error' as const }))
}
