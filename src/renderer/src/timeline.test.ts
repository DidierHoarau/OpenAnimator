// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument, getLayer } from '@shared/document'
import type { Shape } from '@shared/model'

import { Editor } from './editor'
import { TimelineView } from './timeline'

function rect(id: string): Shape {
  return {
    id,
    kind: 'rect',
    center: { x: 0, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1
  }
}

describe('TimelineView', () => {
  let editor: Editor
  let container: HTMLElement

  beforeEach(() => {
    document.body.textContent = ''
    editor = new Editor(createDocument('test', 960, 540, 24))
    container = document.createElement('div')
    document.body.appendChild(container)
    new TimelineView(editor, container)
  })

  const expandFirstLayer = (): void => {
    container.querySelector<HTMLElement>('.tl-toggle')!.click()
  }
  const kfButton = (): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>('.tl-shape-kf')!
  const tweenButton = (): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>('.tl-shape-tween')!

  it('renders playback and frame controls at the top of the timeline', () => {
    const labels = [...container.querySelectorAll('.tl-controls button')].map(
      (button) => button.textContent
    )
    expect(labels).toEqual(['Play', 'Stop', 'Loop', '+ Frame', '− Frame'])

    // Playback requires a timeline longer than one frame.
    editor.insertFrameHere()
    editor.togglePlay()
    expect(container.querySelector('.tl-controls button')?.textContent).toBe('Pause')
    editor.togglePlay()
    expect(container.querySelector('.tl-controls button')?.textContent).toBe('Play')
  })

  it('adds and deletes a per-object keyframe from the object row', () => {
    editor.addShape(rect('a'))
    expandFirstLayer()
    // The auto-key puts the object in the keyframe at frame 0.
    expect(kfButton().textContent).toBe('×')

    editor.insertFrameHere()
    editor.setFrame(1)
    expect(kfButton().textContent).toBe('◇')

    kfButton().click()
    expect(editor.hasShapeKeyframeAt(editor.currentLayerId, 'a', 1)).toBe(true)
    expect(kfButton().textContent).toBe('×')

    kfButton().click()
    expect(editor.hasShapeKeyframeAt(editor.currentLayerId, 'a', 1)).toBe(false)
    expect(kfButton().textContent).toBe('◇')
  })

  it('shows keyframe markers at the object level, never on layer rows', () => {
    editor.addShape(rect('a'))
    editor.insertFrameHere()
    expandFirstLayer()

    // Layer rows are plain seekable tracks: no keyframe markers at that level.
    const layerRow = container.querySelector<HTMLElement>('.tl-row')!
    expect(layerRow.querySelectorAll('.tl-key')).toHaveLength(0)

    // The object row carries its own keyframe markers.
    const markerFrames = (): (string | undefined)[] =>
      [...container.querySelectorAll<HTMLElement>('.tl-shape-row .tl-key')].map(
        (marker) => marker.dataset.frame
      )
    expect(markerFrames()).toEqual(['0'])

    editor.setFrame(1)
    editor.ensureShapeKeyframe('a')
    expect(markerFrames()).toEqual(['0', '1'])
  })

  it('enables the tween toggle only when the object has a previous keyframe', () => {
    editor.addShape(rect('a'))
    editor.insertFrameHere()
    editor.setFrame(1)
    editor.ensureShapeKeyframe('a')
    expandFirstLayer()

    expect(tweenButton().disabled).toBe(false)
    tweenButton().click()
    expect(tweenButton().classList.contains('active')).toBe(true)
    const layer = getLayer(editor.document, editor.currentLayerId)!
    expect(layer.keyframes.find((keyframe) => keyframe.frame === 1)?.tween).toBeDefined()

    tweenButton().click()
    expect(tweenButton().classList.contains('active')).toBe(false)

    // Frame 0 has no earlier keyframe for this object: the toggle is disabled.
    editor.setFrame(0)
    expect(tweenButton().disabled).toBe(true)
  })

  it('renames a layer through the context menu', () => {
    const row = container.querySelector<HTMLElement>('.tl-row')!
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))
    const menu = container.querySelector<HTMLElement>('.tl-context-menu')!
    expect(menu.classList.contains('hidden')).toBe(false)

    const rename = [...menu.querySelectorAll('button')].find(
      (button) => button.textContent === 'Rename'
    )!
    rename.click()
    const input = container.querySelector<HTMLInputElement>('.tl-rename-input')!
    input.value = 'Background'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(editor.document.layers[0].name).toBe('Background')
  })

  it('deletes an object through the context menu', () => {
    editor.addShape(rect('a'))
    expandFirstLayer()
    const shapeRow = container.querySelector<HTMLElement>('.tl-shape-row')!
    shapeRow.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 })
    )
    const menu = container.querySelector<HTMLElement>('.tl-context-menu')!
    const remove = [...menu.querySelectorAll('button')].find(
      (button) => button.textContent === 'Delete'
    )!
    remove.click()

    const layer = getLayer(editor.document, editor.currentLayerId)!
    expect(layer.keyframes).toHaveLength(0)
  })

  it('adds a layer from the bottom line and reorders layers by drag and drop', () => {
    const addLine = container.querySelector<HTMLElement>('.tl-add-layer')!
    addLine.click()
    expect(editor.document.layers).toHaveLength(2)

    const rows = [...container.querySelectorAll<HTMLElement>('.tl-row')]
    const topId = editor.document.layers[0].id
    const bottomId = editor.document.layers[1].id

    rows[0].dispatchEvent(new Event('dragstart', { bubbles: true }))
    // Below the row's midpoint (zero-height rect falls back to the top).
    rows[1].dispatchEvent(new MouseEvent('drop', { bubbles: true, clientY: 400 }))

    expect(editor.document.layers[0].id).toBe(bottomId)
    expect(editor.document.layers[1].id).toBe(topId)
  })

  it('seeks past the last frame on cell clicks and keys only the target object', () => {
    editor.addShape(rect('a'))
    editor.addShape(rect('b'))
    expandFirstLayer()

    const cell = container.querySelector<HTMLElement>('.tl-row .tl-cell[data-frame="5"]')!
    cell.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(editor.currentFrame).toBe(5)
    expect(editor.duration).toBe(6)

    const buttonFor = (shapeId: string): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>(
        `.tl-shape-row[data-shape-id="${shapeId}"] .tl-shape-kf`
      )!
    expect(buttonFor('a').textContent).toBe('◇')
    expect(buttonFor('b').textContent).toBe('◇')

    buttonFor('a').click()
    expect(editor.hasShapeKeyframeAt(editor.currentLayerId, 'a', 5)).toBe(true)
    expect(editor.hasShapeKeyframeAt(editor.currentLayerId, 'b', 5)).toBe(false)
    expect(buttonFor('a').textContent).toBe('×')
    expect(buttonFor('b').textContent).toBe('◇')
  })
})
