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

  it('renders the explorer, layer, playback and shape sections', () => {
    const titles = [...container.querySelectorAll('.panel-section-title')].map((node) =>
      node.textContent?.trim()
    )
    expect(titles).toEqual(['Layer Explorer', 'Layer', 'Playback', 'Shape'])
  })

  it('lists layers and their shapes in the explorer and selects on click', () => {
    editor.addShape(rect('a', 10, 10))
    const tree = container.querySelector('.explorer-tree') as HTMLElement
    const layerRows = [...tree.querySelectorAll('.explorer-row:not(.explorer-child)')]
    expect(layerRows).toHaveLength(1)
    expect(layerRows[0].textContent).toContain('Layer 1')

    const children = [...tree.querySelectorAll('.explorer-child')]
    expect(children).toHaveLength(1)
    expect(children[0].textContent).toContain('Rectangle')
    expect(children[0].classList.contains('selected')).toBe(true)

    // Clicking a shape child keeps the layer current and selects the shape.
    editor.selectShape(null)
    children[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(editor.selectedShapeId).toBe('a')
    expect(editor.currentLayerId).toBe(editor.document.layers[0].id)
  })

  it('shows a hint row for layers without content at the current frame', () => {
    editor.addLayerOnTop()
    const tree = container.querySelector('.explorer-tree') as HTMLElement
    const hints = [...tree.querySelectorAll('.explorer-empty')]
    expect(hints).toHaveLength(2)
    expect(hints[0].textContent).toContain('no shapes')
  })

  it('shows the shape section only while a shape is selected', () => {
    const shapeSection = container.querySelectorAll('.panel-section')[3]
    expect(shapeSection.classList.contains('hidden')).toBe(true)

    editor.addShape(rect('a', 10, 10))
    expect(shapeSection.classList.contains('hidden')).toBe(false)

    editor.selectShape(null)
    expect(shapeSection.classList.contains('hidden')).toBe(true)
  })

  it('enables keyframe operations according to the current state', () => {
    const buttons = [...container.querySelectorAll('.panel-buttons button')]
    const byTitle = (title: string): HTMLButtonElement => {
      const button = buttons.find((candidate) => candidate.title.startsWith(title))
      if (!button) throw new Error(`missing button ${title}`)
      return button
    }
    // Fresh document: a keyframe already exists at frame 0.
    expect(byTitle('Insert keyframe').disabled).toBe(true)
    expect(byTitle('Insert blank keyframe').disabled).toBe(true)
    expect(byTitle('Insert frame').disabled).toBe(false)
    expect(byTitle('Remove the keyframe').disabled).toBe(false)

    editor.insertFrameHere()
    editor.setFrame(1)
    expect(byTitle('Insert keyframe').disabled).toBe(false)

    editor.insertKeyframeHere()
    expect(byTitle('Insert keyframe').disabled).toBe(true)
    expect(byTitle('Remove the keyframe').disabled).toBe(false)
  })

  it('reflects playback state', () => {
    const playButton = [...container.querySelectorAll('button')].find((button) =>
      button.title.includes('Play or pause')
    ) as HTMLButtonElement
    const loopButton = [...container.querySelectorAll('button')].find((button) =>
      button.title.includes('looped playback')
    ) as HTMLButtonElement
    const fpsInput = container.querySelector('input[type="number"][title="Frames per second"]') as HTMLInputElement
    expect(fpsInput.value).toBe('24')
    expect(loopButton.classList.contains('active')).toBe(true)
    editor.toggleLoop()
    expect(loopButton.classList.contains('active')).toBe(false)
    expect(playButton.textContent).toBe('Play')
  })

  it('collapses sections on header click and persists the state', () => {
    const header = container.querySelector('.panel-section-header') as HTMLButtonElement
    const section = header.closest('.panel-section') as HTMLElement
    expect(section.classList.contains('collapsed')).toBe(false)

    header.click()
    expect(section.classList.contains('collapsed')).toBe(true)
    const stored = loadSectionState(window.localStorage)
    expect(stored.explorer).toBe(false)
    expect(stored.layer).toBe(true)

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
