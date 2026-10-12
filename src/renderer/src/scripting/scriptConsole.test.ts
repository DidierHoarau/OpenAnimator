// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDocument } from '@shared/document'
import type { ScriptCommand, ScriptIssue } from '@shared/scripting/commands'
import { Editor } from '../editor'

import { showScriptConsole } from './scriptConsole'

const executeScriptCommands = vi.fn()
vi.mock('./execute', () => ({
  executeScriptCommands: (...args: unknown[]) => executeScriptCommands(...args)
}))

function editor(): Editor {
  return new Editor(createDocument('scripts', 480, 320, 12))
}

const payloadInput = (overlay: HTMLElement): HTMLTextAreaElement =>
  overlay.querySelector<HTMLTextAreaElement>('.script-input')!

const click = (overlay: HTMLElement, label: string): void => {
  const button = [...overlay.querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) => entry.textContent === label
  )
  if (!button) throw new Error(`no ${label} button`)
  button.click()
}

/** The run handler is async (it awaits the executor): let it settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('showScriptConsole', () => {
  beforeEach(() => {
    executeScriptCommands.mockReset()
    document.body.textContent = ''
  })

  it('loads an example payload into the editor area', () => {
    showScriptConsole(editor())
    const overlay = document.querySelector('.modal-overlay')!
    const select = overlay.querySelector<HTMLSelectElement>('.script-example')!
    select.value = '0'
    select.dispatchEvent(new Event('change'))
    expect(payloadInput(overlay).value).toContain('"commands"')
    expect(payloadInput(overlay).value).toContain('"addNode"')
  })

  it('reports invalid JSON without running anything', async () => {
    showScriptConsole(editor())
    const overlay = document.querySelector('.modal-overlay')!
    payloadInput(overlay).value = '{ not json'
    click(overlay, 'Run script')
    await flush()
    const output = overlay.querySelector<HTMLElement>('.script-output')!
    expect(output.classList.contains('hidden')).toBe(false)
    expect(output.textContent).toContain('not valid JSON')
    expect(executeScriptCommands).not.toHaveBeenCalled()
  })

  it('refuses to run a payload that fails schema validation', async () => {
    showScriptConsole(editor())
    const overlay = document.querySelector('.modal-overlay')!
    payloadInput(overlay).value = JSON.stringify({ commands: [{ op: 'bogusOp' }] })
    click(overlay, 'Run script')
    await flush()
    expect(overlay.querySelector<HTMLElement>('.script-output')!.textContent).toContain(
      'Schema errors'
    )
    expect(executeScriptCommands).not.toHaveBeenCalled()
  })

  it('runs a valid payload through the executor and shows the applied count', async () => {
    executeScriptCommands.mockResolvedValue({ applied: 3, issues: [] as ScriptIssue[] })
    showScriptConsole(editor())
    const overlay = document.querySelector('.modal-overlay')!
    const commands: ScriptCommand[] = [{ op: 'seek', frame: 0 }]
    payloadInput(overlay).value = JSON.stringify({ commands })
    click(overlay, 'Run script')
    await flush()
    expect(executeScriptCommands).toHaveBeenCalledTimes(1)
    const [editorArg, runCommands, options] = executeScriptCommands.mock.calls[0] as [
      Editor,
      ScriptCommand[],
      { library?: unknown }
    ]
    expect(editorArg).toBeInstanceOf(Editor)
    expect(runCommands).toEqual(commands)
    expect(options).toMatchObject({ library: undefined })
    expect(overlay.querySelector<HTMLElement>('.script-output')!.textContent).toContain(
      'Applied 3 of 1'
    )
  })

  it('passes the library bridge through to the executor', async () => {
    executeScriptCommands.mockResolvedValue({ applied: 1, issues: [] as ScriptIssue[] })
    const library = { listLibrary: vi.fn(), addLibraryAsset: vi.fn(), addResource: vi.fn() }
    showScriptConsole(editor(), { library })
    const overlay = document.querySelector('.modal-overlay')!
    payloadInput(overlay).value = JSON.stringify({ commands: [{ op: 'seek', frame: 0 }] })
    click(overlay, 'Run script')
    await flush()
    const [, , options] = executeScriptCommands.mock.calls[0] as [
      Editor,
      ScriptCommand[],
      { library?: unknown }
    ]
    expect(options.library).toBe(library)
  })

  it('lists per-command issues after a partial run', async () => {
    executeScriptCommands.mockResolvedValue({
      applied: 1,
      issues: [{ index: 1, message: 'updateNode: node ghost not found', severity: 'error' }]
    })
    showScriptConsole(editor())
    const overlay = document.querySelector('.modal-overlay')!
    payloadInput(overlay).value = JSON.stringify({ commands: [{ op: 'seek', frame: 0 }] })
    click(overlay, 'Run script')
    await flush()
    const output = overlay.querySelector<HTMLElement>('.script-output')!.textContent!
    expect(output).toContain('Applied 1 of 1')
    expect(output).toContain('#1 [error] updateNode: node ghost not found')
  })

  it('closes on Close', () => {
    showScriptConsole(editor())
    const overlay = document.querySelector('.modal-overlay')!
    click(overlay, 'Close')
    expect(document.querySelector('.modal-overlay')).toBeNull()
  })
})
