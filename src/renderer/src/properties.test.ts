// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument } from '@shared/document'
import type { Shape } from '@shared/model'

import { Editor } from './editor'
import { PropertiesView } from './properties'
import { SECTION_STORAGE_KEY, loadSectionState } from './sectionState'

function rect(id: string, x: number, y: number): Shape {
  return {
    id,
    kind: 'rect',
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

  it('renders the layer and shape sections', () => {
    const titles = [...container.querySelectorAll('.panel-section-title')].map((node) =>
      node.textContent?.trim()
    )
    expect(titles).toEqual(['Layer', 'Shape'])
  })

  it('shows the shape section only while a shape is selected', () => {
    const shapeSection = container.querySelectorAll('.panel-section')[1]
    expect(shapeSection.classList.contains('hidden')).toBe(true)

    editor.addShape(rect('a', 10, 10))
    expect(shapeSection.classList.contains('hidden')).toBe(false)

    editor.selectShape(null)
    expect(shapeSection.classList.contains('hidden')).toBe(true)
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

    editor.addShape(rect('a', 10, 10))
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
