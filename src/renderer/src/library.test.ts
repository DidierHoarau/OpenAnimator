// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { createDocument } from '@shared/document'
import type { Asset, GroupNode, SceneNode, SymbolNode } from '@shared/model'

import { Editor } from './editor'
import { LibraryView } from './library'
import type { LibraryApi } from './library'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

interface ApiMock {
  listLibrary: Mock
  addLibraryAsset: Mock
  removeLibraryAsset: Mock
  renameLibraryAsset: Mock
  addResource: Mock
}

function rect(id: string, x = 0, y = 0): SceneNode {
  return {
    type: 'primitive',
    primitive: 'rect',
    id,
    center: { x, y },
    width: 100,
    height: 50,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1
  }
}

function symbolContent(children: SceneNode[]): GroupNode {
  return {
    type: 'group',
    id: 'content',
    center: { x: 0, y: 0 },
    width: 300,
    height: 50,
    rotation: 0,
    opacity: 1,
    children
  }
}

function symbolAsset(id: string, name = id): Asset {
  return { id, name, kind: 'symbol', content: symbolContent([rect('child')]), createdAt: 1 }
}

function imageAsset(id: string, resourceId: string): Asset {
  return { id, name: id, kind: 'image', resourceId, naturalWidth: 4, naturalHeight: 3, createdAt: 1 }
}

class MemoryStorage {
  private readonly entries = new Map<string, string>()
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value)
  }
}

interface Harness {
  editor: Editor
  container: HTMLElement
  view: LibraryView
  api: ApiMock
  confirmFn: Mock
}

function setup(assets: Asset[] = [], library: { assets: Asset[]; resources: Record<string, { bytes: Uint8Array; ext: string }> } = { assets: [], resources: {} }): Harness {
  const doc = createDocument('test', 960, 540, 24)
  doc.assets = assets
  const editor = new Editor(doc)
  const container = document.createElement('aside')
  document.body.appendChild(container)
  const api: ApiMock = {
    listLibrary: vi.fn(() => Promise.resolve(library)),
    addLibraryAsset: vi.fn(() => Promise.resolve()),
    removeLibraryAsset: vi.fn(() => Promise.resolve()),
    renameLibraryAsset: vi.fn(() => Promise.resolve()),
    addResource: vi.fn(() => Promise.resolve({ resourceId: 'hash-a', deduped: false }))
  }
  const confirmFn = vi.fn(() => true)
  const stage = document.createElement('div')
  document.body.appendChild(stage)
  stage.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  const view = new LibraryView(editor, container, {
    api: api as unknown as LibraryApi,
    confirm: confirmFn,
    storage: new MemoryStorage() as unknown as Storage,
    dropTarget: {
      element: stage,
      toStagePoint: (event) => ({ x: event.clientX, y: event.clientY })
    }
  })
  return { editor, container, view, api, confirmFn }
}

function tiles(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.library-tile')]
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.body.querySelectorAll<HTMLButtonElement>('.library-menu-item')].find(
    (candidate) => candidate.textContent === label
  )
  if (!item) throw new Error(`missing menu item ${label}`)
  return item
}

function openMenu(container: HTMLElement, index: number): void {
  const tile = tiles(container)[index]
  tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }))
}

function pointer(event: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number): PointerEvent {
  return new PointerEvent(event, {
    button: 0,
    clientX: x,
    clientY: y,
    pointerId: 1,
    bubbles: true,
    cancelable: true
  })
}

describe('LibraryView — document tab', () => {
  beforeEach(() => {
    document.body.textContent = ''
  })

  it('shows the empty state and tiles once the document has assets', () => {
    const { container } = setup()
    expect(container.querySelector('.library-empty')?.textContent).toContain('No assets yet')

    const { container: populated } = setup([symbolAsset('a', 'Rocket')])
    const tile = tiles(populated)[0]
    expect(tile.title).toBe('Rocket')
    expect(tile.querySelector('.library-tile-name')?.textContent).toBe('Rocket')
    // Symbol thumbnails render the asset content as an inline svg.
    expect(tile.querySelector('svg')).not.toBeNull()
  })

  it('filters tiles by the search box', () => {
    const { container } = setup([symbolAsset('a', 'Rocket'), imageAsset('b', 'hash-1')])
    const input = container.querySelector<HTMLInputElement>('.library-search-input')!
    input.value = 'roc'
    input.dispatchEvent(new Event('input'))
    expect(tiles(container)).toHaveLength(1)
    expect(tiles(container)[0].title).toBe('Rocket')

    input.value = 'nothing-matches'
    input.dispatchEvent(new Event('input'))
    expect(container.querySelector('.library-empty')).not.toBeNull()
  })

  it('image tiles fall back to a placeholder when the resource is unavailable', () => {
    const { container } = setup([imageAsset('b', 'hash-1')])
    expect(tiles(container)[0].querySelector('.library-thumb-placeholder')).not.toBeNull()
  })

  it('auto-opens the panel when the document gains its first asset', () => {
    const doc = createDocument('test', 960, 540, 24)
    const editor = new Editor(doc)
    const container = document.createElement('aside')
    document.body.appendChild(container)
    const view = new LibraryView(editor, container, { storage: new MemoryStorage() as unknown as Storage })
    expect(view.isVisible).toBe(false)
    expect(container.classList.contains('hidden')).toBe(true)

    const openings: boolean[] = []
    view.onVisibilityChanged((visible) => openings.push(visible))
    editor.addNode(rect('a'))
    editor.saveSelectionAsSymbol()
    expect(view.isVisible).toBe(true)
    expect(container.classList.contains('hidden')).toBe(false)
    // The auto-open notifies like any explicit toggle: the layout drops or
    // restores the library column through the same path.
    expect(openings).toEqual([true])
  })

  it('notifies visibility changes exactly once per actual change', () => {
    const { view } = setup()
    const seen: boolean[] = []
    view.onVisibilityChanged((visible) => seen.push(visible))
    view.setVisible(true)
    view.setVisible(true)
    view.setVisible(false)
    expect(seen).toEqual([true, false])
  })

  it('places a document asset at center via the context menu', () => {
    const { container, editor } = setup([symbolAsset('a', 'Rocket')])
    openMenu(container, 0)
    menuItem('Place at Center').click()

    const layer = editor.document.layers[0]
    const nodes = layer.keyframes[0].nodes
    const node = nodes[nodes.length - 1] as SymbolNode
    expect(node.type).toBe('symbol')
    expect(node.assetId).toBe('a')
    // Fits the stage: centered on 480×270 at the natural content size
    // (the single 100×50 child).
    expect(node.center).toEqual({ x: 480, y: 270 })
    expect(node.width).toBe(100)
    expect(node.height).toBe(50)
  })

  it('warns about on-stage instances before deleting an asset', async () => {
    const { container, editor, confirmFn } = setup([symbolAsset('a', 'Rocket')])
    expect(editor.placeAsset('a')).toBe(true) // one instance is now on stage

    confirmFn.mockReturnValueOnce(false)
    openMenu(container, 0)
    menuItem('Delete').click()
    await vi.waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1))
    expect(confirmFn.mock.calls[0][0]).toContain('1 instance(s)')
    expect(editor.document.assets).toHaveLength(1)

    confirmFn.mockReturnValueOnce(true)
    menuItem('Delete').click()
    await vi.waitFor(() => expect(editor.document.assets).toHaveLength(0))
  })

  it('duplicates an asset with a fresh identity', () => {
    const { container, editor } = setup([symbolAsset('a', 'Rocket')])
    openMenu(container, 0)
    menuItem('Duplicate').click()
    expect(editor.document.assets).toHaveLength(2)
    expect(editor.document.assets[1].name).toBe('Rocket copy')
    expect(editor.document.assets[1].id).not.toBe('a')
    // The copy is independent: mutating one content child leaves the other.
    const originalChild = editor.document.assets[0].content!.children[0] as { fill: string }
    const copyChild = editor.document.assets[1].content!.children[0] as { fill: string }
    copyChild.fill = '#00ff00'
    expect(originalChild.fill).toBe('#ff0000')
  })

  it('saves an asset to My Library with the document as resolution context', async () => {
    const { container, api, editor } = setup([symbolAsset('a', 'Rocket')])
    openMenu(container, 0)
    menuItem('Save to My Library').click()
    await vi.waitFor(() => expect(api.addLibraryAsset).toHaveBeenCalledTimes(1))
    expect(api.addLibraryAsset).toHaveBeenCalledWith(editor.document.assets[0], editor.document.assets)
  })

  it('renames a document asset inline (Enter commits, Escape cancels)', () => {
    const { container, editor } = setup([symbolAsset('a', 'Rocket')])
    openMenu(container, 0)
    menuItem('Rename').click()
    const input = container.querySelector<HTMLInputElement>('.library-rename-input')!
    expect(input.value).toBe('Rocket')

    input.value = 'Spaceship'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(editor.document.assets[0].name).toBe('Spaceship')

    openMenu(container, 0)
    menuItem('Rename').click()
    const second = container.querySelector<HTMLInputElement>('.library-rename-input')!
    second.value = 'Discarded'
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(editor.document.assets[0].name).toBe('Spaceship')
  })
})

describe('LibraryView — My Library tab', () => {
  beforeEach(() => {
    document.body.textContent = ''
  })

  function setupGlobal(library: { assets: Asset[]; resources: Record<string, { bytes: Uint8Array; ext: string }> }): Harness {
    return setup([], library)
  }

  it('loads the global library on tab switch and hides document-only actions', async () => {
    const { container, api } = setupGlobal({ assets: [symbolAsset('g1', 'Global')], resources: {} })
    const globalTab = [...container.querySelectorAll<HTMLButtonElement>('.library-tab')].find(
      (tab) => tab.textContent === 'My Library'
    )!
    globalTab.click()
    await vi.waitFor(() => expect(api.listLibrary).toHaveBeenCalled())
    await vi.waitFor(() => expect(tiles(container)).toHaveLength(1))
    expect(tiles(container)[0].title).toBe('Global')

    openMenu(container, 0)
    expect(menuItem('Delete')).toBeDefined()
    expect(() => menuItem('Duplicate')).toThrow(/missing menu item/)
    expect(() => menuItem('Save to My Library')).toThrow(/missing menu item/)
  })

  it('removes a global asset after confirmation and refreshes', async () => {
    const { container, api, confirmFn } = setupGlobal({ assets: [symbolAsset('g1', 'Global')], resources: {} })
    const globalTab = [...container.querySelectorAll<HTMLButtonElement>('.library-tab')].find(
      (tab) => tab.textContent === 'My Library'
    )!
    globalTab.click()
    await vi.waitFor(() => expect(tiles(container)).toHaveLength(1))

    openMenu(container, 0)
    menuItem('Delete').click()
    expect(confirmFn.mock.calls[0][0]).toContain('Remove "Global" from My Library?')
    await vi.waitFor(() => expect(api.removeLibraryAsset).toHaveBeenCalledWith('g1'))
  })

  it('renames a global asset through the API', async () => {
    const { container, api } = setupGlobal({ assets: [symbolAsset('g1', 'Global')], resources: {} })
    const globalTab = [...container.querySelectorAll<HTMLButtonElement>('.library-tab')].find(
      (tab) => tab.textContent === 'My Library'
    )!
    globalTab.click()
    await vi.waitFor(() => expect(tiles(container)).toHaveLength(1))

    openMenu(container, 0)
    menuItem('Rename').click()
    const input = container.querySelector<HTMLInputElement>('.library-rename-input')!
    input.value = 'Renamed'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(api.renameLibraryAsset).toHaveBeenCalledWith('g1', 'Renamed'))
  })

  it('imports resources and places when dropping a global asset onto the stage', async () => {
    const { container, editor, api } = setupGlobal({
      assets: [imageAsset('g1', 'hash-a')],
      resources: { 'hash-a': { bytes: PNG_BYTES, ext: 'png' } }
    })
    const globalTab = [...container.querySelectorAll<HTMLButtonElement>('.library-tab')].find(
      (tab) => tab.textContent === 'My Library'
    )!
    globalTab.click()
    await vi.waitFor(() => expect(tiles(container)).toHaveLength(1))

    const tile = tiles(container)[0]
    tile.dispatchEvent(pointer('pointerdown', 10, 10))
    tile.dispatchEvent(pointer('pointermove', 120, 90))
    expect(document.body.querySelector('.library-drag-ghost')).not.toBeNull()
    tile.dispatchEvent(pointer('pointerup', 120, 90))

    await vi.waitFor(() => expect(api.addResource).toHaveBeenCalledWith(PNG_BYTES, 'hash-a.png'))
    expect(editor.resources.getUrl('hash-a')).not.toBeNull()
    // The asset was imported into the document and an instance placed at the
    // drop point.
    expect(editor.document.assets.map((asset) => asset.id)).toEqual(['g1'])
    const node = editor.document.layers[0].keyframes[0].nodes[0]
    expect(node.type).toBe('image')
    expect(node.center).toEqual({ x: 120, y: 90 })
  })
})

describe('LibraryView — pointer drag', () => {
  beforeEach(() => {
    document.body.textContent = ''
  })

  it('ignores presses that never reach the drag threshold', () => {
    const { container, editor } = setup([symbolAsset('a')])
    const tile = tiles(container)[0]
    tile.dispatchEvent(pointer('pointerdown', 10, 10))
    tile.dispatchEvent(pointer('pointermove', 12, 10))
    tile.dispatchEvent(pointer('pointerup', 12, 10))
    expect(document.body.querySelector('.library-drag-ghost')).toBeNull()
    expect(editor.document.layers[0].keyframes[0].nodes).toHaveLength(0)
  })

  it('does not place when released outside the stage', () => {
    const { container, editor } = setup([symbolAsset('a')])
    const tile = tiles(container)[0]
    tile.dispatchEvent(pointer('pointerdown', 10, 10))
    tile.dispatchEvent(pointer('pointermove', 2000, 2000))
    tile.dispatchEvent(pointer('pointerup', 2000, 2000))
    expect(editor.document.layers[0].keyframes[0].nodes).toHaveLength(0)
    // The drag highlight and ghost are cleaned up.
    expect(document.body.querySelector('.library-drag-ghost')).toBeNull()
    expect(
      [...document.body.querySelectorAll('.library-drop-hover')]
    ).toHaveLength(0)
  })

  it('places a document asset at the drop point', () => {
    const { container, editor } = setup([symbolAsset('a', 'Rocket')])
    const tile = tiles(container)[0]
    tile.dispatchEvent(pointer('pointerdown', 10, 10))
    tile.dispatchEvent(pointer('pointermove', 200, 100))
    tile.dispatchEvent(pointer('pointerup', 200, 100))
    const node = editor.document.layers[0].keyframes[0].nodes[0] as SymbolNode
    expect(node.type).toBe('symbol')
    expect(node.assetId).toBe('a')
    expect(node.center).toEqual({ x: 200, y: 100 })
    expect(document.body.querySelector('.library-drag-ghost')).toBeNull()
  })
})
