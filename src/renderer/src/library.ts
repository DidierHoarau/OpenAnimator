import type { LibraryListResult, ResourceAddResult } from '@shared/api'
import { collectAssetResourceIds } from '@shared/assets'
import { el } from './dom'
import type { Vec2 } from '@shared/geometry'
import type { Asset } from '@shared/model'
import { nodeToSvgMarkup } from '@shared/renderSvg'
import type { Editor } from './editor'
import { importImageViaDialog } from './imageImport'
import { showConfirmDialog } from './modal'
import { loadLibraryVisible, saveLibraryVisible, type StorageLike } from './sectionState'

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Tile thumbnail box in pixels. */
const THUMB = 72
/** Minimum pointer travel before a tile press becomes a drag. */
const MIN_DRAG = 4

/** Subset of the preload API the library panel needs (injectable for tests). */
export interface LibraryApi {
  listLibrary(): Promise<LibraryListResult>
  addLibraryAsset(asset: Asset, contextAssets?: Asset[]): Promise<void>
  removeLibraryAsset(id: string): Promise<void>
  renameLibraryAsset(id: string, name: string): Promise<void>
  addResource(bytes: Uint8Array, fileName: string): Promise<ResourceAddResult>
}

export interface LibraryDropTarget {
  element: Element
  toStagePoint: (event: PointerEvent) => Vec2
}

export interface LibraryViewOptions {
  api?: LibraryApi
  confirm?: (message: string) => boolean | Promise<boolean>
  storage?: StorageLike
  dropTarget?: LibraryDropTarget
}

interface MenuEntry {
  label: string
  action: () => void
}

interface DragState {
  asset: Asset
  tile: HTMLElement
  startX: number
  startY: number
  started: boolean
  ghost: HTMLElement | null
}

/**
 * Left panel with the document's assets and the persistent global "My
 * Library": tabbed grid of 72 px thumbnails with names, search, a context
 * menu (rename, duplicate, delete with instance-count warning, place at
 * center, save to My Library), "Import Image…" and "New Symbol from
 * Selection" buttons, and a custom pointer-based drag onto the stage that
 * places an instance at the drop point. Hidden by default; auto-opens when
 * the document gains its first asset.
 */
export class LibraryView {
  private readonly editor: Editor
  private readonly container: HTMLElement
  private readonly api: LibraryApi | undefined
  private readonly confirmFn: (message: string) => boolean | Promise<boolean>
  private readonly storage: StorageLike
  private readonly dropTarget: LibraryDropTarget | undefined

  private readonly grid: HTMLDivElement
  private readonly searchInput: HTMLInputElement
  private readonly banner: HTMLDivElement
  private readonly bannerText: HTMLElement
  private readonly menu: HTMLDivElement
  private readonly tabs: Record<'document' | 'global', HTMLButtonElement>

  private activeTab: 'document' | 'global' = 'document'
  private library: LibraryListResult | null = null
  private visible: boolean
  private renamingId: string | null = null
  private previousAssetCount = 0
  private drag: DragState | null = null
  private transientUrls: string[] = []
  private readonly visibilityListeners = new Set<(visible: boolean) => void>()

  constructor(
    editor: Editor,
    container: HTMLElement,
    options: LibraryViewOptions = {}
  ) {
    this.editor = editor
    this.container = container
    this.api = options.api
    this.confirmFn =
      options.confirm ??
      ((message) => showConfirmDialog({ title: 'Confirm', message, confirmLabel: 'OK' }))
    this.storage = options.storage ?? window.localStorage
    this.dropTarget = options.dropTarget
    this.visible = loadLibraryVisible(this.storage)

    const tabsRow = el('div', 'library-tabs')
    const documentTab = el('button', 'library-tab active', 'Document')
    documentTab.type = 'button'
    const globalTab = el('button', 'library-tab', 'My Library')
    globalTab.type = 'button'
    documentTab.addEventListener('click', () => this.setTab('document'))
    globalTab.addEventListener('click', () => this.setTab('global'))
    tabsRow.append(documentTab, globalTab)
    this.tabs = { document: documentTab, global: globalTab }

    const searchRow = el('div', 'library-search')
    this.searchInput = el('input', 'library-search-input') as HTMLInputElement
    this.searchInput.type = 'search'
    this.searchInput.placeholder = 'Search assets…'
    this.searchInput.setAttribute('aria-label', 'Search assets')
    this.searchInput.addEventListener('input', () => this.renderGrid())
    searchRow.appendChild(this.searchInput)

    const actions = el('div', 'library-actions')
    const importButton = el('button', undefined, 'Import Image…')
    importButton.title = 'Import an image onto the stage and into the document library'
    importButton.addEventListener('click', () => void importImageViaDialog(editor))
    const symbolButton = el('button', undefined, 'New Symbol from Selection')
    symbolButton.title = 'Save the selection as a reusable symbol (F8)'
    symbolButton.addEventListener('click', () => {
      if (!editor.saveSelectionAsSymbol()) editor.showMessage('Select objects on the stage first')
    })
    actions.append(importButton, symbolButton)

    this.banner = el('div', 'library-banner')
    this.banner.classList.add('hidden')
    this.bannerText = el('span', 'library-banner-text')
    const finishButton = el('button', undefined, 'Finish')
    finishButton.title = 'Commit the symbol edits to every instance'
    finishButton.addEventListener('click', () => editor.endSymbolEdit(true))
    const cancelButton = el('button', undefined, 'Cancel')
    cancelButton.title = 'Discard the symbol edits'
    cancelButton.addEventListener('click', () => editor.endSymbolEdit(false))
    this.banner.append(this.bannerText, finishButton, cancelButton)

    this.grid = el('div', 'library-grid')

    const scroll = el('div', 'library-scroll')
    scroll.append(this.grid)
    container.append(tabsRow, searchRow, actions, this.banner, scroll)
    container.classList.toggle('hidden', !this.visible)

    this.menu = el('div', 'library-menu hidden')
    document.body.appendChild(this.menu)
    window.addEventListener('pointerdown', (event) => {
      if (!this.menu.contains(event.target as Node)) this.closeMenu()
    })

    void this.refreshLibrary()
    editor.onDocChange(() => this.onDocChanged())
    editor.onUiChange(() => this.renderBanner())
    this.renderBanner()
    this.renderGrid()
  }

  /** Whether the panel is currently shown. */
  get isVisible(): boolean {
    return this.visible
  }

  /** Notifies when the panel visibility changes (toolbar, auto-open, …). */
  onVisibilityChanged(listener: (visible: boolean) => void): void {
    this.visibilityListeners.add(listener)
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    saveLibraryVisible(this.storage, visible)
    this.container.classList.toggle('hidden', !visible)
    for (const listener of this.visibilityListeners) {
      try {
        listener(visible)
      } catch (error) {
        console.error('OpenAnimator: library visibility listener failed', error)
      }
    }
  }

  private setTab(tab: 'document' | 'global'): void {
    if (this.activeTab === tab) return
    this.activeTab = tab
    if (tab === 'global') void this.refreshLibrary()
    this.renderTabs()
    this.renderGrid()
  }

  private renderTabs(): void {
    this.tabs.document.classList.toggle('active', this.activeTab === 'document')
    this.tabs.global.classList.toggle('active', this.activeTab === 'global')
  }

  private async refreshLibrary(): Promise<void> {
    if (!this.api) return
    try {
      this.library = await this.api.listLibrary()
    } catch (error) {
      console.warn('OpenAnimator: failed to load the global library', error)
      this.library = { assets: [], resources: {} }
    }
    if (this.activeTab === 'global') this.renderGrid()
  }

  private onDocChanged(): void {
    const count = this.editor.document.assets.length
    // Auto-open on the first asset ever added to this document.
    if (count > 0 && this.previousAssetCount === 0 && !this.visible) this.setVisible(true)
    this.previousAssetCount = count
    this.renderBanner()
    this.renderGrid()
  }

  private renderBanner(): void {
    const editing = this.editor.editingAssetId
    if (!editing) {
      this.banner.classList.add('hidden')
      return
    }
    const asset = this.editor.document.assets.find((entry) => entry.id === editing)
    this.bannerText.textContent = `Editing symbol "${asset?.name ?? ''}" — instances update on finish`
    this.banner.classList.remove('hidden')
  }

  private assets(): Asset[] {
    if (this.activeTab === 'document') return this.editor.document.assets
    return this.library?.assets ?? []
  }

  private filtered(): Asset[] {
    const needle = this.searchInput.value.trim().toLowerCase()
    const assets = this.assets()
    if (!needle) return assets
    return assets.filter((asset) => asset.name.toLowerCase().includes(needle))
  }

  private renderGrid(): void {
    this.revokeTransientUrls()
    this.grid.textContent = ''
    const assets = this.filtered()
    if (assets.length === 0) {
      const empty = el(
        'p',
        'library-empty',
        this.activeTab === 'document'
          ? 'No assets yet — import an image or save a selection as a symbol.'
          : 'My Library is empty — save document assets here from their context menu.'
      )
      this.grid.appendChild(empty)
      return
    }
    for (const asset of assets) {
      this.grid.appendChild(this.createTile(asset))
    }
  }

  private createTile(asset: Asset): HTMLElement {
    const tile = el('button', 'library-tile')
    tile.type = 'button'
    tile.title = asset.name
    const thumb = this.createThumb(asset)
    const name = el('span', 'library-tile-name', asset.name)
    tile.append(thumb, name)

    tile.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.openMenu(event.clientX, event.clientY, asset)
    })
    tile.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      if (this.renamingId === asset.id) return
      this.drag = {
        asset,
        tile,
        startX: event.clientX,
        startY: event.clientY,
        started: false,
        ghost: null
      }
      tile.setPointerCapture(event.pointerId)
    })
    tile.addEventListener('pointermove', (event) => this.onDragMove(event))
    tile.addEventListener('pointerup', (event) => this.onDragEnd(event))
    tile.addEventListener('pointercancel', () => this.cancelDrag())
    if (this.renamingId === asset.id) this.beginInlineRename(tile, asset, name)
    return tile
  }

  private createThumb(asset: Asset): HTMLElement {
    const box = el('span', 'library-thumb')
    if (asset.kind === 'symbol' && asset.content) {
      const svg = document.createElementNS(SVG_NS, 'svg')
      const size = Math.max(asset.content.width, asset.content.height, 1)
      svg.setAttribute('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`)
      svg.setAttribute('width', String(THUMB - 12))
      svg.setAttribute('height', String(THUMB - 12))
      svg.innerHTML = nodeToSvgMarkup(asset.content)
      box.appendChild(svg)
      return box
    }
    if (asset.kind === 'image' && asset.resourceId) {
      const url = this.imageUrl(asset.resourceId)
      if (url) {
        const image = el('img', 'library-thumb-image') as HTMLImageElement
        image.src = url
        image.alt = asset.name
        image.draggable = false
        box.appendChild(image)
        return box
      }
    }
    box.appendChild(el('span', 'library-thumb-placeholder', '?'))
    return box
  }

  private imageUrl(resourceId: string): string | null {
    if (this.activeTab === 'document') return this.editor.resources.getUrl(resourceId)
    const resource = this.library?.resources[resourceId]
    if (!resource) return null
    const url = URL.createObjectURL(
      new Blob([resource.bytes.slice().buffer as ArrayBuffer], { type: `image/${resource.ext}` })
    )
    this.transientUrls.push(url)
    return url
  }

  private revokeTransientUrls(): void {
    for (const url of this.transientUrls) URL.revokeObjectURL(url)
    this.transientUrls = []
  }

  // Context menu

  private openMenu(x: number, y: number, asset: Asset): void {
    this.closeMenu()
    this.menu.textContent = ''
    const entries: MenuEntry[] = [
      { label: 'Place at Center', action: () => void this.place(asset) },
      { label: 'Rename', action: () => this.startRename(asset) },
      ...(asset.kind === 'symbol'
        ? [
            {
              label: 'Edit Symbol',
              action: () => {
                if (!this.editor.beginSymbolEdit(asset.id)) {
                  this.editor.showMessage('The symbol could not be opened for editing')
                }
              }
            }
          ]
        : [])
    ]
    if (this.activeTab === 'document') {
      entries.push({
        label: 'Duplicate',
        action: () => void this.editor.duplicateAsset(asset.id)
      })
      entries.push({ label: 'Save to My Library', action: () => void this.saveToLibrary(asset) })
    }
    entries.push({ label: 'Delete', action: () => void this.removeAsset(asset) })
    for (const entry of entries) {
      const item = el('button', 'library-menu-item', entry.label)
      item.type = 'button'
      item.addEventListener('click', () => {
        this.closeMenu()
        entry.action()
      })
      this.menu.appendChild(item)
    }
    this.menu.classList.remove('hidden')
    const width = this.menu.offsetWidth || 160
    this.menu.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`
    this.menu.style.top = `${Math.min(y, window.innerHeight - this.menu.offsetHeight - 8)}px`
  }

  private closeMenu(): void {
    this.menu.classList.add('hidden')
  }

  private startRename(asset: Asset): void {
    this.renamingId = asset.id
    this.renderGrid()
  }

  private beginInlineRename(tile: HTMLElement, asset: Asset, name: HTMLElement): void {
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'library-rename-input'
    input.value = asset.name
    input.setAttribute('aria-label', 'New asset name')
    name.replaceWith(input)
    input.focus()
    input.select()

    let finished = false
    const finish = (commit: boolean): void => {
      if (finished) return
      finished = true
      this.renamingId = null
      const value = input.value.trim()
      if (commit && value && value !== asset.name) {
        if (this.activeTab === 'document') this.editor.renameAsset(asset.id, value)
        else void this.api?.renameLibraryAsset(asset.id, value).then(() => this.refreshLibrary())
      } else {
        this.renderGrid()
      }
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') finish(true)
      else if (event.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', () => finish(true))
    tile.addEventListener('pointerdown', (event) => event.stopPropagation())
  }

  // Actions

  private async place(asset: Asset, at?: Vec2): Promise<void> {
    if (this.activeTab === 'document') {
      this.editor.placeAsset(asset.id, at)
      return
    }
    await this.placeFromLibrary(asset, at)
  }

  /** Copies a global-library asset's resources into the session stores and
   * places an instance (import-on-use; content dedupe makes this cheap). */
  private async placeFromLibrary(asset: Asset, at?: Vec2): Promise<void> {
    const api = this.api
    const library = this.library
    if (!api || !library) return
    const cache: Record<string, Uint8Array> = {}
    for (const resourceId of collectAssetResourceIds(asset, library.assets)) {
      const resource = library.resources[resourceId]
      if (!resource) continue
      await api.addResource(resource.bytes, `${resourceId}.${resource.ext}`)
      cache[resourceId] = resource.bytes
    }
    this.editor.importAndPlaceAsset(asset, cache, at)
  }

  private async saveToLibrary(asset: Asset): Promise<void> {
    if (!this.api) return
    await this.api.addLibraryAsset(asset, this.editor.document.assets)
    await this.refreshLibrary()
    this.editor.showMessage(`"${asset.name}" saved to My Library`)
  }

  private async removeAsset(asset: Asset): Promise<void> {
    if (this.activeTab === 'document') {
      const instances = this.editor.countAssetInstances(asset.id)
      const warning =
        instances > 0
          ? `Delete "${asset.name}"? ${instances} instance(s) on the stage will become placeholders.`
          : `Delete "${asset.name}"?`
      if (!(await this.confirmFn(warning))) return
      this.editor.deleteAsset(asset.id)
      return
    }
    if (!(await this.confirmFn(`Remove "${asset.name}" from My Library?`))) return
    await this.api?.removeLibraryAsset(asset.id)
    await this.refreshLibrary()
  }

  // Pointer drag onto the stage (custom, not HTML5 DnD)

  private onDragMove(event: PointerEvent): void {
    const drag = this.drag
    if (!drag) return
    if (!drag.started) {
      const travel = Math.max(
        Math.abs(event.clientX - drag.startX),
        Math.abs(event.clientY - drag.startY)
      )
      if (travel < MIN_DRAG) return
      drag.started = true
      drag.ghost = this.createGhost(drag)
    }
    drag.ghost?.style.setProperty('left', `${event.clientX + 10}px`)
    drag.ghost?.style.setProperty('top', `${event.clientY + 10}px`)
    this.dropTarget?.element.classList.toggle('library-drop-hover', this.isOverDropTarget(event))
    event.preventDefault()
  }

  private createGhost(drag: DragState): HTMLElement {
    const ghost = el('div', 'library-drag-ghost')
    ghost.appendChild(this.createThumb(drag.asset))
    ghost.appendChild(el('span', 'library-tile-name', drag.asset.name))
    document.body.appendChild(ghost)
    return ghost
  }

  private isOverDropTarget(event: PointerEvent): boolean {
    if (!this.dropTarget) return false
    const box = this.dropTarget.element.getBoundingClientRect()
    return (
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom
    )
  }

  private onDragEnd(event: PointerEvent): void {
    const drag = this.drag
    this.drag = null
    drag?.ghost?.remove()
    this.dropTarget?.element.classList.remove('library-drop-hover')
    if (!drag || !drag.started) return
    const over = this.dropTarget ? this.isOverDropTarget(event) : false
    if (!over) return
    void this.place(drag.asset, this.dropTarget!.toStagePoint(event))
  }

  private cancelDrag(): void {
    this.drag?.ghost?.remove()
    this.dropTarget?.element.classList.remove('library-drop-hover')
    this.drag = null
  }
}
