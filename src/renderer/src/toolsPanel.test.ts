// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument } from '@shared/document'

import { Editor } from './editor'
import { buildToolsPanel } from './toolsPanel'

describe('buildToolsPanel', () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor(createDocument('test', 320, 180, 12))
  })

  const toolButtons = (panel: HTMLElement): HTMLButtonElement[] => [
    ...panel.querySelectorAll<HTMLButtonElement>('.tool-button')
  ]
  const disabledTools = (panel: HTMLElement): Array<string | undefined> =>
    toolButtons(panel)
      .filter((button) => button.disabled)
      .map((button) => button.dataset.tool)

  it('renders the grouped tool registry as icon buttons', () => {
    const panel = buildToolsPanel(editor)
    expect(panel.querySelectorAll('.tools-group')).toHaveLength(4)
    expect(toolButtons(panel).map((button) => button.dataset.tool)).toEqual([
      'select',
      'direct',
      'hand',
      'brush',
      'eraser',
      'rect',
      'ellipse',
      'line',
      'pen',
      'vector',
      'text'
    ])
    for (const button of toolButtons(panel)) {
      expect(button.querySelector('svg')).not.toBeNull()
      expect(button.getAttribute('aria-label')).toBeTruthy()
      expect(button.title).toBeTruthy()
    }
  })

  it('marks the active tool and switches tools on click', () => {
    const panel = buildToolsPanel(editor)
    const rect = panel.querySelector<HTMLButtonElement>('[data-tool="rect"]')!
    expect(rect.classList.contains('active')).toBe(false)
    rect.click()
    expect(editor.tool).toBe('rect')
    expect(rect.classList.contains('active')).toBe(true)

    const select = panel.querySelector<HTMLButtonElement>('[data-tool="select"]')!
    select.click()
    expect(editor.tool).toBe('select')
    expect(select.classList.contains('active')).toBe(true)
    expect(rect.classList.contains('active')).toBe(false)
  })

  it('dims tools that cannot act on the current layer kind', () => {
    const panel = buildToolsPanel(editor)
    // The starter layer is an object layer: painting is unavailable.
    expect(disabledTools(panel)).toEqual(['brush', 'eraser'])

    editor.addLayerAtBottom('drawing')
    expect(editor.tool).toBe('brush')
    // A drawing layer takes painting only; everything but Hand is dimmed.
    expect(disabledTools(panel)).toEqual([
      'select',
      'direct',
      'rect',
      'ellipse',
      'line',
      'pen',
      'vector',
      'text'
    ])
  })
})
