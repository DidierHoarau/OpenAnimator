import {
  addLayer as addLayerOp,
  addShapeToLayer,
  createDocument,
  documentDuration,
  findKeyframeAtFrame,
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
import { cloneShape } from '@shared/model'
import type { AnimatorDocument, Layer, Shape } from '@shared/model'

export type Tool = 'select' | 'rect' | 'ellipse'

/**
 * Editor state shared by the stage and timeline views. Owns the current
 * document, playhead, selection, active tool and playback loop, and notifies
 * views through three channels: document changes, frame changes and UI state
 * changes (tool, playback, selection).
 */
export class Editor {
  document: AnimatorDocument
  currentFrame = 0
  currentLayerId: string
  selectedShapeId: string | null = null
  tool: Tool = 'select'
  playing = false
  loop = true
  onionSkin = false
  /** Path of the project file the document was loaded from / saved to. */
  filePath: string | null = null
  dirty = false

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

  setDocument(document: AnimatorDocument): void {
    this.pause()
    this.document = document
    this.currentLayerId = document.layers[0]?.id ?? ''
    this.currentFrame = 0
    this.selectedShapeId = null
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

  selectShape(shapeId: string | null): void {
    if (this.selectedShapeId === shapeId) return
    this.selectedShapeId = shapeId
    this.uiChanged()
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
    this.document.fps = Math.round(fps)
    this.docChanged()
  }

  addShape(shape: Shape): void {
    const layer = this.currentLayer
    if (!layer || layer.locked || !layer.visible) return
    // Auto-key: the new shape gets its own pose at the current frame instead
    // of bleeding into an earlier keyframe's hold; other objects hold through.
    if (!findKeyframeAtFrame(layer, this.currentFrame)) {
      insertBlankKeyframe(layer, this.currentFrame)
    }
    addShapeToLayer(layer, this.currentFrame, shape)
    this.selectedShapeId = shape.id
    this.docChanged()
    this.uiChanged()
  }

  updateSelectedShape(update: (shape: Shape) => void): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked || !this.selectedShapeId) return false
    const updated = updateShapeInLayer(layer, this.currentFrame, this.selectedShapeId, update)
    if (updated) this.docChanged()
    return updated
  }

  nudgeSelected(dx: number, dy: number): void {
    if (!this.selectedShapeId) return
    this.ensureSelectedShapeKeyframe()
    this.updateSelectedShape((shape) => {
      shape.center.x += dx
      shape.center.y += dy
    })
  }

  deleteSelected(): void {
    const layer = this.currentLayer
    if (!layer || layer.locked || !this.selectedShapeId) return
    if (removeShapeFromLayer(layer, this.currentFrame, this.selectedShapeId)) {
      this.selectedShapeId = null
      this.docChanged()
      this.uiChanged()
    }
  }

  /**
   * Adds a keyframe for the selected object at the current frame (F6): only
   * this object gets a pose, every other object keeps holding through.
   * Returns true when a keyframe was created.
   */
  insertKeyframeHere(): boolean {
    if (!this.selectedShapeId) return false
    return this.ensureShapeKeyframe(this.selectedShapeId)
  }

  /**
   * Returns true when the given shape has its own keyframe exactly at the
   * given frame (content merely holding through from an earlier keyframe does
   * not count).
   */
  hasShapeKeyframeAt(layerId: string, shapeId: string, frame: number): boolean {
    const layer = getLayer(this.document, layerId)
    if (!layer) return false
    const keyframe = layer.keyframes.find((kf) => kf.frame === frame)
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
    this.docChanged()
    this.showMessage('New keyframe created')
    return true
  }

  /**
   * Auto-key primitive for edits of the selected shape: guarantees the
   * selected shape has a pose at the current frame. Call before every shape
   * mutation entry point so an edit never targets a keyframe that lacks the
   * shape. Returns true when the document content changed.
   */
  ensureSelectedShapeKeyframe(): boolean {
    return this.selectedShapeId !== null ? this.ensureShapeKeyframe(this.selectedShapeId) : false
  }

  insertFrameHere(): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
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
    if (!this.selectedShapeId) return false
    return this.removeShapeKeyframe(this.selectedShapeId)
  }

  toggleTweenHere(): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe) return
    setKeyframeTween(layer, this.currentFrame, keyframe.tween ? undefined : { easing: 'ease-in-out' })
    this.docChanged()
    this.uiChanged()
  }

  setTweenEasingHere(easing: EasingName): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe?.tween) return
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
    const layer = addLayerOp(this.document, `Layer ${this.document.layers.length + 1}`, 'bottom')
    this.currentLayerId = layer.id
    this.docChanged()
    this.uiChanged()
  }

  /** Removes a layer by id (the last remaining layer is never removed). */
  removeLayer(layerId: string): void {
    if (!removeLayerOp(this.document, layerId)) return
    if (this.currentLayerId === layerId) {
      this.currentLayerId = this.document.layers[0]?.id ?? ''
      this.selectedShapeId = null
    }
    this.docChanged()
    this.uiChanged()
  }

  removeCurrentLayer(): void {
    this.removeLayer(this.currentLayerId)
  }

  /** Reorders a layer: index 0 is the topmost row of the stack. */
  moveLayer(layerId: string, toIndex: number): void {
    if (moveLayerOp(this.document, layerId, toIndex)) {
      this.docChanged()
      this.uiChanged()
    }
  }

  renameLayer(layerId: string, name: string): void {
    if (renameLayerOp(this.document, layerId, name)) this.docChanged()
  }

  /** Deletes a shape from every keyframe of its layer. */
  deleteShape(layerId: string, shapeId: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer || layer.locked) return
    if (removeShapeFromAllKeyframes(layer, shapeId) === 0) return
    if (this.selectedShapeId === shapeId) this.selectedShapeId = null
    this.docChanged()
    this.uiChanged()
  }

  /** Renames a shape in every keyframe of its layer. */
  renameShape(layerId: string, shapeId: string, name: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer) return
    if (renameShapeInLayer(layer, shapeId, name)) this.docChanged()
  }

  toggleLayerVisibility(layerId: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer) return
    layer.visible = !layer.visible
    this.docChanged()
    this.uiChanged()
  }

  toggleLayerLock(layerId: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer) return
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
