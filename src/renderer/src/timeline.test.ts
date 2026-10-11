// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument, getLayer } from '@shared/document'
import type { PrimitiveNode, SceneNode } from '@shared/model'

import { Editor } from './editor'
import { TimelineView } from './timeline'

function rect(id: string): PrimitiveNode {
  return {
    id,
    type: 'primitive',
    primitive: 'rect',
    center: { x: 0, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1
  }
}

function imageNode(id: string, name?: string): SceneNode {
  return {
    id,
    name,
    type: 'image',
    resourceId: `resource-${id}`,
    center: { x: 0, y: 0 },
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    naturalWidth: 100,
    naturalHeight: 50,
    smoothing: true
  }
}

function symbolNode(id: string): SceneNode {
  return {
    id,
    type: 'symbol',
    assetId: `asset-${id}`,
    center: { x: 0, y: 0 },
    width: 40,
    height: 40,
    rotation: 0,
    opacity: 1
  }
}

describe('TimelineView', () => {
  let editor: Editor
  let container: HTMLElement
  let view: TimelineView

  beforeEach(() => {
    document.body.textContent = ''
    editor = new Editor(createDocument('test', 960, 540, 24))
    container = document.createElement('div')
    document.body.appendChild(container)
    view = new TimelineView(editor, container)
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
    editor.addNode(rect('a'))
    expandFirstLayer()
    // The auto-key puts the object in the keyframe at frame 0.
    expect(kfButton().textContent).toBe('×')

    editor.insertFrameHere()
    editor.setFrame(1)
    expect(kfButton().textContent).toBe('◇')

    kfButton().click()
    expect(editor.hasNodeKeyframeAt(editor.currentLayerId, 'a', 1)).toBe(true)
    expect(kfButton().textContent).toBe('×')

    kfButton().click()
    expect(editor.hasNodeKeyframeAt(editor.currentLayerId, 'a', 1)).toBe(false)
    expect(kfButton().textContent).toBe('◇')
  })

  it('shows keyframe markers at the object level, never on layer rows', () => {
    editor.addNode(rect('a'))
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
    editor.ensureNodeKeyframe('a')
    expect(markerFrames()).toEqual(['0', '1'])
  })

  it('enables the tween toggle only when the object has a previous keyframe', () => {
    editor.addNode(rect('a'))
    editor.insertFrameHere()
    editor.setFrame(1)
    editor.ensureNodeKeyframe('a')
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
    editor.addNode(rect('a'))
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

  it('labels object rows by node kind and colors non-primitive swatches neutrally', () => {
    editor.addNode(rect('a'))
    const layer = getLayer(editor.document, editor.currentLayerId)!
    // Kinds without a creation tool are injected directly into the keyframe.
    layer.keyframes[0].nodes.push(imageNode('img', 'Photo'), symbolNode('sym'))
    view.render()
    expandFirstLayer()

    const labels = [...container.querySelectorAll('.tl-shape-row .name')].map(
      (label) => label.textContent
    )
    expect(labels).toEqual(['Rectangle', 'Photo', 'Symbol'])
    const swatches = [
      ...container.querySelectorAll<HTMLElement>('.tl-shape-row .tl-swatch')
    ].map((swatch) => swatch.style.background)
    expect(swatches).toEqual(['#ff0000', '#64748b', '#64748b'])
  })

  it('renders a group row exactly like a shape row with its own keyframes', () => {
    editor.addNode(rect('a'))
    editor.addNode(rect('b'))
    editor.selectNodes(['a', 'b'], 'replace')
    editor.groupSelection()
    const groupRow = (): HTMLElement => container.querySelector<HTMLElement>('.tl-shape-row')!

    expandFirstLayer()
    expect(groupRow().querySelector('.name')?.textContent).toBe('Group')
    expect(groupRow().querySelectorAll('.tl-key')).toHaveLength(1)

    // The group behaves like any object: it can hold later keyframes and
    // tween spans of its own.
    editor.insertFrameHere()
    editor.setFrame(1)
    editor.ensureNodeKeyframe(
      groupRow().dataset.shapeId!
    )
    expect(groupRow().querySelectorAll('.tl-key')).toHaveLength(2)
    expect(groupRow().querySelector('.tl-shape-kf')?.textContent).toBe('\u00d7')
  })

  it('seeks past the last frame on cell clicks and keys only the target object', () => {
    editor.addNode(rect('a'))
    editor.addNode(rect('b'))
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
    expect(editor.hasNodeKeyframeAt(editor.currentLayerId, 'a', 5)).toBe(true)
    expect(editor.hasNodeKeyframeAt(editor.currentLayerId, 'b', 5)).toBe(false)
    expect(buttonFor('a').textContent).toBe('×')
    expect(buttonFor('b').textContent).toBe('◇')
  })
})
