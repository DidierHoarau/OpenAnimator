// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument, getLayer } from '@shared/document'
import type { AudioLayer, DrawingLayer, PrimitiveNode, SceneNode } from '@shared/model'

import { Editor } from './editor'
import { registerKeyboard } from './keyboard'
import { StageView } from './stage'
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

  // Idempotent: selection changes already reveal the owning layer, so only
  // click a row that still shows the collapsed glyph.
  const expandFirstLayer = (): void => {
    const toggle = container.querySelector<HTMLElement>('.tl-toggle')!
    if (toggle.textContent === '\u25b8') toggle.click()
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

  it('reveals a created object by expanding its layer in the layer explorer', () => {
    // Fresh documents start collapsed: no object rows exist yet.
    expect(container.querySelector('.tl-shape-row')).toBeNull()

    editor.addNode(rect('a'))

    const row = container.querySelector<HTMLElement>('.tl-shape-row[data-shape-id="a"]')
    expect(row).not.toBeNull()
    expect(row!.classList.contains('selected')).toBe(true)
    expect(container.textContent).not.toContain('no objects on this layer')
    expect(container.querySelector<HTMLElement>('.tl-toggle')!.textContent).toBe('\u25be')
  })

  it('keeps a manual collapse through unrelated changes and re-reveals on the next selection', () => {
    editor.addNode(rect('a'))
    const layerId = editor.currentLayerId
    const toggle = (): HTMLElement => container.querySelector<HTMLElement>('.tl-toggle')!
    const shapeRow = (): HTMLElement | null =>
      container.querySelector<HTMLElement>('.tl-shape-row[data-shape-id="a"]')
    expect(shapeRow()).not.toBeNull()

    // A manual collapse of the unchanged selection survives unrelated uiChanges.
    toggle().click()
    expect(shapeRow()).toBeNull()
    expect(toggle().textContent).toBe('\u25b8')
    editor.toggleLayerVisibility(layerId)
    expect(shapeRow()).toBeNull()
    expect(editor.selectedNodeIds).toEqual(['a'])

    // The next selection change re-reveals the owning layer.
    editor.selectNodes([], 'replace')
    expect(shapeRow()).toBeNull()
    editor.selectNodes(['a'], 'replace')
    expect(shapeRow()).not.toBeNull()
    expect(shapeRow()!.classList.contains('selected')).toBe(true)
    expect(toggle().textContent).toBe('\u25be')
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
    expect(lines.map((line) => line.textContent)).toEqual([
      '+ Object Layer',
      '+ Drawing Layer',
      '+ Camera Layer',
      '+ Audio Layer…'
    ])

    lines[1].click()
    expect(editor.document.layers[1].kind).toBe('drawing')
    expect(editor.tool).toBe('brush')

    lines[0].click()
    expect(editor.document.layers[2].kind).toBe('object')

    // The camera line creates the singleton camera layer, keyed at frame 0.
    lines[2].click()
    expect(editor.document.layers[3].kind).toBe('camera')
    expect(editor.cameraLayer?.keyframes.map((keyframe) => keyframe.frame)).toEqual([0])
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

describe('TimelineView — keyframe markers, range copy/paste and options', () => {
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

  const extend = (toFrame: number): void => {
    while (editor.duration <= toFrame) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
  }
  // Idempotent: selection changes already reveal the owning layer, so only
  // click a row that still shows the collapsed glyph.
  const expandFirstLayer = (): void => {
    const toggle = container.querySelector<HTMLElement>('.tl-toggle')!
    if (toggle.textContent === '\u25b8') toggle.click()
  }
  const markerFor = (shapeId: string, frame: number): HTMLElement =>
    container.querySelector<HTMLElement>(
      `.tl-shape-row[data-shape-id="${shapeId}"] .tl-key[data-frame="${frame}"]`
    )!
  const selectedFrames = (shapeId: string): (string | undefined)[] =>
    [
      ...container.querySelectorAll<HTMLElement>(
        `.tl-shape-row[data-shape-id="${shapeId}"] .tl-key.selected`
      )
    ].map((marker) => marker.dataset.frame)
  const nodeFrames = (id: string): number[] =>
    getLayer(editor.document, editor.currentLayerId)!
      .keyframes.filter((keyframe) => keyframe.nodes.some((node) => node.id === id))
      .map((keyframe) => keyframe.frame)
  const pressMarker = (shapeId: string, frame: number, shift = false): void => {
    markerFor(shapeId, frame).dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 100, clientY: 50, bubbles: true, shiftKey: shift })
    )
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 100, clientY: 50 }))
  }

  it('retimes a single keyframe marker by dragging it, as one undo step', () => {
    editor.addNode(rect('a'))
    extend(7)
    editor.seekToFrame(4)
    editor.ensureNodeKeyframe('a')
    expandFirstLayer()

    // Press-and-release without travel is a plain click: select and seek only.
    pressMarker('a', 4)
    expect(editor.currentFrame).toBe(4)
    expect(selectedFrames('a')).toEqual(['4'])
    expect(nodeFrames('a')).toEqual([0, 4])

    // Dragging two frames right previews the offset and commits on release.
    markerFor('a', 4).dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 100, clientY: 50, bubbles: true })
    )
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 128, clientY: 50 }))
    expect(markerFor('a', 4).style.transform).toBe('translateX(28px)')
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 128, clientY: 50 }))
    expect(nodeFrames('a')).toEqual([0, 6])

    // The whole drag is a single history entry.
    editor.undo()
    expect(nodeFrames('a')).toEqual([0, 4])
    editor.redo()
    expect(nodeFrames('a')).toEqual([0, 6])

    // Overshooting the timeline end clamps the move to the last frame.
    markerFor('a', 6).dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 100, clientY: 50, bubbles: true })
    )
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 900, clientY: 50 }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 900, clientY: 50 }))
    expect(nodeFrames('a')).toEqual([0, 7])
  })

  it('shift-click multi-selects markers and drags them in one undo step', () => {
    editor.addNode(rect('a'))
    editor.addNode(rect('b'))
    extend(7)
    editor.seekToFrame(2)
    editor.ensureNodeKeyframe('a')
    editor.seekToFrame(4)
    editor.ensureNodeKeyframe('b')
    expandFirstLayer()

    pressMarker('a', 2)
    expect(selectedFrames('a')).toEqual(['2'])
    pressMarker('b', 4, true)
    expect(selectedFrames('a')).toEqual(['2'])
    expect(selectedFrames('b')).toEqual(['4'])

    // Shift-clicking again drops the marker from the selection.
    pressMarker('b', 4, true)
    expect(selectedFrames('b')).toEqual([])
    pressMarker('b', 4, true)

    // Dragging one selected marker moves the whole selection by one frame.
    markerFor('a', 2).dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 100, clientY: 50, bubbles: true })
    )
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 114, clientY: 50 }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 114, clientY: 50 }))
    expect(nodeFrames('a')).toEqual([0, 3])
    expect(nodeFrames('b')).toEqual([0, 5])

    editor.undo()
    expect(nodeFrames('a')).toEqual([0, 2])
    expect(nodeFrames('b')).toEqual([0, 4])
    editor.redo()
    expect(nodeFrames('a')).toEqual([0, 3])
    expect(nodeFrames('b')).toEqual([0, 5])
  })

  it('drags a copy range on the ruler; a plain click clears it and seeks', () => {
    const ruler = container.querySelector<HTMLElement>('.tl-ruler')!
    const band = (): HTMLElement => container.querySelector<HTMLElement>('.tl-range')!
    const at = (frame: number): number => 180 + frame * 14 + 7

    ruler.dispatchEvent(new MouseEvent('pointerdown', { clientX: at(2), clientY: 5, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: at(5), clientY: 5 }))
    expect(band().classList.contains('hidden')).toBe(false)
    expect(band().style.left).toBe(`${180 + 2 * 14}px`)
    expect(band().style.width).toBe(`${4 * 14}px`)
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: at(5), clientY: 5 }))
    expect(band().classList.contains('hidden')).toBe(false)

    // A plain click (no travel) clears the band and seeks to the frame.
    editor.insertFrameHere()
    ruler.dispatchEvent(new MouseEvent('pointerdown', { clientX: at(1), clientY: 5, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: at(1), clientY: 5 }))
    expect(band().classList.contains('hidden')).toBe(true)
    expect(editor.currentFrame).toBe(1)
  })

  it('seeks to any displayed frame from the ruler and leaves drags band-only', () => {
    extend(9)
    editor.seekToFrame(0)
    const ruler = container.querySelector<HTMLElement>('.tl-ruler')!
    const at = (frame: number): number => 180 + frame * 14 + 7

    ruler.dispatchEvent(new MouseEvent('pointerdown', { clientX: at(6), clientY: 5, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: at(6), clientY: 5 }))
    expect(editor.currentFrame).toBe(6)

    // Dragging on the ruler builds the copy-range band without seeking.
    ruler.dispatchEvent(new MouseEvent('pointerdown', { clientX: at(2), clientY: 5, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: at(4), clientY: 5 }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: at(4), clientY: 5 }))
    expect(container.querySelector<HTMLElement>('.tl-range')!.classList.contains('hidden')).toBe(false)
    expect(editor.currentFrame).toBe(6)
  })

  it('copies the ruler range and pastes it at the playhead with the carried tween', () => {
    editor.addNode(rect('a'))
    extend(9)
    editor.seekToFrame(0)
    editor.toggleTweenHere()
    editor.seekToFrame(3)
    editor.ensureNodeKeyframe('a')
    expandFirstLayer()

    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))
    const last = (): string => messages[messages.length - 1]

    // Paste first: the empty clipboard is reported, not applied.
    view.pasteKeyframes()
    expect(last()).toBe('Paste keyframes: the clipboard is empty')

    // Drag frames 1–4 (0-based 0–3) on the ruler, then copy the band.
    const ruler = container.querySelector<HTMLElement>('.tl-ruler')!
    const at = (frame: number): number => 180 + frame * 14 + 7
    ruler.dispatchEvent(new MouseEvent('pointerdown', { clientX: at(0), clientY: 5, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: at(3), clientY: 5 }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: at(3), clientY: 5 }))
    view.copyKeyframes()
    expect(last()).toBe('Copied 2 keyframe entries')

    editor.seekToFrame(5)
    view.pasteKeyframes()
    expect(last()).toBe('Pasted 2 keyframe entries')
    expect(nodeFrames('a')).toEqual([0, 3, 5, 8])
    // The tween rode along to the first pasted keyframe only.
    const tweenAt = (frame: number) =>
      getLayer(editor.document, editor.currentLayerId)!.keyframes.find(
        (keyframe) => keyframe.frame === frame
      )?.tween
    expect(tweenAt(5)).toEqual({ easing: 'ease-in-out' })
    expect(tweenAt(8)).toBeUndefined()

    // One undo step for the whole paste.
    editor.undo()
    expect(nodeFrames('a')).toEqual([0, 3])
    editor.redo()
    expect(nodeFrames('a')).toEqual([0, 3, 5, 8])
  })

  it('copies the focused marker and wires Ctrl+C / Ctrl+V to the timeline', () => {
    editor.addNode(rect('a'))
    extend(7)
    editor.seekToFrame(3)
    editor.ensureNodeKeyframe('a')
    expandFirstLayer()

    const host = document.createElement('main')
    document.body.appendChild(host)
    const stageView = new StageView(editor, host)
    registerKeyboard({
      editor,
      stageView,
      timelineView: view,
      panels: { toggleLibrary: () => {}, toggleProperties: () => {} }
    })

    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))
    const last = (): string => messages[messages.length - 1]

    pressMarker('a', 3)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
    expect(last()).toBe('Copied 1 keyframe entry')

    editor.seekToFrame(5)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }))
    expect(last()).toBe('Pasted 1 keyframe entry')
    expect(nodeFrames('a')).toEqual([0, 3, 5])

    // Inside text fields the shortcut stays native: nothing is copied.
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
    expect(last()).toBe('Pasted 1 keyframe entry')
  })

  it('offers keyframe actions on a marker right-click', () => {
    editor.addNode(rect('a'))
    extend(7)
    editor.seekToFrame(4)
    editor.ensureNodeKeyframe('a')
    editor.seekToFrame(6)
    editor.updateSelectedNode((node) => {
      if (node.type === 'primitive') node.center.x = 50
    })
    expandFirstLayer()

    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))
    const last = (): string => messages[messages.length - 1]
    const menu = container.querySelector<HTMLElement>('.tl-context-menu')!
    const menuButton = (label: string): HTMLButtonElement =>
      [...menu.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === label
      )!

    // The object row's menu hides the keyframe actions entirely.
    container
      .querySelector<HTMLElement>('.tl-shape-row .tl-head')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    expect(menuButton('Copy Keyframe / Frame Range').classList.contains('hidden')).toBe(true)

    // A marker's menu shows them; paste starts disabled without a clipboard.
    markerFor('a', 4).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })
    )
    expect(menu.classList.contains('hidden')).toBe(false)
    expect(menuButton('Copy Keyframe / Frame Range').classList.contains('hidden')).toBe(false)
    expect(menuButton('Paste Keyframe here').disabled).toBe(true)

    menuButton('Copy Keyframe / Frame Range').click()
    expect(last()).toBe('Copied 1 keyframe entry')
    expect(selectedFrames('a')).toEqual(['4'])

    // Paste the copied pose onto the keyframe at frame 6 through the menu.
    markerFor('a', 6).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })
    )
    expect(menuButton('Paste Keyframe here').disabled).toBe(false)
    menuButton('Paste Keyframe here').click()
    expect(last()).toBe('Pasted 1 keyframe entry')
    const poseAt = (frame: number): number => {
      const keyframe = getLayer(editor.document, editor.currentLayerId)!.keyframes.find(
        (candidate) => candidate.frame === frame
      )!
      return (keyframe.nodes.find((node) => node.id === 'a') as PrimitiveNode).center.x
    }
    expect(poseAt(6)).toBe(0)

    editor.undo()
    expect(poseAt(6)).toBe(50)
  })

  it('drives the hold step and onion options from the options row', () => {
    const select = container.querySelector<HTMLSelectElement>('.tl-options select')!
    expect(select.value).toBe('1')
    select.value = '3'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(editor.holdStep).toBe(3)
    expect(editor.document.holdStep).toBe(3)

    // Undoing mirrors the reverted value back onto the control.
    editor.undo()
    expect(editor.holdStep).toBe(1)
    expect(select.value).toBe('1')

    const [onionCheckbox, tintCheckbox, outlineCheckbox] = [
      ...container.querySelectorAll<HTMLInputElement>('.tl-options .tl-check')
    ]
    onionCheckbox.click()
    expect(editor.onionSkin).toBe(true)
    onionCheckbox.click()
    expect(editor.onionSkin).toBe(false)

    const [beforeInput, afterInput] = [
      ...container.querySelectorAll<HTMLInputElement>('.tl-options .tl-number')
    ]
    beforeInput.value = '4'
    beforeInput.dispatchEvent(new Event('change', { bubbles: true }))
    expect(editor.onionBefore).toBe(4)
    afterInput.value = '9'
    afterInput.dispatchEvent(new Event('change', { bubbles: true }))
    expect(editor.onionAfter).toBe(5)

    tintCheckbox.click()
    expect(editor.onionTint).toBe(true)
    const [tintBefore, tintAfter] = [
      ...container.querySelectorAll<HTMLInputElement>('.tl-options .tl-color')
    ]
    tintBefore.value = '#123456'
    tintBefore.dispatchEvent(new Event('input', { bubbles: true }))
    expect(editor.onionTintBefore).toBe('#123456')
    tintAfter.value = '#654321'
    tintAfter.dispatchEvent(new Event('input', { bubbles: true }))
    expect(editor.onionTintAfter).toBe('#654321')

    outlineCheckbox.click()
    expect(editor.onionOutline).toBe(true)
  })
})

describe('TimelineView — camera and audio layers', () => {
  const AUDIO_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
  /** Decoded 2s clip at 24fps: spans 48 frames from its start. */
  const DECODED_AUDIO = {
    start: () => {},
    stop: () => {},
    sync: () => {},
    scrub: () => {},
    endScrub: () => {},
    durationSeconds: () => 2,
    peaks: (_resourceId: string, buckets: number) =>
      Array.from({ length: buckets }, () => ({ min: -1, max: 1 }))
  }

  let editor: Editor
  let container: HTMLElement
  let view: TimelineView

  beforeEach(() => {
    document.body.textContent = ''
    editor = new Editor(createDocument('test', 960, 540, 24), { audio: DECODED_AUDIO })
    container = document.createElement('div')
    document.body.appendChild(container)
    view = new TimelineView(editor, container)
  })

  const extend = (toFrame: number): void => {
    while (editor.duration <= toFrame) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
  }
  const rowFor = (layerId: string): HTMLElement =>
    [...container.querySelectorAll<HTMLElement>('.tl-row')].find(
      (row) => row.dataset.layerId === layerId
    )!
  const liveAudioLayer = (id: string): AudioLayer => {
    const layer = getLayer(editor.document, id)
    if (!layer || layer.kind !== 'audio') throw new Error('expected the audio layer')
    return layer
  }
  const cameraFrames = (): number[] =>
    editor.cameraLayer?.keyframes.map((keyframe) => keyframe.frame) ?? []

  it('renders camera keyframe markers with tween spans and retimes them by drag', () => {
    const layer = editor.addCameraLayer()
    if (!layer) throw new Error('expected the camera layer')
    extend(7)
    editor.seekToFrame(4)
    editor.ensureCameraKeyframe()
    editor.seekToFrame(0)
    editor.toggleCameraTweenHere()
    view.render()

    const cameraFramesHtml = (): (string | undefined)[] =>
      [...rowFor(layer.id).querySelectorAll<HTMLElement>('.tl-key-camera')].map(
        (marker) => marker.dataset.frame
      )
    expect(cameraFramesHtml()).toEqual(['0', '4'])
    // The tween on frame 0 runs to the next camera keyframe.
    expect(rowFor(layer.id).querySelectorAll('.tl-tween')).toHaveLength(1)

    // Drag the marker at frame 4 two frames right: one undo step.
    rowFor(layer.id)
      .querySelector<HTMLElement>('.tl-key-camera[data-frame="4"]')!
      .dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 50, bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 128, clientY: 50 }))
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 128, clientY: 50 }))
    expect(cameraFrames()).toEqual([0, 6])
    editor.undo()
    expect(cameraFrames()).toEqual([0, 4])
  })

  it('adds, tweens and removes camera keyframes from the context menu', () => {
    const layer = editor.addCameraLayer()
    if (!layer) throw new Error('expected the camera layer')
    extend(7)
    view.render()
    const menu = container.querySelector<HTMLElement>('.tl-context-menu')!
    const button = (label: string): HTMLButtonElement =>
      [...menu.querySelectorAll<HTMLButtonElement>('button')].find(
        (entry) => entry.textContent === label
      )!

    // Camera rows swap the object/audio actions for the camera ones.
    rowFor(layer.id).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 })
    )
    expect(button('Add Camera Keyframe').classList.contains('hidden')).toBe(false)
    expect(button('Toggle Tween').classList.contains('hidden')).toBe(false)
    expect(button('Mute / Unmute').classList.contains('hidden')).toBe(true)
    expect(menu.querySelector('.tl-context-volume')?.classList.contains('hidden')).toBe(true)

    // The row menu has no keyframe target: the key lands at the playhead.
    editor.seekToFrame(3)
    rowFor(layer.id).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 })
    )
    button('Add Camera Keyframe').click()
    expect(editor.hasCameraKeyframeAt(3)).toBe(true)
    expect(menu.classList.contains('hidden')).toBe(true)

    // A marker's menu targets its own frame: tween it, then remove it.
    rowFor(layer.id)
      .querySelector<HTMLElement>('.tl-key-camera[data-frame="3"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    button('Toggle Tween').click()
    expect(
      editor.cameraLayer?.keyframes.find((keyframe) => keyframe.frame === 3)?.tween
    ).toBeDefined()

    rowFor(layer.id)
      .querySelector<HTMLElement>('.tl-key-camera[data-frame="3"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }))
    button('Remove Camera Keyframe').click()
    expect(editor.hasCameraKeyframeAt(3)).toBe(false)
    expect(cameraFrames()).toEqual([0])
  })

  it('shows the audio clip span from the decoded duration and drags it onto a frame', () => {
    editor.resources.put('res-audio', AUDIO_BYTES)
    const layer = editor.addAudioLayer('res-audio', 'Score', 4)
    if (!layer) throw new Error('expected the audio layer')
    view.render()

    const track = (): HTMLElement =>
      rowFor(layer.id).querySelector<HTMLElement>('.tl-audio-track')!
    const clip = track().querySelector<HTMLElement>('.tl-clip')!
    // Decoded 2s at 24fps → 48 frames from the start at frame 4; the strip
    // clamps the visible span to its 40-frame width.
    expect(clip.style.left).toBe(`${4 * 14}px`)
    expect(clip.style.width).toBe(`${(40 - 4) * 14}px`)
    expect(clip.querySelector('.tl-waveform')).not.toBeNull()
    expect(clip.getAttribute('draggable')).toBe('true')

    clip.dispatchEvent(new Event('dragstart', { bubbles: true }))
    expect(clip.classList.contains('dragging')).toBe(true)
    track().getBoundingClientRect = () => ({ left: 180 }) as unknown as DOMRect
    track().dispatchEvent(new MouseEvent('drop', { bubbles: true, clientX: 180 + 7 * 14 + 7 }))
    expect(liveAudioLayer(layer.id).startFrame).toBe(7)
    expect(track().querySelector<HTMLElement>('.tl-clip')!.classList.contains('dragging')).toBe(
      false
    )

    // One undo step restores the original start.
    editor.undo()
    expect(liveAudioLayer(layer.id).startFrame).toBe(4)
  })

  it('mutes and sets the volume through the audio context menu', () => {
    editor.resources.put('res-audio', AUDIO_BYTES)
    const layer = editor.addAudioLayer('res-audio', 'Score', 2)
    if (!layer) throw new Error('expected the audio layer')
    view.render()
    const menu = container.querySelector<HTMLElement>('.tl-context-menu')!
    rowFor(layer.id).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 })
    )

    const button = (label: string): HTMLButtonElement =>
      [...menu.querySelectorAll<HTMLButtonElement>('button')].find(
        (entry) => entry.textContent === label
      )!
    expect(button('Mute / Unmute').classList.contains('hidden')).toBe(false)
    // Camera actions swap out for the audio ones.
    expect(button('Add Camera Keyframe').classList.contains('hidden')).toBe(true)

    // Volume is edited in percent and stored on the layer.
    const volume = menu.querySelector<HTMLInputElement>('.tl-context-volume input')!
    expect(volume.value).toBe('100')
    volume.value = '40'
    volume.dispatchEvent(new Event('change', { bubbles: true }))
    expect(liveAudioLayer(layer.id).volume).toBeCloseTo(0.4)

    // Mute is the layer's visible flag; the clip re-renders dimmed.
    button('Mute / Unmute').click()
    expect(liveAudioLayer(layer.id).visible).toBe(false)
    view.render()
    expect(rowFor(layer.id).querySelector('.tl-clip')?.classList.contains('tl-clip-muted')).toBe(
      true
    )
    editor.undo()
    expect(liveAudioLayer(layer.id).visible).toBe(true)
  })

  it('wires the scrub-audio checkbox both ways', () => {
    const box = container.querySelector<HTMLInputElement>('.tl-controls .tl-check')!
    expect(box.checked).toBe(false)
    box.click()
    expect(editor.scrubAudio).toBe(true)
    box.click()
    expect(editor.scrubAudio).toBe(false)

    // Editor-side changes mirror back onto the control.
    editor.setScrubAudio(true)
    view.render()
    expect(box.checked).toBe(true)
    editor.toggleScrubAudio()
    view.render()
    expect(box.checked).toBe(false)
  })
})
