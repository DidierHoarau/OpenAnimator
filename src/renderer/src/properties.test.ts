// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDocument } from '@shared/document'
import type { Asset, DrawingLayer, ImageNode, PrimitiveNode, SymbolNode, TextNode } from '@shared/model'

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

function image(id: string, resourceId = 'hash-1'): ImageNode {
  return {
    id,
    type: 'image',
    name: 'picture.png',
    resourceId,
    center: { x: 100, y: 80 },
    width: 320,
    height: 240,
    rotation: 0,
    opacity: 1,
    naturalWidth: 640,
    naturalHeight: 480,
    smoothing: true
  }
}

function symbolAsset(id: string, name: string): Asset {
  return {
    id,
    name,
    kind: 'symbol',
    content: {
      type: 'group',
      id: 'content',
      center: { x: 0, y: 0 },
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1,
      children: []
    },
    createdAt: 1
  }
}

function sectionByTitle(container: HTMLElement, title: string): HTMLElement {
  const section = [...container.querySelectorAll('.panel-section')].find(
    (candidate) => candidate.querySelector('.panel-section-title')?.textContent?.trim() === title
  )
  if (!section) throw new Error(`missing section ${title}`)
  return section as HTMLElement
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

  it('renders the layer, shape, path, text, image, group, symbol, draw and cell sections', () => {
    const titles = [...container.querySelectorAll('.panel-section-title')].map((node) =>
      node.textContent?.trim()
    )
    expect(titles).toEqual([
      'Layer',
      'Shape',
      'Path',
      'Text',
      'Image',
      'Group',
      'Symbol',
      'Camera',
      'Audio',
      'Draw',
      'Cell',
      'Palette'
    ])
  })

  it('shows the shape section for primitives, the image section for images and the group section for groups', () => {
    const shapeSection = sectionByTitle(container, 'Shape')
    const imageSection = sectionByTitle(container, 'Image')
    const groupSection = sectionByTitle(container, 'Group')
    const symbolSection = sectionByTitle(container, 'Symbol')
    expect(shapeSection.classList.contains('hidden')).toBe(true)
    expect(imageSection.classList.contains('hidden')).toBe(true)
    expect(groupSection.classList.contains('hidden')).toBe(true)
    expect(symbolSection.classList.contains('hidden')).toBe(true)

    editor.addNode(rect('a', 10, 10))
    expect(shapeSection.classList.contains('hidden')).toBe(false)
    expect(imageSection.classList.contains('hidden')).toBe(true)
    expect(groupSection.classList.contains('hidden')).toBe(true)
    expect(symbolSection.classList.contains('hidden')).toBe(true)

    editor.addNode(image('i1'))
    expect(shapeSection.classList.contains('hidden')).toBe(true)
    expect(imageSection.classList.contains('hidden')).toBe(false)
    expect(groupSection.classList.contains('hidden')).toBe(true)
    expect(symbolSection.classList.contains('hidden')).toBe(true)

    editor.selectNodes([], 'replace')
    expect(shapeSection.classList.contains('hidden')).toBe(true)
    expect(imageSection.classList.contains('hidden')).toBe(true)
    expect(groupSection.classList.contains('hidden')).toBe(true)
    expect(symbolSection.classList.contains('hidden')).toBe(true)

    editor.selectNodes(['a'], 'replace')
    editor.groupSelection()
    expect(shapeSection.classList.contains('hidden')).toBe(true)
    expect(imageSection.classList.contains('hidden')).toBe(true)
    expect(groupSection.classList.contains('hidden')).toBe(false)
    expect(symbolSection.classList.contains('hidden')).toBe(true)
  })

  it('edits the group transform through the shared inputs', () => {
    editor.addNode(rect('a', 0, 0))
    editor.addNode(rect('b', 100, 0))
    editor.selectNodes(['a', 'b'], 'replace')
    editor.groupSelection()

    const groupSection = sectionByTitle(container, 'Group')
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

  it('offers ungroup and save-as-symbol in the group section', () => {
    editor.addNode(rect('a', 10, 10))
    editor.selectNodes(['a'], 'replace')
    editor.groupSelection()

    const groupSection = sectionByTitle(container, 'Group')
    const buttons = [...groupSection.querySelectorAll('button')]
    const ungroup = buttons.find((button) => button.textContent === 'Ungroup')!
    const symbol = buttons.find((button) => button.textContent === 'Save as Symbol… (F8)')!
    expect(ungroup.disabled).toBe(false)
    expect(ungroup.title).toBe('Ungroup (Ctrl+Shift+G)')
    expect(symbol.disabled).toBe(false)
    expect(symbol.title).toContain('F8')

    symbol.click()
    expect(editor.document.assets).toHaveLength(1)
    expect(editor.document.assets[0].kind).toBe('symbol')
    // The stage content was replaced by one instance of the new asset.
    const placed = editor.document.layers[0].keyframes[0].nodes[0] as SymbolNode
    expect(placed.type).toBe('symbol')
    expect(placed.assetId).toBe(editor.document.assets[0].id)
  })

  it('shows the symbol section for instances with edit and break-apart actions', () => {
    editor.document.assets = [symbolAsset('s', 'Rocket')]
    editor.placeAsset('s')
    const symbolNode = editor.document.layers[0].keyframes[0].nodes[0] as SymbolNode
    expect(symbolNode.type).toBe('symbol')

    const symbolSection = sectionByTitle(container, 'Symbol')
    expect(symbolSection.classList.contains('hidden')).toBe(false)
    expect(symbolSection.querySelector('.panel-file-name')?.textContent).toBe('Rocket')
    const buttons = [...symbolSection.querySelectorAll('button')]
    const edit = buttons.find((button) => button.textContent === 'Edit Symbol')!
    const breakApart = buttons.find((button) => button.textContent === 'Break Apart')!
    expect(edit.disabled).toBe(false)
    expect(breakApart.disabled).toBe(false)

    breakApart.click()
    expect(editor.document.layers[0].keyframes[0].nodes[0].type).toBe('group')
  })

  it('disables editing for an instance whose asset is missing', () => {
    editor.document.assets = []
    editor.addNode({
      id: 'inst',
      type: 'symbol',
      assetId: 'gone',
      center: { x: 0, y: 0 },
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1
    })
    const symbolSection = sectionByTitle(container, 'Symbol')
    expect(symbolSection.querySelector('.panel-file-name')?.textContent).toBe('(missing asset)')
    const edit = [...symbolSection.querySelectorAll('button')].find(
      (button) => button.textContent === 'Edit Symbol'
    )!
    expect(edit.disabled).toBe(true)
  })

  it('shows the read-only source file name in the image section', () => {
    editor.addNode(image('i1'))
    const imageSection = sectionByTitle(container, 'Image')
    const label = imageSection.querySelector('.panel-file-name') as HTMLElement
    expect(label.textContent).toBe('picture.png')
  })

  it('resets the image to its native size in one undo step', () => {
    editor.addNode(image('i1'))
    const imageSection = sectionByTitle(container, 'Image')
    const nativeButton = [...imageSection.querySelectorAll('button')].find(
      (button) => button.textContent === 'Native size'
    )!
    expect(nativeButton.disabled).toBe(false)

    nativeButton.click()
    const node = editor.document.layers[0].keyframes[0].nodes[0] as ImageNode
    expect(node.width).toBe(640)
    expect(node.height).toBe(480)

    editor.undo()
    const reverted = editor.document.layers[0].keyframes[0].nodes[0] as ImageNode
    expect(reverted.width).toBe(320)
    expect(reverted.height).toBe(240)
  })

  it('replaces the image source, keeping the placed size', async () => {
    const addResource = vi.fn(() => Promise.resolve({ resourceId: 'hash-2', deduped: false }))
    ;(window as unknown as { api: unknown }).api = {
      pickImageFile: () =>
        Promise.resolve({ canceled: false, fileName: 'other.png', bytes: new Uint8Array([1, 2, 3]) }),
      addResource
    }
    container.textContent = ''
    const view = new PropertiesView(editor, container, {
      imageImportDeps: { decode: () => Promise.resolve({ width: 100, height: 50 }) }
    })
    editor.addNode(image('i1'))
    view.render()
    const imageSection = sectionByTitle(container, 'Image')
    const replaceButton = [...imageSection.querySelectorAll('button')].find(
      (button) => button.textContent === 'Replace source…'
    )!

    replaceButton.click()
    await vi.waitFor(() => {
      const node = editor.document.layers[0].keyframes[0].nodes[0] as ImageNode
      expect(node.resourceId).toBe('hash-2')
    })
    const node = editor.document.layers[0].keyframes[0].nodes[0] as ImageNode
    expect(addResource).toHaveBeenCalled()
    expect(node.name).toBe('other.png')
    expect(node.naturalWidth).toBe(100)
    expect(node.naturalHeight).toBe(50)
    // Placed size kept.
    expect(node.width).toBe(320)
    expect(node.height).toBe(240)

    editor.undo()
    const reverted = editor.document.layers[0].keyframes[0].nodes[0] as ImageNode
    expect(reverted.resourceId).toBe('hash-1')
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

describe('PropertiesView — Draw section', () => {
  let editor: Editor
  let container: HTMLElement

  beforeEach(() => {
    window.localStorage.clear()
    document.body.textContent = ''
    editor = new Editor(createDocument('test', 960, 540, 24), {
      createTransparentPng: async () => new Uint8Array([0]),
      storeResource: async () => 'res-1'
    })
    container = document.createElement('aside')
    document.body.appendChild(container)
    new PropertiesView(editor, container)
  })

  const drawSection = (): HTMLElement => {
    const section = [...container.querySelectorAll('.panel-section')].find(
      (candidate) => candidate.querySelector('.panel-section-title')?.textContent?.trim() === 'Draw'
    )
    if (!section) throw new Error('missing section Draw')
    return section as HTMLElement
  }

  it('shows the Draw section only for drawing layers', () => {
    expect(drawSection().classList.contains('hidden')).toBe(true)

    editor.addLayerAtBottom('drawing')
    expect(drawSection().classList.contains('hidden')).toBe(false)

    editor.setCurrentLayer(editor.document.layers[0].id)
    expect(drawSection().classList.contains('hidden')).toBe(true)
  })

  it('mirrors the brush settings into its inputs', () => {
    editor.addLayerAtBottom('drawing')
    editor.setBrushColor('#00ff00')
    editor.setBrushSize(12)
    editor.setBrushOpacity(0.5)
    editor.setTool('eraser')

    const section = drawSection()
    const color = section.querySelector<HTMLInputElement>('input[type="color"]')!
    const size = section.querySelector<HTMLInputElement>('input[type="number"]')!
    expect(color.value).toBe('#00ff00')
    expect(size.value).toBe('12')

    // Editing the size feeds back into the editor.
    size.value = '30'
    size.dispatchEvent(new Event('change', { bubbles: true }))
    expect(editor.brushSize).toBe(30)
    expect(editor.tool).toBe('eraser')
  })

  it('navigates cells and runs cell operations from the section buttons', async () => {
    editor.addLayerAtBottom('drawing')
    editor.commitStroke('res-1', 0)
    // Extend the authored timeline so the playhead can sit past the cell
    // (seeking no longer extends the timeline as a side effect).
    while (editor.duration <= 5) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    editor.seekToFrame(2)
    // A fresh render pass after the seek.
    const section = drawSection()
    const buttons = [...section.querySelectorAll('button')]
    const prev = buttons.find((button) => button.textContent === '◀ Prev')!
    const duplicate = buttons.find((button) => button.textContent === 'Duplicate')!
    const next = buttons.find((button) => button.textContent === 'Next ▶')!
    expect(prev.disabled).toBe(false)
    expect(next.disabled).toBe(true)

    prev.click()
    expect(editor.currentFrame).toBe(0)

    editor.seekToFrame(3)
    duplicate.click()
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    const layer = editor.document.layers.find(
      (candidate): candidate is DrawingLayer => candidate.kind === 'drawing'
    )!
    expect(layer.cells.map((cell) => cell.frame)).toEqual([0, 3])
    // F6 duplicates the previous cell: frame 3 holds the painted content.
    expect(layer.cells[1].resourceId).toBe('res-1')
  })
})

describe('PropertiesView — Cell section', () => {
  let editor: Editor
  let container: HTMLElement

  beforeEach(() => {
    window.localStorage.clear()
    document.body.textContent = ''
    editor = new Editor(createDocument('test', 960, 540, 24), {
      createTransparentPng: async () => new Uint8Array([0]),
      storeResource: async () => 'res-blank'
    })
    container = document.createElement('aside')
    document.body.appendChild(container)
    new PropertiesView(editor, container)
  })

  const cellSection = (): HTMLElement => {
    const section = [...container.querySelectorAll('.panel-section')].find(
      (candidate) => candidate.querySelector('.panel-section-title')?.textContent?.trim() === 'Cell'
    )
    if (!section) throw new Error('missing section Cell')
    return section as HTMLElement
  }

  const numberInputs = (): { start: HTMLInputElement; end: HTMLInputElement; move: HTMLInputElement } => {
    const inputs = [
      ...cellSection().querySelectorAll<HTMLInputElement>('input[type="number"]')
    ]
    return { start: inputs[0], end: inputs[1], move: inputs[2] }
  }

  const drawingLayer = (): DrawingLayer =>
    editor.document.layers.find(
      (candidate): candidate is DrawingLayer => candidate.kind === 'drawing'
    )!

  /** Grows the authored timeline past `frame` so cells can move there. */
  const extendTo = (frame: number): void => {
    while (editor.duration <= frame) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
  }

  it('shows the visible range of the cell under the playhead', () => {
    expect(cellSection().classList.contains('hidden')).toBe(true)

    editor.addLayerAtBottom('drawing')
    expect(cellSection().classList.contains('hidden')).toBe(false)
    const range = (): string =>
      cellSection().querySelector('.panel-suffix')!.textContent ?? ''
    expect(range()).toBe('no cell here')
    expect(numberInputs().start.disabled).toBe(true)

    editor.commitStroke('res-1', 0)
    expect(range()).toBe('frames 1\u2013end')
    expect(numberInputs().start.value).toBe('1')
    expect(numberInputs().start.disabled).toBe(false)

    // A second cell ends the hold of the first.
    extendTo(5)
    editor.commitStroke('res-2', 3)
    editor.seekToFrame(1)
    expect(range()).toBe('frames 1\u20133')
    expect(numberInputs().end.value).toBe('3')
  })

  it('moves the cell by editing its start frame and the playhead follows', () => {
    editor.addLayerAtBottom('drawing')
    editor.commitStroke('res-1', 0)
    extendTo(5)

    const { start } = numberInputs()
    start.value = '4'
    start.dispatchEvent(new Event('change', { bubbles: true }))

    expect(drawingLayer().cells.map((cell) => cell.frame)).toEqual([3])
    expect(editor.currentFrame).toBe(3)
    expect(cellSection().querySelector('.panel-suffix')!.textContent).toBe('frames 4\u2013end')
  })

  it('retimes a held cell by editing its end frame', async () => {
    editor.addLayerAtBottom('drawing')
    editor.commitStroke('res-1', 0)
    extendTo(5)
    editor.seekToFrame(1)

    const { end } = numberInputs()
    end.value = '2'
    end.dispatchEvent(new Event('change', { bubbles: true }))
    // The retime stores a transparent cell: an async step.
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    // Shrinking the last cell inserts a transparent cell after the new end,
    // so the painted cell stops holding at frame 2.
    const frames = drawingLayer().cells.map((cell) => cell.frame)
    expect(frames).toEqual([0, 2])
    expect(drawingLayer().cells[1].resourceId).not.toBe('res-1')
    expect(cellSection().querySelector('.panel-suffix')!.textContent).toBe('frames 1\u20132')
  })

  it('moves the cell to a frame from its Move to input', () => {
    editor.addLayerAtBottom('drawing')
    editor.commitStroke('res-1', 2)
    extendTo(5)
    editor.seekToFrame(4)

    const { move } = numberInputs()
    move.value = '6'
    move.dispatchEvent(new Event('change', { bubbles: true }))

    expect(drawingLayer().cells.map((cell) => cell.frame)).toEqual([5])
    expect(editor.currentFrame).toBe(5)
  })
})

describe('PropertiesView — Layer move', () => {
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

  it('moves the selection to a frame from the Layer section', () => {
    editor.addNode(rect('a', 10, 10))
    while (editor.duration <= 5) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }

    const section = sectionByTitle(container, 'Layer')
    const row = [...section.querySelectorAll('.panel-row')].find(
      (candidate) => candidate.querySelector('label')?.textContent === 'Move to'
    )!
    const input = row.querySelector<HTMLInputElement>('input[type="number"]')!
    expect(input.disabled).toBe(false)
    expect(input.value).toBe('1')

    input.value = '4'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    const frames = (): number[] =>
      editor.currentLayer!.keyframes
        .filter((keyframe) => keyframe.nodes.some((node) => node.id === 'a'))
        .map((keyframe) => keyframe.frame)
    expect(frames()).toEqual([3])
    expect(input.value).toBe('4')

    // One undo step restores the original timing.
    editor.undo()
    expect(frames()).toEqual([0])
  })
})

function textNode(): TextNode {
  return {
    id: 't1',
    type: 'text',
    text: 'Hi',
    fontFamily: 'Noto Sans',
    fontSize: 20,
    fontWeight: 400,
    fill: '#ffffff',
    align: 'left',
    center: { x: 100, y: 80 },
    width: 40,
    height: 25,
    rotation: 0,
    opacity: 1
  }
}

describe('PropertiesView — typography controls', () => {
  let editor: Editor
  let container: HTMLElement

  beforeEach(() => {
    window.localStorage.clear()
    document.body.textContent = ''
    // Deterministic measurement: every character is exactly 10px wide.
    editor = new Editor(createDocument('test', 960, 540, 24), {
      measureText: (line: string) => line.length * 10
    })
    container = document.createElement('aside')
    document.body.appendChild(container)
    new PropertiesView(editor, container, {
      listSystemFonts: () =>
        Promise.resolve([
          { family: 'Inter', weights: [400, 700] },
          { family: 'Lato', weights: [400] }
        ])
    })
    editor.addNode(textNode())
  })

  function rowInput(label: string, selector: string): HTMLElement {
    const section = sectionByTitle(container, 'Text')
    const row = [...section.querySelectorAll('.panel-row')].find(
      (candidate) => candidate.querySelector('label')?.textContent === label
    )
    if (!row) throw new Error(`missing row ${label}`)
    const input = row.querySelector(selector)
    if (!input) throw new Error(`missing ${selector} in row ${label}`)
    return input as HTMLElement
  }

  function selectedTextNode(): TextNode {
    const layer = editor.document.layers[0]
    if (layer.kind !== 'object') throw new Error('expected an object layer')
    return layer.keyframes[0].nodes[0] as TextNode
  }

  it('edits letter spacing and re-measures the text box', () => {
    const spacing = rowInput('Spacing', 'input[type="number"]') as HTMLInputElement
    expect(spacing.value).toBe('0')
    spacing.value = '5'
    spacing.dispatchEvent(new Event('change'))

    const node = selectedTextNode()
    expect(node.letterSpacing).toBe(5)
    // 2 characters × 10px + 5px per character.
    expect(node.width).toBe(30)
    expect(node.height).toBe(25)

    // Zero drops the field again so the spacing stays absent.
    const again = rowInput('Spacing', 'input[type="number"]') as HTMLInputElement
    again.value = '0'
    again.dispatchEvent(new Event('change'))
    expect(selectedTextNode().letterSpacing).toBeUndefined()
  })

  it('edits the line height and re-measures the text box', () => {
    const input = rowInput('Line height', 'input[type="number"]') as HTMLInputElement
    expect(input.value).toBe('1.25')
    input.value = '2'
    input.dispatchEvent(new Event('change'))

    const node = selectedTextNode()
    expect(node.lineHeight).toBe(2)
    // One line × 20px font size × 2.
    expect(node.height).toBe(40)
  })

  it('edits the vertical placement and drops the field back at top', () => {
    const select = rowInput('Vertical', 'select') as HTMLSelectElement
    expect(select.value).toBe('top')
    select.value = 'middle'
    select.dispatchEvent(new Event('change'))
    expect(selectedTextNode().verticalAlign).toBe('middle')

    const again = rowInput('Vertical', 'select') as HTMLSelectElement
    again.value = 'top'
    again.dispatchEvent(new Event('change'))
    expect('verticalAlign' in selectedTextNode()).toBe(false)
  })

  it('offers the full weight range and writes the picked weight', () => {
    const select = rowInput('Weight', 'select') as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual([
      '100',
      '200',
      '300',
      '400',
      '500',
      '600',
      '700',
      '800',
      '900'
    ])
    select.value = '900'
    select.dispatchEvent(new Event('change'))
    expect(selectedTextNode().fontWeight).toBe(900)
  })

  it('writes the fallback families, caps them at 8 and clears when emptied', () => {
    const input = rowInput('Fallbacks', 'input[type="text"]') as HTMLInputElement
    input.value = 'Lato, Inter , '
    input.dispatchEvent(new Event('change'))
    expect(selectedTextNode().fontFallback).toEqual(['Lato', 'Inter'])

    const capped = rowInput('Fallbacks', 'input[type="text"]') as HTMLInputElement
    capped.value = 'a,b,c,d,e,f,g,h,i,j'
    capped.dispatchEvent(new Event('change'))
    expect(selectedTextNode().fontFallback).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])

    const cleared = rowInput('Fallbacks', 'input[type="text"]') as HTMLInputElement
    cleared.value = ''
    cleared.dispatchEvent(new Event('change'))
    expect(selectedTextNode().fontFallback).toBeUndefined()
  })

  it('edits the text outline through the toggle, color and width', () => {
    const toggle = rowInput('Outline', 'input[type="checkbox"]') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    toggle.checked = true
    toggle.dispatchEvent(new Event('change'))
    expect(selectedTextNode().stroke).toBe('#e6edf3')
    expect(selectedTextNode().strokeWidth).toBe(2)

    const color = rowInput('Outline', 'input[type="color"]') as HTMLInputElement
    color.value = '#ff0000'
    color.dispatchEvent(new Event('input'))
    color.dispatchEvent(new Event('change'))
    expect(selectedTextNode().stroke).toBe('#ff0000')

    const width = rowInput('Outline', 'input[type="number"]') as HTMLInputElement
    width.value = '4'
    width.dispatchEvent(new Event('change'))
    expect(selectedTextNode().strokeWidth).toBe(4)

    const off = rowInput('Outline', 'input[type="checkbox"]') as HTMLInputElement
    off.checked = false
    off.dispatchEvent(new Event('change'))
    expect(selectedTextNode().stroke).toBeUndefined()
    expect(selectedTextNode().strokeWidth).toBeUndefined()
  })

  it('suggests the installed font families in the font field datalist', async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const datalist = sectionByTitle(container, 'Text').querySelector('datalist')!
    expect(datalist.id).toBe('oa-system-fonts')
    expect([...datalist.querySelectorAll('option')].map((option) => option.value)).toEqual([
      'Inter',
      'Lato'
    ])
    const fontInput = rowInput('Font', 'input') as HTMLInputElement
    expect(fontInput.getAttribute('list')).toBe('oa-system-fonts')
  })
})

describe('PropertiesView — tween easing editor and motion path', () => {
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

  const presetSelect = (): HTMLSelectElement =>
    container.querySelector<HTMLSelectElement>('.easing-editor__preset')!
  const pathSelect = (): HTMLSelectElement => {
    const row = [...container.querySelectorAll('.panel-row')].find(
      (candidate) => candidate.querySelector('label')?.textContent === 'Motion path'
    )!
    return row.querySelector('select')!
  }
  const field = (name: string): HTMLInputElement =>
    container.querySelector<HTMLInputElement>(`.easing-editor__input[data-field="${name}"]`)!
  const tweenAt = (frame: number) =>
    editor.currentLayer!.keyframes.find((keyframe) => keyframe.frame === frame)?.tween

  it('disables the easing controls until the selected object is tween-keyed', () => {
    editor.addNode(rect('a', 0, 0))
    // Keyed but not tweened: the whole editor is disabled.
    expect(presetSelect().disabled).toBe(true)
    expect(pathSelect().disabled).toBe(true)
    expect(field('x1').disabled).toBe(true)

    editor.toggleTweenHere()
    expect(presetSelect().disabled).toBe(false)
    expect(pathSelect().disabled).toBe(false)
    expect(field('x1').disabled).toBe(false)
  })

  it('mirrors the keyframe tween and writes easing and path picks back', () => {
    editor.addNode(rect('a', 0, 0))
    editor.toggleTweenHere()
    // Default tween: the ease-in-out preset on a linear path.
    expect(presetSelect().value).toBe('ease-in-out')
    expect(field('x1').value).toBe('0.42')
    expect(field('y2').value).toBe('1')
    expect(pathSelect().value).toBe('linear')

    // A custom bezier syncs to the Custom entry with the exact fields.
    editor.setTweenEasingHere({ x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 })
    expect(presetSelect().value).toBe('custom')
    expect(field('x2').value).toBe('0.3')

    // Picking a preset applies it and re-syncs the fields.
    presetSelect().value = 'ease-out'
    presetSelect().dispatchEvent(new Event('change', { bubbles: true }))
    expect(tweenAt(0)).toEqual({ easing: 'ease-out' })
    expect(field('x1').value).toBe('0')
    expect(field('x2').value).toBe('0.58')

    // The motion-path mode travels through its own select and is undoable.
    pathSelect().value = 'smooth'
    pathSelect().dispatchEvent(new Event('change', { bubbles: true }))
    expect(tweenAt(0)).toEqual({ easing: 'ease-out', path: 'smooth' })
    editor.undo()
    expect(tweenAt(0)).toEqual({ easing: 'ease-out' })
    expect(pathSelect().value).toBe('linear')
  })
})
