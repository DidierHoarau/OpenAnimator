import {
  addLayer as addLayerOp,
  addShapeToLayer,
  createDocument,
  documentDuration,
  findKeyframeAtFrame,
  getLayer,
  insertBlankKeyframe,
  insertFrame,
  insertKeyframe,
  removeKeyframe,
  removeLayer as removeLayerOp,
  removeShapeFromLayer,
  setKeyframeTween,
  updateShapeInLayer
} from '@shared/document'
import type { EasingName } from '@shared/easing'
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

  private readonly docListeners = new Set<() => void>()
  private readonly frameListeners = new Set<() => void>()
  private readonly uiListeners = new Set<() => void>()
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

  private docChanged(): void {
    for (const listener of this.docListeners) listener()
  }

  private frameChanged(): void {
    for (const listener of this.frameListeners) listener()
  }

  private uiChanged(): void {
    for (const listener of this.uiListeners) listener()
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

  setFrame(frame: number): void {
    const clamped = Math.min(Math.max(0, Math.floor(frame)), Math.max(0, this.duration - 1))
    if (clamped === this.currentFrame) return
    this.currentFrame = clamped
    this.frameChanged()
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

  insertKeyframeHere(): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
    insertKeyframe(layer, this.currentFrame)
    this.docChanged()
  }

  insertBlankKeyframeHere(): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
    insertBlankKeyframe(layer, this.currentFrame)
    this.docChanged()
  }

  insertFrameHere(): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
    insertFrame(layer, this.currentFrame)
    this.docChanged()
  }

  removeKeyframeHere(): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
    if (removeKeyframe(layer, this.currentFrame)) this.docChanged()
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

  addLayerOnTop(): void {
    const layer = addLayerOp(this.document, `Layer ${this.document.layers.length + 1}`)
    this.currentLayerId = layer.id
    this.docChanged()
    this.uiChanged()
  }

  removeCurrentLayer(): void {
    if (removeLayerOp(this.document, this.currentLayerId)) {
      this.currentLayerId = this.document.layers[0]?.id ?? ''
      this.selectedShapeId = null
      this.docChanged()
      this.uiChanged()
    }
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
