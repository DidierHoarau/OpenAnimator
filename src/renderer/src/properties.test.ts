// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument } from '@shared/document'
import type { PrimitiveNode } from '@shared/model'

import { Editor } from './editor'
import { PropertiesView } from './properties'
import { SECTION_STORAGE_KEY, loadSectionState } from './sectionState'

function rect(id: string, x: number, y: number): PrimitiveNode {
  return {
    id,
    type: 'primitive',
    primitive: 'rect',
    center: { x, y },
    width: 100,
    height: 50,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1
  }
}

describe('PropertiesView sections', () => {
  let editor: Editor
  let container: HTMLElement

  beforeEach(() => {
    window.localStorage.clear()
    document.body.textContent = ''
    editor = new Editor(createDocument('test', 960, 540, 24))
    container = document.createElement('aside')
    document.body.appendChild(container)
    new PropertiesView(editor, container)
  })

  it('renders the layer, shape and group sections', () => {
    const titles = [...container.querySelectorAll('.panel-section-title')].map((node) =>
      node.textContent?.trim()
    )
    expect(titles).toEqual(['Layer', 'Shape', 'Group'])
  })

  it('shows the shape section for primitives and the group section for groups', () => {
    const shapeSection = container.querySelectorAll('.panel-section')[1]
    const groupSection = container.querySelectorAll('.panel-section')[2]
    expect(shapeSection.classList.contains('hidden')).toBe(true)
    expect(groupSection.classList.contains('hidden')).toBe(true)

    editor.addNode(rect('a', 10, 10))
    expect(shapeSection.classList.contains('hidden')).toBe(false)
    expect(groupSection.classList.contains('hidden')).toBe(true)

    editor.selectNodes([], 'replace')
    expect(shapeSection.classList.contains('hidden')).toBe(true)
    expect(groupSection.classList.contains('hidden')).toBe(true)

    editor.selectNodes(['a'], 'replace')
    editor.groupSelection()
    expect(shapeSection.classList.contains('hidden')).toBe(true)
    expect(groupSection.classList.contains('hidden')).toBe(false)
  })

  it('edits the group transform through the shared inputs', () => {
    editor.addNode(rect('a', 0, 0))
    editor.addNode(rect('b', 100, 0))
    editor.selectNodes(['a', 'b'], 'replace')
    editor.groupSelection()

    const groupSection = container.querySelectorAll('.panel-section')[2]
    // The shared transform rows are parked in the visible group section.
    const inputs = [...groupSection.querySelectorAll<HTMLInputElement>('input[type="number"]')]
    expect(inputs.length).toBeGreaterThanOrEqual(6)
    const posX = inputs.find((input) => input.closest('.panel-row')?.textContent?.includes('x'))!
    posX.value = '25'
    posX.dispatchEvent(new Event('change'))
    const layer = editor.document.layers[0]
    const group = layer.keyframes[0].nodes[0]
    expect(group.type).toBe('group')
    expect(group.center.x).toBe(25)
  })

  it('offers ungroup and a disabled save-as-symbol in the group section', () => {
    editor.addNode(rect('a', 10, 10))
    editor.selectNodes(['a'], 'replace')
    editor.groupSelection()

    const groupSection = container.querySelectorAll('.panel-section')[2]
    const buttons = [...groupSection.querySelectorAll('button')]
    const ungroup = buttons.find((button) => button.textContent === 'Ungroup')!
    const symbol = buttons.find((button) => button.textContent === 'Save as Symbol… (F8)')!
    expect(ungroup.disabled).toBe(false)
    expect(ungroup.title).toBe('Ungroup (Ctrl+Shift+G)')
    expect(symbol.disabled).toBe(true)
    expect(symbol.title).toBe('Symbols arrive in a later update')

    ungroup.click()
    expect(editor.selectedNodeIds).toEqual(['a'])
  })

  it('enables keyframe operations for the selected object only', () => {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.panel-buttons button')]
    const byTitle = (title: string): HTMLButtonElement => {
      const button = buttons.find((candidate) => candidate.title.startsWith(title))
      if (!button) throw new Error(`missing button ${title}`)
      return button
    }
    // Nothing selected: the object-level operations are unavailable.
    expect(byTitle('Insert keyframe').disabled).toBe(true)
    expect(byTitle('Remove the keyframe').disabled).toBe(true)

    editor.addNode(rect('a', 10, 10))
    editor.insertFrameHere()
    editor.setFrame(1)
    expect(byTitle('Insert keyframe').disabled).toBe(false)

    editor.insertKeyframeHere()
    expect(byTitle('Insert keyframe').disabled).toBe(true)
    expect(byTitle('Remove the keyframe').disabled).toBe(false)

    editor.removeKeyframeHere()
    expect(byTitle('Remove the keyframe').disabled).toBe(true)
    expect(byTitle('Insert keyframe').disabled).toBe(false)
  })

  it('collapses sections on header click and persists the state', () => {
    const header = container.querySelector('.panel-section-header') as HTMLButtonElement
    const section = header.closest('.panel-section') as HTMLElement
    expect(section.classList.contains('collapsed')).toBe(false)

    header.click()
    expect(section.classList.contains('collapsed')).toBe(true)
    const stored = loadSectionState(window.localStorage)
    expect(stored.layer).toBe(false)

    // A fresh view restores the persisted state.
    container.textContent = ''
    new PropertiesView(editor, container)
    const restored = container.querySelector('.panel-section') as HTMLElement
    expect(restored.classList.contains('collapsed')).toBe(true)
  })

  it('keeps sections expanded when stored state is corrupted', () => {
    window.localStorage.setItem(SECTION_STORAGE_KEY, '{oops')
    container.textContent = ''
    new PropertiesView(editor, container)
    for (const section of container.querySelectorAll('.panel-section')) {
      expect(section.classList.contains('collapsed')).toBe(false)
    }
  })
})
