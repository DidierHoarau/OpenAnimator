import {
  MAX_PALETTE_COLORS,
  normalizePaletteColors,
  addLayer as addLayerOp,
  addNodeToLayer,
  applyKeyframeChunk,
  cameraLayerOf,
  cellRangeAtFrame,
  cloneDocument,
  createDocument,
  createLayer,
  defaultCameraPose,
  documentDuration,
  evaluateCameraAtFrame,
  evaluateLayerAtFrame,
  findCameraKeyframeAtFrame,
  findCellAtFrame,
  findKeyframeAtFrame,
  findKeyframeIndexForFrame,
  findNearestNodeKeyframeIndex,
  findNextCellFrame,
  findPreviousCellFrame,
  getLayer,
  holdStepOf,
  insertBlankKeyframe,
  insertCameraKeyframe,
  insertCell as insertCellOp,
  insertFrame,
  moveCameraKeyframes as moveCameraKeyframesOp,
  moveCell as moveCellOp,
  moveKeyframeEntries,
  moveLayer as moveLayerOp,
  moveNodeKeyframes,
  removeCameraKeyframe as removeCameraKeyframeOp,
  removeCell as removeCellOp,
  removeFrame,
  removeLayer as removeLayerOp,
  removeNodeFromAllKeyframes,
  removeNodeFromLayer,
  renameLayer as renameLayerOp,
  renameNodeInLayer,
  resolveCellAtFrame,
  setAudioClipStart as setAudioClipStartOp,
  setCellContent as setCellContentOp,
  setCellEnd as setCellEndOp,
  setKeyframeTween,
  updateNodeInLayer
} from '@shared/document'
import { formatHexColor, parseHexColor } from '@shared/color'
import type { CameraKeyframeMove, KeyframeChunkEntry, KeyframeEntryMove } from '@shared/document'
import {
  assetNaturalSize,
  countAssetInstances as countAssetInstancesOp,
  createDocumentAsset,
  duplicateAsset as duplicateAssetOp,
  instanceToGroup,
  symbolContentFromGroup
} from '@shared/assets'
import type { Easing } from '@shared/easing'
import { fitImagePlacement } from '@shared/imagePlacement'
import { nodeBounds } from '@shared/hitTesting'
import type { Rect } from '@shared/hitTesting'
import { groupNaturalSize, groupNodes, ungroupNode } from '@shared/groups'
import type { Vec2 } from '@shared/geometry'
import { cloneNode, isAudioLayer, isCameraLayer, isDrawingLayer, isObjectLayer } from '@shared/model'
import type { AnimatorDocument, Asset, AudioLayer, CameraLayer, CameraPose, DrawingLayer, EmbeddedFont, GroupNode, ImageNode, KeyframeTween, Layer, ObjectLayer, SceneNode, SymbolNode } from '@shared/model'
import { validateAssetGraph } from '@shared/symbols'
import { createId } from '@shared/document'
import { measureLineWidthCanvas } from '@shared/textModel'
import type { MeasureLineWidth } from '@shared/textModel'
import { NOOP_AUDIO } from './audio'
import type { AudioPlaybackBridge } from './audio'
import { createTransparentPng } from './drawing'
import { ResourceCache } from './resourceCache'

export type Tool =
  | 'select'
  | 'hand'
  | 'brush'
  | 'eraser'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'pen'
  | 'text'
  | 'vector'

/**
 * Whether a tool may be active while `layer` is the current layer: the tool
 * availability matrix (Brush/Eraser only on drawing layers, the object tools
 * — including the vector brush, which commits `PathNode`s — only on object
 * layers, Select/Hand on the camera and audio control layers, Hand
 * everywhere).
 */
export function toolCompatibleWithLayer(tool: Tool, layer: Layer | undefined): boolean {
  if (tool === 'hand') return true
  if (!layer) return false
  if (isObjectLayer(layer)) {
    return (
      tool === 'select' ||
      tool === 'rect' ||
      tool === 'ellipse' ||
      tool === 'line' ||
      tool === 'pen' ||
      tool === 'text' ||
      tool === 'vector'
    )
  }
  if (isDrawingLayer(layer)) return tool === 'brush' || tool === 'eraser'
  // Camera and audio layers are control/data layers: inspection tools only.
  return tool === 'select'
}

function clampOnionCount(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(5, Math.max(0, Math.round(value)))
}

/** Structural equality of two easing definitions. */
function easingsEqual(a: Easing, b: Easing): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  return a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2
}

/** Injectable side effects for environments without a DOM (tests). */
export interface EditorDeps {
  /** Encodes a fully transparent PNG of the given pixel size. */
  createTransparentPng?: (width: number, height: number) => Promise<Uint8Array | null>
  /** Stores bytes in the session resource store; returns the resource id. */
  storeResource?: (bytes: Uint8Array) => Promise<string | null>
  /** Measures one text line's width (injectable for DOM-free tests). */
  measureText?: MeasureLineWidth
  /** Audio playback surface; defaults to a silent no-op. */
  audio?: AudioPlaybackBridge
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
  /** Number of previous/next onion ghosts shown (session state, 0–5). */
  onionBefore = 2
  onionAfter = 2
  /** Tint onion ghosts with their before/after colors instead of plain. */
  onionTint = false
  onionTintBefore = '#e05050'
  onionTintAfter = '#4a90d9'
  /** Draw onion ghosts as outlines only (no fills). */
  onionOutline = false
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
  /** Play a short audio blip when seeking while paused (session state). */
  scrubAudio = false
  /** Measures one text line's width for text-node layout (injectable). */
  readonly measureText: MeasureLineWidth
  /** Audio playback surface (no-op unless wired to a real AudioSystem). */
  readonly audio: AudioPlaybackBridge

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
    this.measureText = deps.measureText ?? measureLineWidthCanvas
    this.audio = deps.audio ?? NOOP_AUDIO
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
    this.notifyListeners(this.docListeners)
  }

  private frameChanged(): void {
    this.notifyListeners(this.frameListeners)
  }

  private uiChanged(): void {
    this.notifyListeners(this.uiListeners)
  }

  /**
   * Notifies listeners with per-listener fault isolation: one throwing view
   * must never starve the views registered after it (a single broken render
   * used to freeze the whole application).
   */
  private notifyListeners(listeners: Iterable<() => void>): void {
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        console.error('OpenAnimator: a view failed to handle an update', error)
      }
    }
  }

  /** Surfaces a transient status-bar message (import feedback, hints…). */
  showMessage(message: string): void {
    for (const listener of [...this.messageListeners]) {
      try {
        listener(message)
      } catch (error) {
        console.error('OpenAnimator: a message listener failed', error)
      }
    }
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

  /**
   * Replaces the document's embedded-font list after a reconciliation pass.
   * Housekeeping, not authored content: the list mirrors the text nodes, so
   * no undo entry is pushed.
   */
  applyFontEmbedding(fonts: EmbeddedFont[]): void {
    this.document.fonts = fonts
    this.docChanged()
  }

  /**
   * Re-renders document views without marking the document dirty — used when
   * async side data (registered font faces) became ready after a load.
   */
  refreshDocViews(): void {
    this.notifyListeners(this.docListeners)
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
    // Seeks are the audio latency baseline: during playback the mix re-aligns
    // to the new position; while paused a short blip previews the clip content
    // under the playhead (opt-in session flag).
    if (this.playing) this.audio.sync(this.document, this.currentFrame, this.document.fps)
    else if (this.scrubAudio) this.audio.scrub(this.document, this.currentFrame, this.document.fps)
  }

  /**
   * Moves the playhead within the authored timeline. Seeking past the end
   * clamps to the last frame: extending the document is an explicit edit
   * (+ Frame / F5), never a side effect of a mere click.
   */
  seekToFrame(frame: number): void {
    this.setFrame(Math.max(0, Math.floor(frame)))
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
    this.audio.start(this.document, this.currentFrame, this.document.fps)
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
    this.audio.stop()
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

  /** Enables/disables the paused scrub audio blip (session state). */
  setScrubAudio(enabled: boolean): void {
    if (this.scrubAudio === enabled) return
    this.scrubAudio = enabled
    this.uiChanged()
  }

  toggleScrubAudio(): void {
    this.setScrubAudio(!this.scrubAudio)
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

  /**
   * Replaces the document palette (one history entry when it changes).
   * Entries are normalized to `#rrggbb`, deduplicated and capped; invalid
   * entries are dropped so the scripted and the UI path share one behavior.
   */
  setPalette(colors: string[]): void {
    const next = normalizePaletteColors(colors)
    if (
      next.length === this.document.palette.length &&
      next.every((color, index) => color === this.document.palette[index])
    ) {
      return
    }
    this.pushHistory()
    this.document.palette = next
    this.docChanged()
  }

  /** Appends a color to the document palette (one history entry). */
  addPaletteColor(color: string): void {
    if (this.document.palette.length >= MAX_PALETTE_COLORS) {
      this.showMessage(`Palette is full (${MAX_PALETTE_COLORS} colors)`)
      return
    }
    const rgb = parseHexColor(color)
    if (!rgb) return
    const hex = formatHexColor(rgb)
    if (this.document.palette.includes(hex)) return
    this.pushHistory()
    this.document.palette = [...this.document.palette, hex]
    this.docChanged()
  }

  /** Removes a color from the document palette (one history entry). */
  removePaletteColor(color: string): void {
    const rgb = parseHexColor(color)
    const hex = rgb ? formatHexColor(rgb) : color
    const index = this.document.palette.indexOf(hex)
    if (index === -1) return
    this.pushHistory()
    const next = [...this.document.palette]
    next.splice(index, 1)
    this.document.palette = next
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

  /** Adds a node plus document assets (e.g. symbol assets created by a vector
   * import) in one undo step. */
  addNodeWithAssets(node: SceneNode, assets: Asset[]): void {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked || !layer.visible) return
    this.pushHistory()
    this.insertNode(node)
    this.document.assets.push(...assets)
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
   * Replaces the primary selected node in the keyframe active at the current
   * frame with the node returned by `replace` — one history entry. Keeping
   * the same id preserves the object's span and tween pairing.
   */
  replaceSelectedNode(replace: (node: SceneNode) => SceneNode): boolean {
    const layer = this.currentLayer
    const primary = this.primarySelectedNodeId
    if (!layer || !isObjectLayer(layer) || layer.locked || !primary) return false
    const index = findKeyframeIndexForFrame(layer, this.currentFrame)
    if (index === -1) return false
    const keyframe = layer.keyframes[index]
    const nodeIndex = keyframe.nodes.findIndex((node) => node.id === primary)
    if (nodeIndex === -1) return false
    this.pushHistory()
    keyframe.nodes[nodeIndex] = replace(keyframe.nodes[nodeIndex])
    this.docChanged()
    this.uiChanged()
    return true
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

  /**
   * Sets the cell of a drawing layer at a frame to a registered resource id,
   * creating the cell when needed (scripting surface for frame-by-frame
   * workflows — e.g. duplicating a cell to extend a hold).
   */
  setCell(layerId: string, frame: number, resourceId: string): boolean {
    const layer = getLayer(this.document, layerId)
    if (!layer || !isDrawingLayer(layer) || layer.locked) return false
    if (!Number.isInteger(frame) || frame < 0 || !this.resources.getUrl(resourceId)) return false
    this.pushHistory()
    setCellContentOp(layer, frame, resourceId)
    this.docChanged()
    return true
  }

  /**
   * Moves the cell that covers `fromFrame` so it starts at `toFrame`. The
   * target is clamped to the authored timeline; a cell already at the target
   * is replaced by the moved one. One undo step.
   */
  moveCellToFrame(fromFrame: number, toFrame: number): boolean {
    const layer = this.currentLayer
    if (!layer || !isDrawingLayer(layer) || layer.locked) return false
    if (!Number.isFinite(fromFrame) || !Number.isFinite(toFrame)) return false
    const source = Math.floor(fromFrame)
    const target = Math.min(Math.max(0, Math.floor(toFrame)), Math.max(0, this.duration - 1))
    if (target === source || !findCellAtFrame(layer, source)) return false
    this.pushHistory()
    moveCellOp(layer, source, target)
    this.docChanged()
    this.showMessage(`Cell moved to frame ${target + 1}`)
    return true
  }

  /** Moves a cell by its start frame — the same operation as `moveCellToFrame`. */
  setCellStartFrame(frame: number, newStart: number): boolean {
    return this.moveCellToFrame(frame, newStart)
  }

  /**
   * Sets the visible end of the cell covering `frame`. A followed cell moves
   * to keep the hold contiguous; shrinking the last cell (which otherwise
   * holds to the timeline end) inserts a transparent cell right after the new
   * end. One undo step.
   */
  async setCellEndFrame(frame: number, newEndFrame: number): Promise<boolean> {
    const layer = this.currentLayer
    if (!layer || !isDrawingLayer(layer) || layer.locked) return false
    if (!Number.isFinite(newEndFrame)) return false
    const total = this.duration
    const source = Math.floor(frame)
    const range = cellRangeAtFrame(layer, source, total)
    if (!range) return false
    const end = Math.min(Math.max(Math.floor(newEndFrame), range.cellFrame), Math.max(0, total - 1))
    if (end === range.endFrame) return false
    let blankResourceId: string | undefined
    if (range.lastHolds) {
      const seed = await this.cellSeedResource(layer, false)
      if (!seed) return false
      blankResourceId = seed
    }
    this.pushHistory()
    setCellEndOp(layer, source, end, total, blankResourceId)
    this.docChanged()
    this.showMessage('Cell end frame updated')
    return true
  }

  /**
   * Moves every keyframe of one node so its first keyframe lands on
   * `targetFrame`, preserving the relative timing (a held object moves
   * without stretching). Clamped so the whole span stays on the timeline;
   * a collapsed move is refused with a status message. One undo step.
   */
  moveNodeToFrame(nodeId: string, targetFrame: number): boolean {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return false
    if (!Number.isFinite(targetFrame)) return false
    const frames = layer.keyframes
      .filter((keyframe) => keyframe.nodes.some((node) => node.id === nodeId))
      .map((keyframe) => keyframe.frame)
    if (frames.length === 0) return false
    const first = Math.min(...frames)
    const last = Math.max(...frames)
    const total = this.duration
    const target = Math.min(Math.max(0, Math.floor(targetFrame)), Math.max(0, total - 1))
    const delta = target - first
    if (delta === 0) return false
    const shift = delta > 0 ? Math.min(delta, total - 1 - last) : Math.max(delta, -first)
    if (shift === 0) {
      this.showMessage('The move would leave the timeline')
      return false
    }
    this.pushHistory()
    moveNodeKeyframes(layer, nodeId, shift, total)
    this.docChanged()
    return true
  }

  /**
   * `moveNodeToFrame` for the whole selection: every selected node's span
   * shifts so its first keyframe lands on `targetFrame` (each clamped to the
   * timeline). Exactly one undo step, and none when nothing moves.
   */
  moveSelectedNodesToFrame(targetFrame: number): boolean {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return false
    if (!Number.isFinite(targetFrame)) return false
    const total = this.duration
    const target = Math.min(Math.max(0, Math.floor(targetFrame)), Math.max(0, total - 1))
    const shifts = new Map<string, number>()
    for (const nodeId of this.selectedNodeIds) {
      const frames = layer.keyframes
        .filter((keyframe) => keyframe.nodes.some((node) => node.id === nodeId))
        .map((keyframe) => keyframe.frame)
      if (frames.length === 0) continue
      const first = Math.min(...frames)
      const last = Math.max(...frames)
      const delta = target - first
      if (delta === 0) continue
      const shift = delta > 0 ? Math.min(delta, total - 1 - last) : Math.max(delta, -first)
      if (shift !== 0) shifts.set(nodeId, shift)
    }
    if (shifts.size === 0) return false
    this.pushHistory()
    for (const [nodeId, shift] of shifts) moveNodeKeyframes(layer, nodeId, shift, total)
    this.docChanged()
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
   * Resizes the authored timeline to `frames` frames in one history entry:
   * shorter timelines drop the trailing frames, longer ones append holds.
   * Used by the timeline UI and the scripting command API.
   */
  setDuration(frames: number): boolean {
    const target = Math.max(1, Math.floor(frames))
    if (!Number.isFinite(target) || target === this.duration) return false
    this.pushHistory()
    while (this.duration < target) {
      insertFrame(this.document, this.currentLayerId, this.duration - 1)
    }
    while (this.duration > target) {
      removeFrame(this.document, this.duration - 1)
    }
    this.currentFrame = Math.min(this.currentFrame, this.duration - 1)
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

  /**
   * Replaces the tween easing of the keyframe at the playhead, preserving its
   * motion-path mode. Accepts a named easing or a custom cubic bezier; one
   * undo step, no-op when unchanged.
   */
  setTweenEasingHere(easing: Easing): void {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe?.tween) return
    if (easingsEqual(keyframe.tween.easing, easing)) return
    this.pushHistory()
    const next: KeyframeTween = keyframe.tween.path
      ? { easing, path: keyframe.tween.path }
      : { easing }
    setKeyframeTween(layer, this.currentFrame, next)
    this.docChanged()
  }

  /**
   * Sets the motion-path mode of the tween at the playhead: `'smooth'`
   * evaluates the center along a Catmull-Rom curve through the node's
   * neighbouring keyframe poses; `'linear'` (the default) removes the field
   * so the center lerps straight. One undo step; no-op when unchanged.
   */
  setTweenPathHere(path: 'linear' | 'smooth'): void {
    const layer = this.currentLayer
    if (!layer || !isObjectLayer(layer) || layer.locked) return
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe?.tween) return
    if ((keyframe.tween.path ?? 'linear') === path) return
    this.pushHistory()
    const next: KeyframeTween = { easing: keyframe.tween.easing }
    if (path === 'smooth') next.path = 'smooth'
    setKeyframeTween(layer, this.currentFrame, next)
    this.docChanged()
  }

  /**
   * Moves one node's keyframe entry from `fromFrame` to `toFrame` (the
   * timeline's single-marker drag). Returns true when the entry moved.
   */
  moveNodeKeyframeEntry(
    nodeId: string,
    fromFrame: number,
    toFrame: number,
    layerId = this.currentLayerId
  ): boolean {
    return this.moveNodeKeyframeEntries([{ nodeId, fromFrame, toFrame }], layerId)
  }

  /**
   * Moves a batch of keyframe entries in one undo entry (a multi-marker
   * drag): all entries detach, re-attach at their target frames and merge
   * into keyframes already there. Refuses (with a message) when any target
   * is outside the timeline; returns false when nothing actually moves.
   */
  moveNodeKeyframeEntries(moves: readonly KeyframeEntryMove[], layerId = this.currentLayerId): boolean {
    const layer = getLayer(this.document, layerId)
    if (!layer || !isObjectLayer(layer) || layer.locked || moves.length === 0) return false
    const totalFrames = this.duration
    if (moves.some((move) => move.toFrame < 0 || move.toFrame > totalFrames - 1)) {
      this.showMessage('Move keyframe: the target frame is outside the timeline')
      return false
    }
    const effective = moves.some((move) => {
      if (move.fromFrame === move.toFrame) return false
      const keyframe = findKeyframeAtFrame(layer, move.fromFrame)
      return keyframe !== undefined && keyframe.nodes.some((node) => node.id === move.nodeId)
    })
    if (!effective) return false
    this.pushHistory()
    moveKeyframeEntries(layer, moves, totalFrames)
    this.docChanged()
    return true
  }

  /**
   * Applies a copied keyframe chunk (the clipboard) at `targetFrame` on the
   * given layer: entries land on `targetFrame + offset`, out-of-range entries
   * are skipped, existing keyframes and their nodes survive and an existing
   * tween is never cleared. Does not require the layer to be current. Used by
   * the timeline paste and the script `copyKeyframes` command. One undo step;
   * returns false when nothing lands.
   */
  copyKeyframeChunk(
    layerId: string,
    entries: readonly KeyframeChunkEntry[],
    targetFrame: number
  ): boolean {
    const layer = getLayer(this.document, layerId)
    if (!layer || !isObjectLayer(layer) || layer.locked) return false
    const totalFrames = this.duration
    const lands = entries.some((entry) => {
      const frame = targetFrame + entry.offset
      return frame >= 0 && frame <= totalFrames - 1
    })
    if (!lands) return false
    this.pushHistory()
    applyKeyframeChunk(layer, entries, targetFrame, totalFrames)
    this.docChanged()
    return true
  }

  /**
   * Sets the non-destructive hold step (animation on n's): every frame
   * evaluates at `frame - frame % step`, so `3` plays the document on threes
   * without duplicating anything. `1` turns stepping off (the field is
   * removed). Undoable document state; accepts only integers 1–16.
   */
  setHoldStep(step: number): void {
    if (!Number.isInteger(step) || step < 1 || step > 16) return
    if (this.holdStep === step) return
    this.pushHistory()
    if (step === 1) delete this.document.holdStep
    else this.document.holdStep = step
    this.docChanged()
    this.uiChanged()
  }

  /** Current hold step (1 = off). */
  get holdStep(): number {
    return holdStepOf(this.document)
  }

  /** Updates the session-only onion-skin display options and repaints. */
  setOnionOptions(options: {
    onionBefore?: number
    onionAfter?: number
    onionTint?: boolean
    onionTintBefore?: string
    onionTintAfter?: string
    onionOutline?: boolean
  }): void {
    if (options.onionBefore !== undefined) {
      this.onionBefore = clampOnionCount(options.onionBefore)
    }
    if (options.onionAfter !== undefined) {
      this.onionAfter = clampOnionCount(options.onionAfter)
    }
    if (options.onionTint !== undefined) this.onionTint = options.onionTint
    if (options.onionTintBefore !== undefined) this.onionTintBefore = options.onionTintBefore
    if (options.onionTintAfter !== undefined) this.onionTintAfter = options.onionTintAfter
    if (options.onionOutline !== undefined) this.onionOutline = options.onionOutline
    this.uiChanged()
  }

  setCurrentLayer(layerId: string): void {
    if (!getLayer(this.document, layerId) || this.currentLayerId === layerId) return
    this.currentLayerId = layerId
    this.autoSwitchTool()
    this.uiChanged()
    this.frameChanged()
  }

  /** Adds a new layer of the given kind at the bottom of the stack and makes
   * it current. Camera and audio layers have dedicated flows
   * (`addCameraLayer` / `addAudioLayer`). */
  addLayerAtBottom(kind: 'object' | 'drawing' = 'object'): void {
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
    // The removed layer may have carried the active tool (e.g. Brush on a
    // drawing layer); re-evaluate so the tool always matches the new current
    // layer and stage interactions cannot throw.
    this.autoSwitchTool()
    this.pruneSelection()
    this.docChanged()
    this.uiChanged()
  }

  removeCurrentLayer(): void {
    this.removeLayer(this.currentLayerId)
  }

  /** The document's camera layer, when one exists (at most one per document). */
  get cameraLayer(): CameraLayer | undefined {
    return cameraLayerOf(this.document)
  }

  /** Whether the camera has a keyframe exactly at `frame` (playhead default). */
  hasCameraKeyframeAt(frame: number = this.currentFrame): boolean {
    const layer = this.cameraLayer
    return layer !== undefined && findCameraKeyframeAtFrame(layer, frame) !== undefined
  }

  /**
   * Adds the singleton camera layer — seeded with the default (identity)
   * pose at frame 0 so the framing overlay appears immediately — at the
   * bottom of the stack and makes it current. Returns null (with a message)
   * when a camera layer already exists.
   */
  addCameraLayer(): CameraLayer | null {
    if (this.cameraLayer) {
      this.showMessage('The document already has a camera layer')
      return null
    }
    this.pushHistory()
    const layer = addLayerOp(this.document, 'Camera', 'bottom', 'camera')
    insertCameraKeyframe(this.document, 0, defaultCameraPose(this.document))
    this.currentLayerId = layer.id
    this.autoSwitchTool()
    this.docChanged()
    this.uiChanged()
    return layer
  }

  /**
   * Ensures a camera keyframe at the playhead: it holds the pose evaluated
   * there (hold or tween sample — the default pose when the camera has no
   * keyframes yet). Returns true when a keyframe exists there afterwards.
   * One undo step when one was inserted.
   */
  ensureCameraKeyframe(): boolean {
    const layer = this.cameraLayer
    if (!layer || layer.locked) return false
    if (findCameraKeyframeAtFrame(layer, this.currentFrame)) return true
    this.pushHistory()
    if (!insertCameraKeyframe(this.document, this.currentFrame)) return false
    this.docChanged()
    return true
  }

  /**
   * Sets the camera pose at the playhead, creating the keyframe when the
   * frame has none (auto-key, mirroring node property edits). `patch` updates
   * the given pose fields; zoom is clamped to 0.05–64. One undo step; false
   * when nothing changed.
   */
  setCameraPoseHere(patch: { center?: Vec2; zoom?: number; rotation?: number }): boolean {
    const layer = this.cameraLayer
    if (!layer || layer.locked) return false
    if (patch.center && (!Number.isFinite(patch.center.x) || !Number.isFinite(patch.center.y))) {
      return false
    }
    if (patch.zoom !== undefined && !Number.isFinite(patch.zoom)) return false
    if (patch.rotation !== undefined && !Number.isFinite(patch.rotation)) return false
    const keyframe = findCameraKeyframeAtFrame(layer, this.currentFrame)
    const current =
      keyframe?.pose ??
      evaluateCameraAtFrame(this.document, this.currentFrame) ??
      defaultCameraPose(this.document)
    const next: CameraPose = {
      center: patch.center ?? current.center,
      zoom: patch.zoom === undefined ? current.zoom : Math.min(64, Math.max(0.05, patch.zoom)),
      rotation: patch.rotation ?? current.rotation
    }
    if (
      next.center.x === current.center.x &&
      next.center.y === current.center.y &&
      next.zoom === current.zoom &&
      next.rotation === current.rotation
    ) {
      return false
    }
    this.pushHistory()
    if (keyframe) {
      keyframe.pose = next
    } else {
      insertCameraKeyframe(this.document, this.currentFrame, next)
    }
    this.docChanged()
    return true
  }

  /** Removes the camera keyframe exactly at the playhead. One undo step;
   * false when there is none. */
  removeCameraKeyframeHere(): boolean {
    const layer = this.cameraLayer
    if (!layer || layer.locked) return false
    if (!findCameraKeyframeAtFrame(layer, this.currentFrame)) return false
    this.pushHistory()
    if (!removeCameraKeyframeOp(this.document, this.currentFrame)) return false
    this.docChanged()
    return true
  }

  /** Toggles the tween of the camera keyframe at the playhead. */
  toggleCameraTweenHere(): void {
    const layer = this.cameraLayer
    if (!layer || layer.locked) return
    const keyframe = findCameraKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe) return
    this.pushHistory()
    keyframe.tween = keyframe.tween ? undefined : { easing: 'ease-in-out' }
    this.docChanged()
  }

  /** Replaces the tween of the camera keyframe at the playhead (`null`
   * removes it). One undo step; no-op when unchanged. */
  setCameraTweenHere(tween: KeyframeTween | null): void {
    const layer = this.cameraLayer
    if (!layer || layer.locked) return
    const keyframe = findCameraKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe) return
    const current = keyframe.tween
    if (tween === null) {
      if (!current) return
    } else if (
      current &&
      easingsEqual(current.easing, tween.easing) &&
      (current.path ?? 'linear') === (tween.path ?? 'linear')
    ) {
      return
    }
    this.pushHistory()
    keyframe.tween = tween ? structuredClone(tween) : undefined
    this.docChanged()
  }

  /** Replaces the tween easing of the camera keyframe at the playhead,
   * preserving its motion-path mode. One undo step; no-op when unchanged. */
  setCameraTweenEasingHere(easing: Easing): void {
    const layer = this.cameraLayer
    if (!layer || layer.locked) return
    const keyframe = findCameraKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe?.tween) return
    if (easingsEqual(keyframe.tween.easing, easing)) return
    this.pushHistory()
    const next: KeyframeTween = keyframe.tween.path
      ? { easing, path: keyframe.tween.path }
      : { easing }
    keyframe.tween = next
    this.docChanged()
  }

  /** Sets the motion-path mode of the camera tween at the playhead
   * (`'smooth'` samples the center along a Catmull-Rom curve through the
   * neighbouring poses; `'linear'` removes the field). One undo step. */
  setCameraTweenPathHere(path: 'linear' | 'smooth'): void {
    const layer = this.cameraLayer
    if (!layer || layer.locked) return
    const keyframe = findCameraKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe?.tween) return
    if ((keyframe.tween.path ?? 'linear') === path) return
    this.pushHistory()
    const next: KeyframeTween = { easing: keyframe.tween.easing }
    if (path === 'smooth') next.path = 'smooth'
    keyframe.tween = next
    this.docChanged()
  }

  /** Moves one camera keyframe entry from `fromFrame` to `toFrame` (the
   * timeline's single-marker drag). */
  moveCameraKeyframeEntry(
    fromFrame: number,
    toFrame: number,
    layerId: string = this.currentLayerId
  ): boolean {
    return this.moveCameraKeyframes([{ fromFrame, toFrame }], layerId)
  }

  /**
   * Moves camera keyframes in one undo step (a multi-marker drag); moved
   * keyframes replace any already at their target. Targets outside the
   * timeline are refused with a message; false when nothing actually moves.
   */
  moveCameraKeyframes(
    moves: readonly CameraKeyframeMove[],
    layerId: string = this.currentLayerId
  ): boolean {
    const layer = getLayer(this.document, layerId)
    if (!layer || !isCameraLayer(layer) || layer.locked || moves.length === 0) return false
    const totalFrames = this.duration
    if (moves.some((move) => move.toFrame < 0 || move.toFrame > totalFrames - 1)) {
      this.showMessage('Move keyframe: the target frame is outside the timeline')
      return false
    }
    const effective = moves.some(
      (move) =>
        move.fromFrame !== move.toFrame &&
        findCameraKeyframeAtFrame(layer, move.fromFrame) !== undefined
    )
    if (!effective) return false
    this.pushHistory()
    moveCameraKeyframesOp(layer, moves, totalFrames)
    this.docChanged()
    return true
  }

  /**
   * Adds an audio layer playing `resourceId` (a registered audio resource of
   * this session) at the bottom of the stack, makes it current and returns
   * it. Returns null (with a status message) when the resource is unknown.
   */
  addAudioLayer(resourceId: string, name: string, startFrame = 0): AudioLayer | null {
    if (!resourceId || !this.resources.getBlob(resourceId)) {
      this.showMessage('Audio resource is not available in this session')
      return null
    }
    this.pushHistory()
    const layer = addLayerOp(this.document, name || 'Audio', 'bottom', 'audio', resourceId)
    layer.startFrame = Number.isFinite(startFrame) ? Math.max(0, Math.round(startFrame)) : 0
    this.currentLayerId = layer.id
    this.autoSwitchTool()
    this.docChanged()
    this.uiChanged()
    return layer
  }

  /** Sets the volume (0..1) of an audio layer. One undo step. */
  setAudioLayerVolume(layerId: string, volume: number): void {
    const layer = getLayer(this.document, layerId)
    if (!layer || !isAudioLayer(layer) || layer.locked || !Number.isFinite(volume)) return
    const next = Math.min(1, Math.max(0, volume))
    if (next === layer.volume) return
    this.pushHistory()
    layer.volume = next
    this.docChanged()
    this.uiChanged()
  }

  /** Mutes/unmutes an audio layer. Audio mute is the layer's `visible` flag,
   * like every other layer kind, so hidden audio is skipped by both playback
   * and exports. One undo step. */
  toggleAudioMute(layerId: string): void {
    this.toggleLayerVisibility(layerId)
  }

  /** Moves an audio clip's start frame (clamped to the timeline start, it
   * may extend past the end). One undo step; false when the clip did not
   * move. */
  setAudioClipStart(layerId: string, startFrame: number): boolean {
    const layer = getLayer(this.document, layerId)
    if (!layer || !isAudioLayer(layer) || layer.locked || !Number.isFinite(startFrame)) {
      return false
    }
    const clamped = Math.max(0, Math.round(startFrame))
    if (clamped === layer.startFrame) return false
    this.pushHistory()
    setAudioClipStartOp(layer, startFrame)
    this.docChanged()
    return true
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
              // The audio mix never loops on its own: re-align it to frame 0.
              this.audio.sync(this.document, 0, this.document.fps)
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
