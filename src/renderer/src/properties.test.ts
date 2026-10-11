// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDocument } from '@shared/document'
import type { Asset, DrawingLayer, ImageNode, PrimitiveNode, SymbolNode } from '@shared/model'

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

  it('renders the layer, shape, path, text, image, group, symbol and draw sections', () => {
    const titles = [...container.querySelectorAll('.panel-section-title')].map((node) =>
      node.textContent?.trim()
    )
    expect(titles).toEqual(['Layer', 'Shape', 'Path', 'Text', 'Image', 'Group', 'Symbol', 'Draw'])
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
