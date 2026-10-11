import {
  addLayer as addLayerOp,
  addNodeToLayer,
  cloneDocument,
  createDocument,
  createLayer,
  documentDuration,
  evaluateLayerAtFrame,
  findCellAtFrame,
  findKeyframeAtFrame,
  findKeyframeIndexForFrame,
  findNearestNodeKeyframeIndex,
  findNextCellFrame,
  findPreviousCellFrame,
  getLayer,
  insertBlankKeyframe,
  insertCell as insertCellOp,
  insertFrame,
  moveLayer as moveLayerOp,
  removeCell as removeCellOp,
  removeFrame,
  removeLayer as removeLayerOp,
  removeNodeFromAllKeyframes,
  removeNodeFromLayer,
  renameLayer as renameLayerOp,
  renameNodeInLayer,
  resolveCellAtFrame,
  setCellContent as setCellContentOp,
  setKeyframeTween,
  updateNodeInLayer
} from '@shared/document'
import {
  assetNaturalSize,
  countAssetInstances as countAssetInstancesOp,
  createDocumentAsset,
  duplicateAsset as duplicateAssetOp,
  instanceToGroup,
  symbolContentFromGroup
} from '@shared/assets'
import type { EasingName } from '@shared/easing'
import { fitImagePlacement } from '@shared/imagePlacement'
import { nodeBounds } from '@shared/hitTesting'
import type { Rect } from '@shared/hitTesting'
import { groupNaturalSize, groupNodes, ungroupNode } from '@shared/groups'
import type { Vec2 } from '@shared/geometry'
import { cloneNode, isDrawingLayer, isObjectLayer } from '@shared/model'
import type { AnimatorDocument, Asset, DrawingLayer, GroupNode, ImageNode, Layer, ObjectLayer, SceneNode, SymbolNode } from '@shared/model'
import { validateAssetGraph } from '@shared/symbols'
import { createId } from '@shared/document'
import { createTransparentPng } from './drawing'
import { ResourceCache } from './resourceCache'

export type Tool = 'select' | 'rect' | 'ellipse' | 'hand' | 'brush' | 'eraser'

/**
 * Whether a tool may be active while `layer` is the current layer: the tool
 * availability matrix (Brush/Eraser only on drawing layers, Select/Rectangle/
 * Ellipse only on object layers, Hand everywhere).
 */
export function toolCompatibleWithLayer(tool: Tool, layer: Layer | undefined): boolean {
  if (tool === 'hand') return true
  if (!layer) return false
  return isObjectLayer(layer)
    ? tool === 'select' || tool === 'rect' || tool === 'ellipse'
    : tool === 'brush' || tool === 'eraser'
}

/** Injectable side effects for environments without a DOM (tests). */
export interface EditorDeps {
  /** Encodes a fully transparent PNG of the given pixel size. */
  createTransparentPng?: (width: number, height: number) => Promise<Uint8Array | null>
  /** Stores bytes in the session resource store; returns the resource id. */
  storeResource?: (bytes: Uint8Array) => Promise<string | null>
}

function defaultStoreResource(bytes: Uint8Array): Promise<string | null> {
  return window.api.addResource(bytes, 'cell.png').then((result) => result.resourceId)
}

export type SelectionMode = 'replace' | 'add' | 'toggle'

/**
 * Editor state shared by the stage and timeline views. Owns the current
 * document, playhead, selection, active tool, playback loop and the
 * snapshot-based undo/redo history, and notifies views through three
 * channels: document changes, frame changes and UI state changes (tool,
 * playback, selection).
 */
export class Editor {
  /** Maximum number of undo snapshots kept in memory. */
  static readonly HISTORY_LIMIT = 100

  document: AnimatorDocument
  /** Content-addressed binary resources of the session (image blobs etc.). */
  readonly resources = new ResourceCache()
  currentFrame = 0
  currentLayerId: string
  /** Selected node ids in click order; the last one is the primary selection. */
  selectedNodeIds: string[] = []
  tool: Tool = 'select'
  playing = false
  loop = true
  onionSkin = false
  /** Path of the project file the document was loaded from / saved to. */
  filePath: string | null = null
  dirty = false
  /** Asset currently being edited in the isolated scratch document, if any. */
  editingAssetId: string | null = null
  /** Brush color (session state, not part of the document). */
  brushColor = '#e6edf3'
  /** Brush/eraser width in stage pixels, 1–100. */
  brushSize = 6
  /** Brush stroke opacity 0..1 (the eraser always erases fully). */
  brushOpacity = 1

  private readonly deps: EditorDeps
  /** Transparent cell buffers already stored, keyed by pixel size: blank
   * cells are real cells holding a transparent PNG, which content-addressed
   * storage dedupes to one resource per buffer size. */
  private readonly transparentCellIds = new Map<string, string>()
  private readonly undoStack: AnimatorDocument[] = []
  private readonly redoStack: AnimatorDocument[] = []
  /** Depth of the coalesced interaction currently open (drags push once). */
  private interactionDepth = 0
  /** Real document parked while a symbol is being edited in isolation. */
  private savedDocument: AnimatorDocument | null = null

  private readonly docListeners = new Set<() => void>()
  private readonly frameListeners = new Set<() => void>()
  private readonly uiListeners = new Set<() => void>()
  private readonly messageListeners = new Set<(message: string) => void>()
  private rafId: number | null = null
  private lastTick: number | null = null
  private accumulator = 0

  constructor(document: AnimatorDocument, deps: EditorDeps = {}) {
    this.document = document
    this.deps = deps
    this.currentLayerId = document.layers[0]?.id ?? ''
    this.autoSwitchTool()
  }

  get duration(): number {
    return documentDuration(this.document)
  }

  get currentLayer(): Layer | undefined {
    return getLayer(this.document, this.currentLayerId)
  }

  /** The most recently selected node (drives the properties panel). */
  get primarySelectedNodeId(): string | null {
    return this.selectedNodeIds.length > 0
      ? this.selectedNodeIds[this.selectedNodeIds.length - 1]
      : null
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  onDocChange(listener: () => void): void {
    this.docListeners.add(listener)
  }

  onFrameChange(listener: () => void): void {
    this.frameListeners.add(listener)
  }

  onUiChange(listener: () => void): void {
    this.uiListeners.add(listener)
  }

  onMessage(listener: (message: string) => void): void {
    this.messageListeners.add(listener)
  }

  private docChanged(): void {
    this.dirty = true
    for (const listener of this.docListeners) listener()
  }

  private frameChanged(): void {
    for (const listener of this.frameListeners) listener()
  }

  private uiChanged(): void {
    for (const listener of this.uiListeners) listener()
  }

  /** Surfaces a transient status-bar message (import feedback, hints…). */
  showMessage(message: string): void {
    for (const listener of this.messageListeners) listener(message)
  }

  /**
   * Pushes the current document onto the undo stack before a mutation. Skipped
   * inside a coalesced interaction so a whole drag becomes a single entry.
   */
  private pushHistory(): void {
    if (this.interactionDepth > 0) return
    this.pushSnapshot()
  }

  private pushSnapshot(): void {
    this.undoStack.push(cloneDocument(this.document))
    if (this.undoStack.length > Editor.HISTORY_LIMIT) this.undoStack.shift()
    this.redoStack.length = 0
  }

  /**
   * Opens a coalesced interaction (e.g. a pointer drag): exactly one history
   * entry is committed for everything mutated until `endInteraction`.
   */
  beginInteraction(): void {
    this.interactionDepth += 1
    this.pushSnapshot()
  }

  endInteraction(): void {
    this.interactionDepth = Math.max(0, this.interactionDepth - 1)
  }

  undo(): void {
    const snapshot = this.undoStack.pop()
    if (!snapshot) {
      this.showMessage('Nothing to undo')
      return
    }
    this.redoStack.push(cloneDocument(this.document))
    this.applySnapshot(snapshot, 'Undo')
  }

  redo(): void {
    const snapshot = this.redoStack.pop()
    if (!snapshot) {
      this.showMessage('Nothing to redo')
      return
    }
    this.undoStack.push(cloneDocument(this.document))
    this.applySnapshot(snapshot, 'Redo')
  }

  private applySnapshot(snapshot: AnimatorDocument, message: string): void {
    this.document = snapshot
    const clamped = Math.min(this.currentFrame, Math.max(0, this.duration - 1))
    const frameMoved = clamped !== this.currentFrame
    this.currentFrame = clamped
    if (!getLayer(this.document, this.currentLayerId)) {
      this.currentLayerId = this.document.layers[0]?.id ?? ''
    }
    this.autoSwitchTool()
    this.pruneSelection()
    this.docChanged()
    if (frameMoved) this.frameChanged()
    this.uiChanged()
    this.showMessage(message)
  }

  setDocument(document: AnimatorDocument, resources: Record<string, Uint8Array> = {}): void {
    this.pause()
    this.document = document
    this.editingAssetId = null
    this.savedDocument = null
    this.resources.reset(resources)
    this.currentLayerId = document.layers[0]?.id ?? ''
    this.currentFrame = 0
    this.selectedNodeIds = []
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.interactionDepth = 0
    this.transparentCellIds.clear()
    this.autoSwitchTool()
    this.docChanged()
    this.uiChanged()
    // A cyclic or over-deep asset graph must never hang the renderer: the
    // resolution guard keeps it renderable, and the problem is reported here.
    const symbolProblem = validateAssetGraph(document.assets)
    if (symbolProblem) this.showMessage(symbolProblem)
  }

  newDocument(): void {
    this.setDocument(createDocument('Untitled', 960, 540, 24))
  }

  /** Records a successful save to the given file path and clears the dirty flag. */
  markSaved(filePath: string | null): void {
    this.filePath = filePath
    this.dirty = false
    this.uiChanged()
  }

  setFrame(frame: number): void {
    const clamped = Math.min(Math.max(0, Math.floor(frame)), Math.max(0, this.duration - 1))
    if (clamped === this.currentFrame) return
    this.currentFrame = clamped
    this.frameChanged()
  }

  /**
   * Moves the playhead within the visible grid, extending the authored
   * timeline when seeking past its end so keyframes can be added after the
   * last one. Playback advances through setFrame and is unaffected.
   */
  seekToFrame(frame: number): void {
    const target = Math.max(0, Math.floor(frame))
    if (target >= this.duration) {
      this.pushHistory()
      this.document.frames = target + 1
      this.docChanged()
    }
    this.setFrame(target)
  }

  setTool(tool: Tool): void {
    if (this.tool === tool) return
    // The tool availability matrix: incompatible tools are ignored (the
    // toolbar dims them), so a tool can never be active on the wrong layer.
    if (!toolCompatibleWithLayer(tool, this.currentLayer)) return
    this.tool = tool
    this.uiChanged()
  }

  /**
   * Auto-switches to a compatible tool when the current one cannot be used on
   * the current layer (drawing layer → Brush, object layer → Select). Tools
   * compatible with both kinds, like Hand, survive a layer switch.
   */
  private autoSwitchTool(): void {
    if (toolCompatibleWithLayer(this.tool, this.currentLayer)) return
    const layer = this.currentLayer
    this.tool = layer && isDrawingLayer(layer) ? 'brush' : 'select'
  }

  /**
   * Replaces or updates the selection set. `replace` selects exactly `ids`,
   * `add` merges them into the selection and `toggle` flips the membership of
   * every id (shift-click and shift-marquee semantics).
   */
  selectNodes(ids: string[], mode: SelectionMode): void {
    let next: string[]
    if (mode === 'replace') {
      next = [...ids]
    } else if (mode === 'add') {
      const merged = new Set(this.selectedNodeIds)
      for (const id of ids) merged.add(id)
      next = [...merged]
    } else {
      const merged = new Set(this.selectedNodeIds)
      for (const id of ids) {
        if (merged.has(id)) merged.delete(id)
        else merged.add(id)
      }
      next = [...merged]
    }
    if (
      next.length === this.selectedNodeIds.length &&
      next.every((id, index) => id === this.selectedNodeIds[index])
    ) {
      return
    }
    this.selectedNodeIds = next
    this.uiChanged()
  }

  /** Drops selection ids that no longer exist anywhere in the document. */
  private pruneSelection(): void {
    if (this.selectedNodeIds.length === 0) return
    const present = new Set<string>()
    for (const layer of this.document.layers) {
      if (!isObjectLayer(layer)) continue
      for (const keyframe of layer.keyframes) {
        for (const node of keyframe.nodes) present.add(node.id)
      }
    }
    this.selectedNodeIds = this.selectedNodeIds.filter((id) => present.has(id))
  }

  /** Union of the rotation-aware bounds of the evaluated selected nodes. */
  getSelectionBounds(): Rect | null {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer)) return null
    let bounds: Rect | null = null
    for (const node of evaluateLayerAtFrame(layer, this.currentFrame)) {
      if (!this.selectedNodeIds.includes(node.id)) continue
      const box = nodeBounds(node)
      if (!bounds) {
        bounds = { ...box }
        continue
      }
      const minX = Math.min(bounds.x, box.x)
      const minY = Math.min(bounds.y, box.y)
      const maxX = Math.max(bounds.x + bounds.width, box.x + box.width)
      const maxY = Math.max(bounds.y + bounds.height, box.y + box.height)
      bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    }
    return bounds
  }

  togglePlay(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  play(): void {
    if (this.playing || this.duration <= 1) return
    this.playing = true
    this.lastTick = null
    this.accumulator = 0
    this.uiChanged()
    this.startLoop()
  }

  pause(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.lastTick = null
    this.accumulator = 0
    if (!this.playing) return
    this.playing = false
    this.uiChanged()
  }

  stopPlayback(): void {
    this.pause()
    this.setFrame(0)
  }

  toggleLoop(): void {
    this.loop = !this.loop
    this.uiChanged()
  }

  toggleOnionSkin(): void {
    this.onionSkin = !this.onionSkin
    this.uiChanged()
    this.frameChanged()
  }

  setFps(fps: number): void {
    if (!Number.isFinite(fps) || fps < 1 || fps > 120 || fps === this.document.fps) return
    this.pushHistory()
    this.document.fps = Math.round(fps)
    this.docChanged()
  }

  addNode(node: SceneNode): void {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked || !layer.visible) return
    this.pushHistory()
    this.insertNode(node)
  }

  /** Adds an image node and registers it as a document image asset in one
   * undo step (import keeps the library and the stage consistent). */
  addImageWithAsset(node: ImageNode): void {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked || !layer.visible) return
    this.pushHistory()
    this.insertNode(node)
    this.document.assets.push(
      createDocumentAsset({
        name: node.name ?? 'Image',
        kind: 'image',
        resourceId: node.resourceId,
        naturalWidth: node.naturalWidth,
        naturalHeight: node.naturalHeight
      })
    )
    this.docChanged()
  }

  /** Body of addNode without its own history entry (callers push first). */
  private insertNode(node: SceneNode): void {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer)) return
    // Auto-key: the new node gets its own pose at the current frame instead
    // of bleeding into an earlier keyframe's hold; other objects hold through.
    if (!findKeyframeAtFrame(layer, this.currentFrame)) {
      insertBlankKeyframe(layer, this.currentFrame)
    }
    addNodeToLayer(layer, this.currentFrame, node)
    this.selectedNodeIds = [node.id]
    this.docChanged()
    this.uiChanged()
  }

  /** Updates the primary selected node, auto-keying it first. One history entry. */
  updateSelectedNode(update: (node: SceneNode) => void): boolean {
    const primary = this.primarySelectedNodeId
    if (!primary) return false
    return this.updateNodesById([primary], update)
  }

  /**
   * Updates every selected node of the current layer, auto-keying each one
   * first (object-level keyframes; other objects hold through). One history
   * entry for the whole set.
   */
  updateSelectedNodes(update: (node: SceneNode) => void): boolean {
    return this.updateNodesById(this.selectedNodeIds, update)
  }

  private updateNodesById(ids: string[], update: (node: SceneNode) => void): boolean {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return false
    const keyable = ids.filter(
      (id) => findNearestNodeKeyframeIndex(layer, id, this.currentFrame) !== -1
    )
    if (keyable.length === 0) return false
    this.pushHistory()
    let changed = false
    for (const id of keyable) {
      if (this.ensureNodeKeyframeMutation(layer, id)) changed = true
      if (updateNodeInLayer(layer, this.currentFrame, id, update)) changed = true
    }
    if (changed) this.docChanged()
    return changed
  }

  nudgeSelected(dx: number, dy: number): void {
    this.updateSelectedNodes((node) => {
      node.center.x += dx
      node.center.y += dy
    })
  }

  /** Deletes every selected node of the current layer at the current frame. */
  deleteSelected(): void {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return
    const removable = this.selectedNodeIds.filter((id) =>
      this.isNodeInActiveKeyframe(layer, id)
    )
    if (removable.length === 0) return
    this.pushHistory()
    let removed = false
    for (const id of removable) {
      if (removeNodeFromLayer(layer, this.currentFrame, id)) removed = true
    }
    if (removed) {
      this.pruneSelection()
      this.docChanged()
      this.uiChanged()
    }
  }

  private isNodeInActiveKeyframe(layer: ObjectLayer, nodeId: string): boolean {
    const index = findKeyframeIndexForFrame(layer, this.currentFrame)
    return index !== -1 && layer.keyframes[index].nodes.some((node) => node.id === nodeId)
  }

  /**
   * Adds a keyframe for every selected object at the current frame (F6): only
   * the selected objects get a pose, every other object keeps holding through.
   * Returns true when a keyframe was created.
   */
  insertKeyframeHere(): boolean {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return false
    const ids = this.selectedNodeIds.filter(
      (id) => findNearestNodeKeyframeIndex(layer, id, this.currentFrame) !== -1
    )
    if (ids.length === 0) return false
    this.pushHistory()
    let created = false
    for (const id of ids) {
      if (this.ensureNodeKeyframeMutation(layer, id)) created = true
    }
    if (created) {
      this.docChanged()
      this.showMessage('New keyframe created')
    }
    return created
  }

  /**
   * Returns true when the given node has its own keyframe exactly at the
   * given frame (content merely holding through from an earlier keyframe does
   * not count).
   */
  hasNodeKeyframeAt(layerId: string, nodeId: string, frame: number): boolean {
    const layer = getLayer(this.document, layerId)
    if (!layer || !isObjectLayer(layer)) return false
    const keyframe = layer.keyframes.find((keyframe) => keyframe.frame === frame)
    return keyframe?.nodes.some((n) => n.id === nodeId) ?? false
  }

  /**
   * Ensures the node has its own pose at the current frame: creates the
   * keyframe when missing — object-level, holding only this node, so every
   * other object keeps holding through — and copies the node in from its
   * nearest keyframe when the keyframe lacks it.
   * Returns true when the document content changed.
   */
  ensureNodeKeyframe(nodeId: string): boolean {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return false
    if (!this.canKeyNode(layer, nodeId)) return false
    this.pushHistory()
    if (!this.ensureNodeKeyframeMutation(layer, nodeId)) return false
    this.docChanged()
    this.showMessage('New keyframe created')
    return true
  }

  /**
   * Auto-key primitive for edits of the selection: guarantees every selected
   * node has a pose at the current frame. Pushes history unless inside a
   * coalesced interaction. Returns true when the document content changed.
   */
  ensureSelectedNodesKeyframes(): boolean {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return false
    const ids = this.selectedNodeIds.filter((id) => this.canKeyNode(layer, id))
    if (ids.length === 0) return false
    this.pushHistory()
    let changed = false
    for (const id of ids) {
      if (this.ensureNodeKeyframeMutation(layer, id)) changed = true
    }
    if (changed) this.docChanged()
    return changed
  }

  private canKeyNode(layer: ObjectLayer, nodeId: string): boolean {
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (keyframe?.nodes.some((n) => n.id === nodeId)) return false
    return findNearestNodeKeyframeIndex(layer, nodeId, this.currentFrame) !== -1
  }

  private ensureNodeKeyframeMutation(layer: ObjectLayer, nodeId: string): boolean {
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (keyframe?.nodes.some((n) => n.id === nodeId)) return false
    const sourceIndex = findNearestNodeKeyframeIndex(layer, nodeId, this.currentFrame)
    const sourceNode =
      sourceIndex === -1
        ? undefined
        : layer.keyframes[sourceIndex].nodes.find((n) => n.id === nodeId)
    if (!sourceNode) return false
    const target = keyframe ?? insertBlankKeyframe(layer, this.currentFrame)
    if (!target) return false
    target.nodes.push(cloneNode(sourceNode))
    return true
  }

  /**
   * Groups the selected nodes of the current layer into one group node
   * (Ctrl+G): every selected node is auto-keyed first, then the nodes present
   * in the keyframe at the current frame are replaced by the group at the
   * topmost grouped child's index (z-order preserved). One undo step.
   * Returns true when a group was created.
   */
  groupSelection(): boolean {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return false
    const keyable = this.selectedNodeIds.filter((id) => this.canKeyNode(layer, id))
    this.pushHistory()
    for (const id of keyable) {
      this.ensureNodeKeyframeMutation(layer, id)
    }
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe) {
      this.showMessage('Select objects on the stage to group them')
      return false
    }
    const selected = new Set(this.selectedNodeIds)
    let topmostIndex = -1
    const members: SceneNode[] = []
    keyframe.nodes.forEach((node, index) => {
      if (selected.has(node.id)) {
        members.push(node)
        topmostIndex = index
      }
    })
    if (members.length === 0) {
      this.showMessage('Select objects on the stage to group them')
      return false
    }
    const group = groupNodes(members, createId('node'))
    // Remove the members highest-index first so earlier indexes stay valid,
    // then place the group where its topmost child was (z-order preserved).
    for (let index = keyframe.nodes.length - 1; index >= 0; index--) {
      if (selected.has(keyframe.nodes[index].id)) keyframe.nodes.splice(index, 1)
    }
    keyframe.nodes.splice(topmostIndex - members.length + 1, 0, group)
    this.selectedNodeIds = [group.id]
    this.docChanged()
    this.uiChanged()
    return true
  }

  /**
   * Ungroups every selected group present in the keyframe at the current
   * frame (Ctrl+Shift+G): each group is replaced by its children composed
   * back into the layer space, which become the new selection. One undo step
   * for the whole set. Returns true when a group was dissolved.
   */
  ungroupSelection(): boolean {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return false
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe) return false
    const groups = keyframe.nodes.filter(
      (node): node is GroupNode => node.type === 'group' && this.selectedNodeIds.includes(node.id)
    )
    if (groups.length === 0) return false
    this.pushHistory()
    const insertedIds: string[] = []
    for (const group of groups) {
      const index = keyframe.nodes.indexOf(group)
      if (index === -1) continue
      const children = ungroupNode(group)
      keyframe.nodes.splice(index, 1, ...children)
      insertedIds.push(...children.map((child) => child.id))
    }
    this.selectedNodeIds = insertedIds
    this.docChanged()
    this.uiChanged()
    return true
  }

  /**
   * Saves the selected nodes of the current layer as a reusable symbol (F8):
   * the selection is grouped exactly like Ctrl+G, the group becomes a
   * document asset and the stage content is replaced by one symbol instance
   * at the group's transform. Mirrors groupSelection: operates on the nodes
   * present in the keyframe at the current frame, one undo step, z-order
   * preserved. Returns true when a symbol was created.
   */
  saveSelectionAsSymbol(): boolean {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return false
    const keyable = this.selectedNodeIds.filter((id) => this.canKeyNode(layer, id))
    this.pushHistory()
    for (const id of keyable) {
      this.ensureNodeKeyframeMutation(layer, id)
    }
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe) {
      this.showMessage('Select objects on the stage to save them as a symbol')
      return false
    }
    const selected = new Set(this.selectedNodeIds)
    let topmostIndex = -1
    const members: SceneNode[] = []
    keyframe.nodes.forEach((node, index) => {
      if (selected.has(node.id)) {
        members.push(node)
        topmostIndex = index
      }
    })
    if (members.length === 0) {
      this.showMessage('Select objects on the stage to save them as a symbol')
      return false
    }
    const group = groupNodes(members, createId('node'))
    const asset = createDocumentAsset({
      name: `Symbol ${this.document.assets.filter((entry) => entry.kind === 'symbol').length + 1}`,
      kind: 'symbol',
      content: symbolContentFromGroup(group)
    })
    const instance: SymbolNode = {
      id: createId('node'),
      type: 'symbol',
      name: asset.name,
      assetId: asset.id,
      center: { ...group.center },
      width: group.width,
      height: group.height,
      rotation: 0,
      opacity: 1
    }
    // Remove the members highest-index first so earlier indexes stay valid,
    // then place the instance where its topmost child was (z-order preserved).
    for (let index = keyframe.nodes.length - 1; index >= 0; index--) {
      if (selected.has(keyframe.nodes[index].id)) keyframe.nodes.splice(index, 1)
    }
    keyframe.nodes.splice(topmostIndex - members.length + 1, 0, instance)
    this.document.assets.push(asset)
    this.selectedNodeIds = [instance.id]
    this.docChanged()
    this.uiChanged()
    return true
  }

  /**
   * Places a copy of a document asset on the current layer (library "place
   * at center", library drag, …): symbols become symbol instances sized to
   * the asset's natural content size (capped to the stage like images),
   * images become image nodes. The placed node is auto-selected.
   */
  placeAsset(assetId: string, at?: Vec2): boolean {
    const asset = this.document.assets.find((entry) => entry.id === assetId)
    if (!asset) return false
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked || !layer.visible) {
      this.showMessage('Select a visible, unlocked object layer to place the asset on')
      return false
    }
    const natural = assetNaturalSize(asset)
    const placement = fitImagePlacement(natural, this.document, at)
    if (asset.kind === 'image' && asset.resourceId) {
      this.addNode({
        id: createId('node'),
        type: 'image',
        name: asset.name,
        resourceId: asset.resourceId,
        center: placement.center,
        width: placement.width,
        height: placement.height,
        rotation: 0,
        opacity: 1,
        naturalWidth: Math.max(1, natural.width),
        naturalHeight: Math.max(1, natural.height),
        smoothing: true
      })
    } else {
      this.addNode({
        id: createId('node'),
        type: 'symbol',
        name: asset.name,
        assetId: asset.id,
        center: placement.center,
        width: placement.width,
        height: placement.height,
        rotation: 0,
        opacity: 1
      })
    }
    return true
  }

  /**
   * Imports an asset from the global library into this document and places
   * it: the asset entry is registered (when not already present) and each
   * given resource is registered in the session cache — one undo step for
   * the whole operation. The caller is responsible for having copied the
   * resource bytes into the main-process session store.
   */
  importAndPlaceAsset(
    asset: Asset,
    resources: Record<string, Uint8Array> = {},
    at?: Vec2
  ): boolean {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked || !layer.visible) {
      this.showMessage('Select a visible, unlocked object layer to place the asset on')
      return false
    }
    for (const [resourceId, bytes] of Object.entries(resources)) {
      this.resources.put(resourceId, bytes)
    }
    const known = this.document.assets.some((entry) => entry.id === asset.id)
    this.beginInteraction()
    try {
      if (!known) this.document.assets.push(structuredClone(asset))
      const placed = this.placeAsset(asset.id, at)
      if (!placed && !known) this.document.assets.pop()
      return placed
    } finally {
      this.endInteraction()
    }
  }

  /** Registers an image resource as a document image asset. Returns its id. */
  registerImageAsset(
    resourceId: string,
    natural: { width: number; height: number },
    name: string
  ): string {
    const asset = createDocumentAsset({
      name,
      kind: 'image',
      resourceId,
      naturalWidth: Math.max(1, natural.width),
      naturalHeight: Math.max(1, natural.height)
    })
    this.pushHistory()
    this.document.assets.push(asset)
    this.docChanged()
    return asset.id
  }

  /** Duplicates a document asset (deep content copy). Returns the new id. */
  duplicateAsset(id: string): string | null {
    const asset = this.document.assets.find((entry) => entry.id === id)
    if (!asset) return null
    const copy = duplicateAssetOp(asset, createId('asset'), `${asset.name} copy`)
    this.pushHistory()
    this.document.assets.push(copy)
    this.docChanged()
    return copy.id
  }

  /** Renames a document asset. */
  renameAsset(id: string, name: string): void {
    const asset = this.document.assets.find((entry) => entry.id === id)
    if (!asset) return
    this.pushHistory()
    asset.name = name
    this.docChanged()
  }

  /** Instances of the asset currently on stage (drives the delete warning). */
  countAssetInstances(assetId: string): number {
    return countAssetInstancesOp(this.document, assetId)
  }

  /**
   * Removes a document asset. Instances keep their place and render as
   * placeholders; the return value is how many instances existed when the
   * asset was removed.
   */
  deleteAsset(id: string): number {
    const index = this.document.assets.findIndex((entry) => entry.id === id)
    if (index === -1) return 0
    const instances = countAssetInstancesOp(this.document, id)
    this.pushHistory()
    this.document.assets.splice(index, 1)
    this.docChanged()
    return instances
  }

  /**
   * Breaks every selected symbol instance apart (properties panel): each
   * instance is replaced by an equivalent standalone group — instance
   * transform, deep-cloned content — fully editable and decoupled from the
   * asset. One undo step for the whole set.
   */
  breakApartSelection(): boolean {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return false
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe) return false
    const instances = keyframe.nodes.filter(
      (node): node is SymbolNode => node.type === 'symbol' && this.selectedNodeIds.includes(node.id)
    )
    if (instances.length === 0) return false
    this.pushHistory()
    const newIds: string[] = []
    for (const instance of instances) {
      const asset = this.document.assets.find((entry) => entry.id === instance.assetId)
      if (!asset || asset.kind !== 'symbol' || !asset.content) {
        this.showMessage('The symbol asset is missing — instance left in place')
        continue
      }
      const group = instanceToGroup(instance, asset.content, createId('node'))
      keyframe.nodes.splice(keyframe.nodes.indexOf(instance), 1, group)
      newIds.push(group.id)
    }
    if (newIds.length === 0) return false
    this.selectedNodeIds = newIds
    this.docChanged()
    this.uiChanged()
    return true
  }

  /**
   * Edits a symbol asset in isolation: the real document is parked and the
   * editor works on a scratch document whose single layer holds clones of
   * the asset's content children (asset-local coordinates). Normal tools and
   * undo work inside; `endSymbolEdit(true)` writes the edited children back
   * into the asset as one history entry, so every instance reflects the
   * change on its next evaluation. Save/autosave are blocked while editing.
   */
  beginSymbolEdit(assetId: string): boolean {
    if (this.editingAssetId) return false
    const asset = this.document.assets.find((entry) => entry.id === assetId)
    if (!asset || asset.kind !== 'symbol' || !asset.content) return false
    const scratch = createDocument(asset.name, this.document.width, this.document.height, this.document.fps)
    scratch.background = this.document.background
    scratch.assets = structuredClone(this.document.assets)
    const layer = createLayer(asset.name)
    layer.keyframes.push({ frame: 0, nodes: asset.content.children.map(cloneNode) })
    scratch.layers = [layer]
    this.pause()
    this.savedDocument = this.document
    this.document = scratch
    this.currentLayerId = layer.id
    this.currentFrame = 0
    this.selectedNodeIds = []
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.editingAssetId = assetId
    this.docChanged()
    this.uiChanged()
    this.showMessage(`Editing symbol "${asset.name}"`)
    return true
  }

  /** Leaves symbol edit mode: commits the frame-0 content back into the
   * asset (one undo entry) or discards it, and restores the real document. */
  endSymbolEdit(commit: boolean): void {
    if (!this.editingAssetId) return
    const assetId = this.editingAssetId
    const realDocument = this.savedDocument
    const scratch = this.document
    this.editingAssetId = null
    this.savedDocument = null
    if (!realDocument) return
    this.document = realDocument
    this.currentLayerId = realDocument.layers[0]?.id ?? ''
    this.currentFrame = 0
    this.selectedNodeIds = []
    this.undoStack.length = 0
    this.redoStack.length = 0
    if (commit) {
      const asset = realDocument.assets.find((entry) => entry.id === assetId)
      const scratchLayer = scratch.layers[0]
      const keyframe =
        scratchLayer && isObjectLayer(scratchLayer)
          ? scratchLayer.keyframes.find((entry) => entry.frame === 0)
          : undefined
      if (asset && asset.kind === 'symbol' && asset.content && keyframe) {
        const children = keyframe.nodes.map(cloneNode)
        const natural = groupNaturalSize(children)
        this.pushHistory()
        asset.content = {
          ...asset.content,
          width: natural.width,
          height: natural.height,
          children
        }
        this.docChanged()
        this.showMessage('Symbol updated')
      }
    }
    this.docChanged()
    this.uiChanged()
  }

  /** Registers resource bytes in the session cache after storing them; the
   * object URL exists before the document change is committed. */
  async storeCellBytes(bytes: Uint8Array): Promise<string | null> {
    try {
      const resourceId = await (this.deps.storeResource ?? defaultStoreResource)(bytes)
      if (resourceId) this.resources.put(resourceId, bytes)
      return resourceId
    } catch (error) {
      console.warn('OpenAnimator: storing the cell resource failed', error)
      this.showMessage('The drawing could not be stored')
      return null
    }
  }

  /**
   * Replaces or creates the cell at `frame` with the given buffer resource —
   * the commit of one paint stroke, as a single undo step. Drawing on a frame
   * without a cell creates one (auto-cell on draw).
   */
  commitStroke(resourceId: string, frame: number = this.currentFrame): boolean {
    const layer = this.currentLayer
    if (!layer || !isDrawingLayer(layer) || layer.locked) return false
    this.pushHistory()
    setCellContentOp(layer, frame, resourceId)
    this.docChanged()
    return true
  }

  /** Fully transparent buffer resource for the layer's cell size, stored once
   * per distinct pixel size (identical buffers dedupe in the resource store). */
  private async transparentCellResource(layer: DrawingLayer): Promise<string | null> {
    const width = Math.max(1, Math.round(this.document.width * layer.resolutionScale))
    const height = Math.max(1, Math.round(this.document.height * layer.resolutionScale))
    const key = `${width}x${height}`
    const cached = this.transparentCellIds.get(key)
    if (cached) return cached
    const bytes = this.deps.createTransparentPng
      ? await this.deps.createTransparentPng(width, height)
      : await createTransparentPng(width, height)
    if (!bytes) return null
    const resourceId = await this.storeCellBytes(bytes)
    if (!resourceId) return null
    this.transparentCellIds.set(key, resourceId)
    return resourceId
  }

  private async cellSeedResource(layer: DrawingLayer, duplicate: boolean): Promise<string | null> {
    if (duplicate) {
      const held = resolveCellAtFrame(layer, this.currentFrame - 1)
      if (held) return held
    }
    return this.transparentCellResource(layer)
  }

  /**
   * F6 on a drawing layer: inserts a cell at the playhead duplicating the
   * previous cell's buffer (in-betweening) — or a transparent one when the
   * layer is blank before. One undo step.
   */
  async insertCellHere(): Promise<boolean> {
    const layer = this.currentLayer
    if (!layer || !isDrawingLayer(layer) || layer.locked) return false
    if (findCellAtFrame(layer, this.currentFrame)) {
      this.showMessage('A cell already exists at this frame')
      return false
    }
    const seed = await this.cellSeedResource(layer, true)
    if (!seed) return false
    this.pushHistory()
    insertCellOp(layer, this.currentFrame, seed)
    this.docChanged()
    this.showMessage('Cell inserted')
    return true
  }

  /** F7 on a drawing layer: inserts a blank (transparent) cell at the
   * playhead, stopping the hold of any previous cell. One undo step. */
  async insertBlankCellHere(): Promise<boolean> {
    const layer = this.currentLayer
    if (!layer || !isDrawingLayer(layer) || layer.locked) return false
    if (findCellAtFrame(layer, this.currentFrame)) {
      this.showMessage('A cell already exists at this frame')
      return false
    }
    const seed = await this.cellSeedResource(layer, false)
    if (!seed) return false
    this.pushHistory()
    insertCellOp(layer, this.currentFrame, seed)
    this.docChanged()
    this.showMessage('Blank cell inserted')
    return true
  }

  /** Clears the cell at the playhead: the frame holds a transparent buffer,
   * so the previous cell stops holding through it. One undo step. */
  async clearCellHere(): Promise<boolean> {
    const layer = this.currentLayer
    if (!layer || !isDrawingLayer(layer) || layer.locked) return false
    if (!resolveCellAtFrame(layer, this.currentFrame)) {
      this.showMessage('Nothing to clear at this frame')
      return false
    }
    const seed = await this.cellSeedResource(layer, false)
    if (!seed) return false
    this.pushHistory()
    setCellContentOp(layer, this.currentFrame, seed)
    this.docChanged()
    this.showMessage('Cell cleared')
    return true
  }

  /** Removes the cell exactly at the playhead: the hold collapses to the
   * previous cell (or the layer goes blank after the last cell). */
  removeCellHere(): boolean {
    const layer = this.currentLayer
    if (!layer || !isDrawingLayer(layer) || layer.locked) return false
    if (!findCellAtFrame(layer, this.currentFrame)) {
      this.showMessage('No cell at this frame')
      return false
    }
    this.pushHistory()
    removeCellOp(layer, this.currentFrame)
    this.docChanged()
    this.showMessage('Cell removed')
    return true
  }

  /** Seeks to the nearest cell boundary before/after the playhead. */
  seekToPreviousCell(): boolean {
    const layer = this.currentLayer
    if (!layer || !isDrawingLayer(layer)) return false
    const frame = findPreviousCellFrame(layer, this.currentFrame)
    if (frame === null) return false
    this.setFrame(frame)
    return true
  }

  seekToNextCell(): boolean {
    const layer = this.currentLayer
    if (!layer || !isDrawingLayer(layer)) return false
    const frame = findNextCellFrame(layer, this.currentFrame)
    if (frame === null) return false
    this.setFrame(frame)
    return true
  }

  setBrushColor(color: string): void {
    this.brushColor = color
    this.uiChanged()
  }

  /** Brush/eraser width in stage pixels, clamped to 1–100. */
  setBrushSize(size: number): void {
    if (!Number.isFinite(size)) return
    this.brushSize = Math.min(100, Math.max(1, Math.round(size)))
    this.uiChanged()
  }

  setBrushOpacity(opacity: number): void {
    if (!Number.isFinite(opacity)) return
    this.brushOpacity = Math.min(1, Math.max(0, opacity))
    this.uiChanged()
  }

  /** Buffer resolution of a drawing layer (1–4 × stage size); affects new
   * buffers only, existing cells keep their pixels. */
  setDrawingResolution(layerId: string, scale: number): void {
    const layer = getLayer(this.document, layerId)
    if (!layer || !isDrawingLayer(layer)) return
    if (!Number.isFinite(scale)) return
    const next = Math.min(4, Math.max(1, Math.round(scale)))
    if (next === layer.resolutionScale) return
    this.pushHistory()
    layer.resolutionScale = next
    this.docChanged()
  }

  insertFrameHere(): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
    this.pushHistory()
    insertFrame(this.document, this.currentLayerId, this.currentFrame)
    this.docChanged()
  }

  /**
   * Removes the frame at the current frame: keyframes after it shift one
   * frame earlier on every layer and the keyframe at the frame itself is
   * deleted (unless it is a layer's last one). The playhead is clamped to
   * the shortened timeline. Returns true when the timeline changed.
   */
  removeFrameHere(): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked) return false
    this.pushHistory()
    removeFrame(this.document, this.currentFrame)
    this.currentFrame = Math.min(this.currentFrame, Math.max(0, this.duration - 1))
    this.docChanged()
    this.frameChanged()
    return true
  }

  /**
   * Removes this node's keyframe at the current frame: the node then holds
   * its previous pose — or, when this was its last keyframe, leaves the stage
   * after the previous one. Only the node's own keyframe at exactly the
   * current frame is removed. Returns true when content changed.
   */
  removeNodeKeyframe(nodeId: string): boolean {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return false
    if (!this.hasNodeKeyframeAt(this.currentLayerId, nodeId, this.currentFrame)) return false
    this.pushHistory()
    if (!removeNodeFromLayer(layer, this.currentFrame, nodeId)) return false
    this.docChanged()
    return true
  }

  /**
   * Removes the selected object's keyframe at the current frame, so the
   * object holds its previous pose — or leaves the stage when the removed
   * keyframe was its last one. Returns true when content changed.
   */
  removeKeyframeHere(): boolean {
    const primary = this.primarySelectedNodeId
    if (!primary) return false
    return this.removeNodeKeyframe(primary)
  }

  toggleTweenHere(): void {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe) return
    this.pushHistory()
    setKeyframeTween(layer, this.currentFrame, keyframe.tween ? undefined : { easing: 'ease-in-out' })
    this.docChanged()
    this.uiChanged()
  }

  setTweenEasingHere(easing: EasingName): void {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe?.tween) return
    this.pushHistory()
    setKeyframeTween(layer, this.currentFrame, { easing })
    this.docChanged()
  }

  setCurrentLayer(layerId: string): void {
    if (!getLayer(this.document, layerId) || this.currentLayerId === layerId) return
    this.currentLayerId = layerId
    this.autoSwitchTool()
    this.uiChanged()
    this.frameChanged()
  }

  /** Adds a new layer of the given kind at the bottom of the stack and makes
   * it current. */
  addLayerAtBottom(kind: Layer['kind'] = 'object'): void {
    this.pushHistory()
    const layer =
      kind === 'drawing'
        ? addLayerOp(this.document, `Layer ${this.document.layers.length + 1}`, 'bottom', 'drawing')
        : addLayerOp(this.document, `Layer ${this.document.layers.length + 1}`, 'bottom')
    this.currentLayerId = layer.id
    this.autoSwitchTool()
    this.docChanged()
    this.uiChanged()
  }

  /** Removes a layer by id (the last remaining layer is never removed). */
  removeLayer(layerId: string): void {
    if (this.document.layers.length <= 1 || !getLayer(this.document, layerId)) return
    this.pushHistory()
    removeLayerOp(this.document, layerId)
    if (this.currentLayerId === layerId) {
      this.currentLayerId = this.document.layers[0]?.id ?? ''
    }
    this.pruneSelection()
    this.docChanged()
    this.uiChanged()
  }

  removeCurrentLayer(): void {
    this.removeLayer(this.currentLayerId)
  }

  /** Reorders a layer: index 0 is the topmost row of the stack. */
  moveLayer(layerId: string, toIndex: number): void {
    const fromIndex = this.document.layers.findIndex((layer) => layer.id === layerId)
    if (fromIndex === -1) return
    const clamped = Math.min(Math.max(0, toIndex), this.document.layers.length - 1)
    if (clamped === fromIndex) return
    this.pushHistory()
    moveLayerOp(this.document, layerId, clamped)
    this.docChanged()
    this.uiChanged()
  }

  renameLayer(layerId: string, name: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer) return
    this.pushHistory()
    renameLayerOp(this.document, layerId, name)
    this.docChanged()
  }

  /** Deletes a node from every keyframe of its layer. */
  deleteNode(layerId: string, nodeId: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer || !isObjectLayer(layer) || layer.locked) return
    if (!layer.keyframes.some((keyframe) => keyframe.nodes.some((node) => node.id === nodeId))) {
      return
    }
    this.pushHistory()
    removeNodeFromAllKeyframes(layer, nodeId)
    this.selectedNodeIds = this.selectedNodeIds.filter((id) => id !== nodeId)
    this.docChanged()
    this.uiChanged()
  }

  /** Renames a node in every keyframe of its layer. */
  renameNode(layerId: string, nodeId: string, name: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer || !isObjectLayer(layer)) return
    if (!layer.keyframes.some((keyframe) => keyframe.nodes.some((node) => node.id === nodeId))) {
      return
    }
    this.pushHistory()
    renameNodeInLayer(layer, nodeId, name)
    this.docChanged()
  }

  toggleLayerVisibility(layerId: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer) return
    this.pushHistory()
    layer.visible = !layer.visible
    this.docChanged()
    this.uiChanged()
  }

  toggleLayerLock(layerId: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer) return
    this.pushHistory()
    layer.locked = !layer.locked
    this.docChanged()
    this.uiChanged()
  }

  private startLoop(): void {
    const tick = (now: number): void => {
      if (!this.playing) return
      if (this.lastTick !== null) {
        this.accumulator += now - this.lastTick
        const frameMs = 1000 / this.document.fps
        let moved = false
        while (this.accumulator >= frameMs) {
          this.accumulator -= frameMs
          if (this.currentFrame + 1 >= this.duration) {
            if (this.loop) {
              this.currentFrame = 0
              moved = true
            } else {
              this.pause()
              return
            }
          } else {
            this.currentFrame += 1
            moved = true
          }
        }
        if (moved) this.frameChanged()
      }
      this.lastTick = now
      this.rafId = window.requestAnimationFrame(tick)
    }
    this.rafId = window.requestAnimationFrame(tick)
  }
}
