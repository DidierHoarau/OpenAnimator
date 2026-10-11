import {
  addLayer as addLayerOp,
  addShapeToLayer,
  cloneDocument,
  createDocument,
  documentDuration,
  evaluateLayerAtFrame,
  findKeyframeAtFrame,
  findKeyframeIndexForFrame,
  findNearestShapeKeyframeIndex,
  getLayer,
  insertBlankKeyframe,
  insertFrame,
  moveLayer as moveLayerOp,
  removeFrame,
  removeLayer as removeLayerOp,
  removeShapeFromAllKeyframes,
  removeShapeFromLayer,
  renameLayer as renameLayerOp,
  renameShapeInLayer,
  setKeyframeTween,
  updateShapeInLayer
} from '@shared/document'
import type { EasingName } from '@shared/easing'
import { shapeBounds } from '@shared/hitTesting'
import type { Rect } from '@shared/hitTesting'
import { cloneShape } from '@shared/model'
import type { AnimatorDocument, Layer, Shape } from '@shared/model'

export type Tool = 'select' | 'rect' | 'ellipse' | 'hand'

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
  currentFrame = 0
  currentLayerId: string
  /** Selected shape ids in click order; the last one is the primary selection. */
  selectedShapeIds: string[] = []
  tool: Tool = 'select'
  playing = false
  loop = true
  onionSkin = false
  /** Path of the project file the document was loaded from / saved to. */
  filePath: string | null = null
  dirty = false

  private readonly undoStack: AnimatorDocument[] = []
  private readonly redoStack: AnimatorDocument[] = []
  /** Depth of the coalesced interaction currently open (drags push once). */
  private interactionDepth = 0

  private readonly docListeners = new Set<() => void>()
  private readonly frameListeners = new Set<() => void>()
  private readonly uiListeners = new Set<() => void>()
  private readonly messageListeners = new Set<(message: string) => void>()
  private rafId: number | null = null
  private lastTick: number | null = null
  private accumulator = 0

  constructor(document: AnimatorDocument) {
    this.document = document
    this.currentLayerId = document.layers[0]?.id ?? ''
  }

  get duration(): number {
    return documentDuration(this.document)
  }

  get currentLayer(): Layer | undefined {
    return getLayer(this.document, this.currentLayerId)
  }

  /** The most recently selected shape (drives the properties panel). */
  get primarySelectedShapeId(): string | null {
    return this.selectedShapeIds.length > 0
      ? this.selectedShapeIds[this.selectedShapeIds.length - 1]
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

  private showMessage(message: string): void {
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
    this.pruneSelection()
    this.docChanged()
    if (frameMoved) this.frameChanged()
    this.uiChanged()
    this.showMessage(message)
  }

  setDocument(document: AnimatorDocument): void {
    this.pause()
    this.document = document
    this.currentLayerId = document.layers[0]?.id ?? ''
    this.currentFrame = 0
    this.selectedShapeIds = []
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.interactionDepth = 0
    this.docChanged()
    this.uiChanged()
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
    this.tool = tool
    this.uiChanged()
  }

  /**
   * Replaces or updates the selection set. `replace` selects exactly `ids`,
   * `add` merges them into the selection and `toggle` flips the membership of
   * every id (shift-click and shift-marquee semantics).
   */
  selectShapes(ids: string[], mode: SelectionMode): void {
    let next: string[]
    if (mode === 'replace') {
      next = [...ids]
    } else if (mode === 'add') {
      const merged = new Set(this.selectedShapeIds)
      for (const id of ids) merged.add(id)
      next = [...merged]
    } else {
      const merged = new Set(this.selectedShapeIds)
      for (const id of ids) {
        if (merged.has(id)) merged.delete(id)
        else merged.add(id)
      }
      next = [...merged]
    }
    if (
      next.length === this.selectedShapeIds.length &&
      next.every((id, index) => id === this.selectedShapeIds[index])
    ) {
      return
    }
    this.selectedShapeIds = next
    this.uiChanged()
  }

  /** Drops selection ids that no longer exist anywhere in the document. */
  private pruneSelection(): void {
    if (this.selectedShapeIds.length === 0) return
    const present = new Set<string>()
    for (const layer of this.document.layers) {
      for (const keyframe of layer.keyframes) {
        for (const shape of keyframe.shapes) present.add(shape.id)
      }
    }
    this.selectedShapeIds = this.selectedShapeIds.filter((id) => present.has(id))
  }

  /** Union of the rotation-aware bounds of the evaluated selected shapes. */
  getSelectionBounds(): Rect | null {
    const layer = this.currentLayer
    if (!layer) return null
    let bounds: Rect | null = null
    for (const shape of evaluateLayerAtFrame(layer, this.currentFrame)) {
      if (!this.selectedShapeIds.includes(shape.id)) continue
      const box = shapeBounds(shape)
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

  addShape(shape: Shape): void {
    const layer = this.currentLayer
    if (!layer || layer.locked || !layer.visible) return
    this.pushHistory()
    // Auto-key: the new shape gets its own pose at the current frame instead
    // of bleeding into an earlier keyframe's hold; other objects hold through.
    if (!findKeyframeAtFrame(layer, this.currentFrame)) {
      insertBlankKeyframe(layer, this.currentFrame)
    }
    addShapeToLayer(layer, this.currentFrame, shape)
    this.selectedShapeIds = [shape.id]
    this.docChanged()
    this.uiChanged()
  }

  /** Updates the primary selected shape, auto-keying it first. One history entry. */
  updateSelectedShape(update: (shape: Shape) => void): boolean {
    const primary = this.primarySelectedShapeId
    if (!primary) return false
    return this.updateShapesById([primary], update)
  }

  /**
   * Updates every selected shape of the current layer, auto-keying each one
   * first (object-level keyframes; other objects hold through). One history
   * entry for the whole set.
   */
  updateSelectedShapes(update: (shape: Shape) => void): boolean {
    return this.updateShapesById(this.selectedShapeIds, update)
  }

  private updateShapesById(ids: string[], update: (shape: Shape) => void): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked) return false
    const keyable = ids.filter(
      (id) => findNearestShapeKeyframeIndex(layer, id, this.currentFrame) !== -1
    )
    if (keyable.length === 0) return false
    this.pushHistory()
    let changed = false
    for (const id of keyable) {
      if (this.ensureShapeKeyframeMutation(layer, id)) changed = true
      if (updateShapeInLayer(layer, this.currentFrame, id, update)) changed = true
    }
    if (changed) this.docChanged()
    return changed
  }

  nudgeSelected(dx: number, dy: number): void {
    this.updateSelectedShapes((shape) => {
      shape.center.x += dx
      shape.center.y += dy
    })
  }

  /** Deletes every selected shape of the current layer at the current frame. */
  deleteSelected(): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
    const removable = this.selectedShapeIds.filter((id) =>
      this.isShapeInActiveKeyframe(layer, id)
    )
    if (removable.length === 0) return
    this.pushHistory()
    let removed = false
    for (const id of removable) {
      if (removeShapeFromLayer(layer, this.currentFrame, id)) removed = true
    }
    if (removed) {
      this.pruneSelection()
      this.docChanged()
      this.uiChanged()
    }
  }

  private isShapeInActiveKeyframe(layer: Layer, shapeId: string): boolean {
    const index = findKeyframeIndexForFrame(layer, this.currentFrame)
    return (
      index !== -1 && layer.keyframes[index].shapes.some((shape) => shape.id === shapeId)
    )
  }

  /**
   * Adds a keyframe for every selected object at the current frame (F6): only
   * the selected objects get a pose, every other object keeps holding through.
   * Returns true when a keyframe was created.
   */
  insertKeyframeHere(): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked) return false
    const ids = this.selectedShapeIds.filter(
      (id) => findNearestShapeKeyframeIndex(layer, id, this.currentFrame) !== -1
    )
    if (ids.length === 0) return false
    this.pushHistory()
    let created = false
    for (const id of ids) {
      if (this.ensureShapeKeyframeMutation(layer, id)) created = true
    }
    if (created) {
      this.docChanged()
      this.showMessage('New keyframe created')
    }
    return created
  }

  /**
   * Returns true when the given shape has its own keyframe exactly at the
   * given frame (content merely holding through from an earlier keyframe does
   * not count).
   */
  hasShapeKeyframeAt(layerId: string, shapeId: string, frame: number): boolean {
    const layer = getLayer(this.document, layerId)
    if (!layer) return false
    const keyframe = layer.keyframes.find((keyframe) => keyframe.frame === frame)
    return keyframe?.shapes.some((s) => s.id === shapeId) ?? false
  }

  /**
   * Ensures the shape has its own pose at the current frame: creates the
   * keyframe when missing — object-level, holding only this shape, so every
   * other object keeps holding through — and copies the shape in from its
   * nearest keyframe when the keyframe lacks it.
   * Returns true when the document content changed.
   */
  ensureShapeKeyframe(shapeId: string): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked) return false
    if (!this.canKeyShape(layer, shapeId)) return false
    this.pushHistory()
    if (!this.ensureShapeKeyframeMutation(layer, shapeId)) return false
    this.docChanged()
    this.showMessage('New keyframe created')
    return true
  }

  /**
   * Auto-key primitive for edits of the selection: guarantees every selected
   * shape has a pose at the current frame. Pushes history unless inside a
   * coalesced interaction. Returns true when the document content changed.
   */
  ensureSelectedShapesKeyframes(): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked) return false
    const ids = this.selectedShapeIds.filter((id) => this.canKeyShape(layer, id))
    if (ids.length === 0) return false
    this.pushHistory()
    let changed = false
    for (const id of ids) {
      if (this.ensureShapeKeyframeMutation(layer, id)) changed = true
    }
    if (changed) this.docChanged()
    return changed
  }

  private canKeyShape(layer: Layer, shapeId: string): boolean {
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (keyframe?.shapes.some((s) => s.id === shapeId)) return false
    return findNearestShapeKeyframeIndex(layer, shapeId, this.currentFrame) !== -1
  }

  private ensureShapeKeyframeMutation(layer: Layer, shapeId: string): boolean {
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (keyframe?.shapes.some((s) => s.id === shapeId)) return false
    const sourceIndex = findNearestShapeKeyframeIndex(layer, shapeId, this.currentFrame)
    const sourceShape =
      sourceIndex === -1
        ? undefined
        : layer.keyframes[sourceIndex].shapes.find((s) => s.id === shapeId)
    if (!sourceShape) return false
    const target = keyframe ?? insertBlankKeyframe(layer, this.currentFrame)
    if (!target) return false
    target.shapes.push(cloneShape(sourceShape))
    return true
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
   * Removes this shape's keyframe at the current frame: the shape then holds
   * its previous pose — or, when this was its last keyframe, leaves the stage
   * after the previous one. Only the shape's own keyframe at exactly the
   * current frame is removed. Returns true when content changed.
   */
  removeShapeKeyframe(shapeId: string): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked) return false
    if (!this.hasShapeKeyframeAt(this.currentLayerId, shapeId, this.currentFrame)) return false
    this.pushHistory()
    if (!removeShapeFromLayer(layer, this.currentFrame, shapeId)) return false
    this.docChanged()
    return true
  }

  /**
   * Removes the selected object's keyframe at the current frame, so the
   * object holds its previous pose — or leaves the stage when the removed
   * keyframe was its last one. Returns true when content changed.
   */
  removeKeyframeHere(): boolean {
    const primary = this.primarySelectedShapeId
    if (!primary) return false
    return this.removeShapeKeyframe(primary)
  }

  toggleTweenHere(): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe) return
    this.pushHistory()
    setKeyframeTween(layer, this.currentFrame, keyframe.tween ? undefined : { easing: 'ease-in-out' })
    this.docChanged()
    this.uiChanged()
  }

  setTweenEasingHere(easing: EasingName): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe?.tween) return
    this.pushHistory()
    setKeyframeTween(layer, this.currentFrame, { easing })
    this.docChanged()
  }

  setCurrentLayer(layerId: string): void {
    if (!getLayer(this.document, layerId) || this.currentLayerId === layerId) return
    this.currentLayerId = layerId
    this.uiChanged()
    this.frameChanged()
  }

  /** Adds a new layer at the bottom of the stack and makes it current. */
  addLayerAtBottom(): void {
    this.pushHistory()
    const layer = addLayerOp(this.document, `Layer ${this.document.layers.length + 1}`, 'bottom')
    this.currentLayerId = layer.id
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

  /** Deletes a shape from every keyframe of its layer. */
  deleteShape(layerId: string, shapeId: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer || layer.locked) return
    if (
      !layer.keyframes.some((keyframe) =>
        keyframe.shapes.some((shape) => shape.id === shapeId)
      )
    ) {
      return
    }
    this.pushHistory()
    removeShapeFromAllKeyframes(layer, shapeId)
    this.selectedShapeIds = this.selectedShapeIds.filter((id) => id !== shapeId)
    this.docChanged()
    this.uiChanged()
  }

  /** Renames a shape in every keyframe of its layer. */
  renameShape(layerId: string, shapeId: string, name: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer) return
    if (
      !layer.keyframes.some((keyframe) =>
        keyframe.shapes.some((shape) => shape.id === shapeId)
      )
    ) {
      return
    }
    this.pushHistory()
    renameShapeInLayer(layer, shapeId, name)
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
