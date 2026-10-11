// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument, getLayer } from '@shared/document'
import type { DrawingLayer, PrimitiveNode, SceneNode } from '@shared/model'

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

  it('moves an object to another frame by dragging its span bar', () => {
    editor.addNode(rect('a'))
    // Extend the authored timeline first so there is room to move.
    while (editor.duration <= 5) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    expandFirstLayer()

    const shapeRow = container.querySelector<HTMLElement>('.tl-shape-row')!
    const track = shapeRow.querySelector<HTMLElement>('.tl-track')!
    const bar = shapeRow.querySelector<HTMLElement>('.tl-shape-span')!
    expect(bar.getAttribute('draggable')).toBe('true')

    bar.dispatchEvent(new Event('dragstart', { bubbles: true }))
    expect(bar.classList.contains('dragging')).toBe(true)
    // Dropping 3.5 frame widths into the track moves the keyframes to frame 3.
    track.getBoundingClientRect = () => ({ left: 180 }) as unknown as DOMRect
    track.dispatchEvent(new MouseEvent('drop', { bubbles: true, clientX: 180 + 3 * 14 + 7 }))

    const layer = getLayer(editor.document, editor.currentLayerId)!
    expect(layer.keyframes.map((keyframe) => keyframe.frame)).toEqual([3])
    expect(bar.classList.contains('dragging')).toBe(false)
    // The move is one undo step.
    editor.undo()
    expect(getLayer(editor.document, editor.currentLayerId)!.keyframes.map((k) => k.frame)).toEqual([
      0
    ])
  })

  it('moves an object to a frame number through the context menu', () => {
    editor.addNode(rect('a'))
    while (editor.duration <= 5) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    expandFirstLayer()

    const shapeRow = container.querySelector<HTMLElement>('.tl-shape-row')!
    shapeRow.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 })
    )
    const menu = container.querySelector<HTMLElement>('.tl-context-menu')!
    const moveInput = menu.querySelector<HTMLInputElement>('.tl-context-move input')!
    // Prefilled with the object's first keyframe (1-based) and movable.
    expect(moveInput.value).toBe('1')
    expect(moveInput.disabled).toBe(false)

    moveInput.value = '4'
    moveInput.dispatchEvent(new Event('change', { bubbles: true }))
    const layer = getLayer(editor.document, editor.currentLayerId)!
    expect(layer.keyframes.map((keyframe) => keyframe.frame)).toEqual([3])
    // The moved object is selected for follow-up edits and the menu closes.
    expect(editor.selectedNodeIds).toEqual(['a'])
    expect(menu.classList.contains('hidden')).toBe(true)
  })

  it('offers Move to frame only for object rows and drawing layers', () => {
    const row = container.querySelector<HTMLElement>('.tl-row')!
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))
    const moveRow = container.querySelector<HTMLElement>('.tl-context-menu .tl-context-move')!
    expect(moveRow.classList.contains('hidden')).toBe(true)
  })

  it('seeks by pointer position on tracks and keys only the target object', () => {
    editor.addNode(rect('a'))
    editor.addNode(rect('b'))
    // Extend the authored timeline first — seeking no longer extends it.
    while (editor.duration <= 5) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    expandFirstLayer()

    // Tracks seek by geometry: HEAD_WIDTH (180) plus the clicked offset.
    const layerTrack = container.querySelector<HTMLElement>('.tl-row .tl-track')!
    layerTrack.getBoundingClientRect = () => ({ left: 180 }) as unknown as DOMRect
    layerTrack.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 180 + 5 * 14 + 7 })
    )
    expect(editor.currentFrame).toBe(5)
    expect(editor.duration).toBe(6)

    // Clicking an object's track selects the object and seeks there.
    const shapeTrack = container.querySelector<HTMLElement>('.tl-shape-row .tl-track')!
    shapeTrack.getBoundingClientRect = () => ({ left: 180 }) as unknown as DOMRect
    shapeTrack.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 180 + 3 * 14 + 7 })
    )
    expect(editor.currentFrame).toBe(3)
    expect(editor.selectedNodeIds).toEqual(['a'])

    const buttonFor = (shapeId: string): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>(
        `.tl-shape-row[data-shape-id="${shapeId}"] .tl-shape-kf`
      )!
    expect(buttonFor('a').textContent).toBe('◇')
    expect(buttonFor('b').textContent).toBe('◇')

    buttonFor('a').click()
    expect(editor.hasNodeKeyframeAt(editor.currentLayerId, 'a', 3)).toBe(true)
    expect(editor.hasNodeKeyframeAt(editor.currentLayerId, 'b', 3)).toBe(false)
    expect(buttonFor('a').textContent).toBe('×')
    expect(buttonFor('b').textContent).toBe('◇')

    // Keyframe markers still seek to their exact frame.
    const marker = container.querySelector<HTMLElement>('.tl-shape-row .tl-key[data-frame="0"]')!
    marker.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(editor.currentFrame).toBe(0)
  })
})

describe('TimelineView — drawing layers', () => {
  let editor: Editor
  let container: HTMLElement
  let view: TimelineView

  beforeEach(() => {
    document.body.textContent = ''
    editor = new Editor(createDocument('test', 960, 540, 24), {
      createTransparentPng: async () => new Uint8Array([0]),
      storeResource: async () => 'res-1'
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    view = new TimelineView(editor, container)
  })

  const addDrawingLayer = (): DrawingLayer => {
    editor.addLayerAtBottom('drawing')
    const layer = getLayer(editor.document, editor.currentLayerId)!
    if (layer.kind !== 'drawing') throw new Error('expected a drawing layer')
    return layer
  }

  it('adds object and drawing layers from the two bottom lines', () => {
    const lines = [...container.querySelectorAll<HTMLElement>('.tl-add-layer')]
    expect(lines.map((line) => line.textContent)).toEqual(['+ Object Layer', '+ Drawing Layer'])

    lines[1].click()
    expect(editor.document.layers[1].kind).toBe('drawing')
    expect(editor.tool).toBe('brush')

    lines[0].click()
    expect(editor.document.layers[2].kind).toBe('object')
  })

  it('badges each layer row with its kind', () => {
    editor.addLayerAtBottom('drawing')
    view.render()
    const badges = [...container.querySelectorAll<HTMLElement>('.tl-row .tl-kind')].map(
      (badge) => badge.textContent
    )
    expect(badges).toEqual(['\u25a3', '\u270e'])
  })

  it('renders a filmstrip row with one element per cell span and seeks by pointer', () => {
    addDrawingLayer()
    editor.resources.put('res-1', new Uint8Array([1, 2, 3]))
    // One cell at frame 3: frames 0–2 are blank, 3+ hold the cell.
    editor.commitStroke('res-1', 3)
    // Extend the authored timeline so the playhead can reach frame 4+.
    while (editor.duration <= 5) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    // Expand the drawing layer (second row) to show its filmstrip.
    ;[...container.querySelectorAll<HTMLElement>('.tl-toggle')][1].click()
    view.render()

    const filmstrip = container.querySelector<HTMLElement>('.tl-filmstrip-row')!
    expect(filmstrip.querySelector('.tl-head .name')?.textContent).toBe('cells')
    const cells = [...filmstrip.querySelectorAll<HTMLElement>('.tl-filmstrip-cell')]
    // Span-based: one blank run then one held run, not one element per frame.
    expect(cells).toHaveLength(2)
    expect(cells[0].classList.contains('tl-cell-blank')).toBe(true)
    expect(cells[0].style.left).toBe('0px')
    expect(cells[0].style.width).toBe(`${3 * 14}px`)
    expect(cells[1].querySelectorAll('img')).toHaveLength(1)
    expect(cells[1].style.left).toBe(`${3 * 14}px`)
    expect(cells[1].style.width).toBe(`${(40 - 3) * 14}px`)

    // Tracks seek by pointer position: a click 4.5 frame widths in lands on frame 4.
    const track = filmstrip.querySelector<HTMLElement>('.tl-track')!
    track.getBoundingClientRect = () => ({ left: 180 }) as unknown as DOMRect
    track.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 180 + 4 * 14 + 7 })
    )
    expect(editor.currentFrame).toBe(4)
  })

  it('moves a cell to another frame by dragging its filmstrip span', () => {
    addDrawingLayer()
    editor.resources.put('res-1', new Uint8Array([1, 2, 3]))
    // One cell at frame 1, held afterwards.
    editor.commitStroke('res-1', 1)
    while (editor.duration <= 5) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    ;[...container.querySelectorAll<HTMLElement>('.tl-toggle')][1].click()

    const filmstrip = container.querySelector<HTMLElement>('.tl-filmstrip-row')!
    const track = filmstrip.querySelector<HTMLElement>('.tl-track')!
    const cells = [...filmstrip.querySelectorAll<HTMLElement>('.tl-filmstrip-cell')]
    const blank = cells.find((cell) => cell.classList.contains('tl-cell-blank'))!
    const held = cells.find((cell) => !cell.classList.contains('tl-cell-blank'))!
    // Only cells with content can be dragged.
    expect(blank.getAttribute('draggable')).toBeNull()
    expect(held.getAttribute('draggable')).toBe('true')

    held.dispatchEvent(new Event('dragstart', { bubbles: true }))
    expect(held.classList.contains('dragging')).toBe(true)
    track.getBoundingClientRect = () => ({ left: 180 }) as unknown as DOMRect
    track.dispatchEvent(new MouseEvent('drop', { bubbles: true, clientX: 180 + 4 * 14 + 7 }))

    const layer = getLayer(editor.document, editor.currentLayerId)! as DrawingLayer
    expect(layer.cells).toEqual([{ frame: 4, resourceId: 'res-1' }])
    expect(held.classList.contains('dragging')).toBe(false)
    // One undo step restores the original frame.
    editor.undo()
    expect((getLayer(editor.document, editor.currentLayerId)! as DrawingLayer).cells).toEqual([
      { frame: 1, resourceId: 'res-1' }
    ])
  })

  it('moves the playhead cell to a frame number through the context menu', () => {
    const layer = addDrawingLayer()
    editor.resources.put('res-1', new Uint8Array([1, 2, 3]))
    editor.commitStroke('res-1', 1)
    while (editor.duration <= 5) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    const row = [...container.querySelectorAll<HTMLElement>('.tl-row')].find(
      (candidate) => candidate.dataset.layerId === layer.id
    )!
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))
    const menu = container.querySelector<HTMLElement>('.tl-context-menu')!
    const moveInput = menu.querySelector<HTMLInputElement>('.tl-context-move input')!
    expect(moveInput.value).toBe('2')

    moveInput.value = '5'
    moveInput.dispatchEvent(new Event('change', { bubbles: true }))
    expect((getLayer(editor.document, layer.id)! as DrawingLayer).cells).toEqual([
      { frame: 4, resourceId: 'res-1' }
    ])
    expect(menu.classList.contains('hidden')).toBe(true)
  })

  it('shows cell operations and resolution in the drawing-layer context menu', () => {
    const layer = addDrawingLayer()
    view.render()
    const row = [...container.querySelectorAll<HTMLElement>('.tl-row')].find(
      (candidate) => candidate.dataset.layerId === layer.id
    )!
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))
    const menu = container.querySelector<HTMLElement>('.tl-context-menu')!
    const labels = [...menu.querySelectorAll('button')].map((button) => button.textContent)
    expect(labels).toEqual(
      expect.arrayContaining([
        'Insert Cell (F6)',
        'Insert Blank Cell (F7)',
        'Clear Cell',
        'Remove Cell'
      ])
    )
    const resolution = menu.querySelector<HTMLInputElement>('.tl-context-resolution input')!
    expect(resolution.value).toBe('1')
    expect(resolution.closest('.tl-context-resolution')?.classList.contains('hidden')).toBe(false)

    // Changing the resolution updates the layer.
    resolution.value = '3'
    resolution.dispatchEvent(new Event('change', { bubbles: true }))
    expect(
      (getLayer(editor.document, layer.id) as DrawingLayer).resolutionScale
    ).toBe(3)
  })

  it('hides cell operations in the object-layer context menu', () => {
    view.render()
    const row = container.querySelector<HTMLElement>('.tl-row')!
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))
    const menu = container.querySelector<HTMLElement>('.tl-context-menu')!
    const insertCell = [...menu.querySelectorAll('button')].find(
      (button) => button.textContent === 'Insert Cell (F6)'
    )!
    // The cell operations exist for every layer but are hidden on objects.
    expect(insertCell.classList.contains('hidden')).toBe(true)
    expect(menu.querySelector('.tl-context-resolution')?.classList.contains('hidden')).toBe(true)
  })
})
