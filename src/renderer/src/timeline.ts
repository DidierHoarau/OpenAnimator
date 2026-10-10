import {
  findKeyframeAtFrame,
  findNearestShapeKeyframeIndex,
  getLayer
} from '@shared/document'
import type { Layer, Shape } from '@shared/model'

import type { Editor } from './editor'
import { el } from './dom'

const FRAME_WIDTH = 14
const HEAD_WIDTH = 180
const MIN_FRAMES = 40
const ROW_HEIGHT = 28
const SHAPE_KIND_LABELS: Record<string, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse'
}

/** Row targeted by the context menu: a layer row or one of its object rows. */
interface MenuTarget {
  layerId: string
  shapeId: string | null
}

/**
 * Bottom panel: a unified timeline with an integrated layer tree on the left
 * and the frame grid on the right.
 *
 * The top controls hold playback (moved out of the right panel) and frame
 * add/remove. Layers render as expandable rows; when expanded, each shape of
 * the layer (collected across all keyframes) gets its own child row carrying
 * its frame-span bar, its own keyframe markers and tween spans, a frame-range
 * label, a per-object keyframe button (◇ add / × delete) and a tween toggle.
 * Keyframes and tweens are drawn at the object level only; layer rows are
 * plain seekable tracks. The end of the list always offers an add-layer line;
 * right-click renames or deletes a layer/object and layer rows can be
 * reordered with drag and drop.
 *
 * Layout invariant: every row owns a track exactly one row tall, so keyframe
 * markers, tween spans and shape bars always stay aligned with their own row;
 * only the playhead spans the grid.
 */
export class TimelineView {
  private readonly content: HTMLDivElement
  private readonly rowsHost: HTMLDivElement
  private readonly playhead: HTMLDivElement
  private readonly frameLabel: HTMLSpanElement
  private readonly playButton: HTMLButtonElement
  private readonly loopButton: HTMLButtonElement
  private readonly fpsInput: HTMLInputElement
  private readonly menu: HTMLDivElement
  private readonly menuRenameButton: HTMLButtonElement
  private readonly menuDeleteButton: HTMLButtonElement
  private readonly expandedLayers = new Set<string>()
  private shapeKeyframeButtons: HTMLButtonElement[] = []
  private shapeTweenButtons: HTMLButtonElement[] = []
  private menuTarget: MenuTarget | null = null
  private draggedLayerId: string | null = null

  constructor(
    private readonly editor: Editor,
    container: HTMLElement
  ) {
    // Top controls: playback and frame operations.
    const controls = el('div', 'tl-controls')
    const playbackGroup = el('div', 'tl-group')
    this.playButton = el('button', undefined, 'Play')
    this.playButton.title = 'Play or pause playback (Space)'
    this.playButton.addEventListener('click', () => editor.togglePlay())
    const stopButton = el('button', undefined, 'Stop')
    stopButton.title = 'Stop playback and return to frame 1 (Escape)'
    stopButton.addEventListener('click', () => editor.stopPlayback())
    this.loopButton = el('button', undefined, 'Loop')
    this.loopButton.title = 'Toggle looped playback'
    this.loopButton.addEventListener('click', () => editor.toggleLoop())
    playbackGroup.append(this.playButton, stopButton, this.loopButton)

    const fpsGroup = el('div', 'tl-group')
    fpsGroup.appendChild(el('span', 'tl-label', 'fps'))
    this.fpsInput = el('input', 'tl-number') as HTMLInputElement
    this.fpsInput.type = 'number'
    this.fpsInput.min = '1'
    this.fpsInput.max = '120'
    this.fpsInput.title = 'Frames per second'
    this.fpsInput.addEventListener('change', () => editor.setFps(Number(this.fpsInput.value)))
    fpsGroup.appendChild(this.fpsInput)

    const frameGroup = el('div', 'tl-group')
    const addFrameButton = el('button', undefined, '+ Frame')
    addFrameButton.title = 'Insert frame to extend the hold (F5)'
    addFrameButton.addEventListener('click', () => editor.insertFrameHere())
    const removeFrameButton = el('button', undefined, '− Frame')
    removeFrameButton.title = 'Remove the frame at the playhead'
    removeFrameButton.addEventListener('click', () => editor.removeFrameHere())
    frameGroup.append(addFrameButton, removeFrameButton)

    this.frameLabel = el('span', 'tl-frame-label')
    controls.append(playbackGroup, fpsGroup, frameGroup, this.frameLabel)

    // Context menu shared by every layer and object row.
    this.menu = el('div', 'tl-context-menu hidden')
    this.menuRenameButton = el('button', 'tl-context-item', 'Rename')
    this.menuDeleteButton = el('button', 'tl-context-item tl-context-danger', 'Delete')
    this.menuRenameButton.addEventListener('click', () => {
      const target = this.menuTarget
      this.closeContextMenu()
      if (target) this.startRename(target)
    })
    this.menuDeleteButton.addEventListener('click', () => {
      const target = this.menuTarget
      this.closeContextMenu()
      if (target) this.deleteTarget(target)
    })
    this.menu.append(this.menuRenameButton, this.menuDeleteButton)
    window.addEventListener('pointerdown', (event) => {
      if (this.menu.classList.contains('hidden')) return
      if (event.target instanceof Node && this.menu.contains(event.target)) return
      this.closeContextMenu()
    })
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeContextMenu()
    })

    const ruler = el('div', 'tl-ruler')
    this.rowsHost = el('div', 'tl-rows')
    this.playhead = el('div', 'tl-playhead')
    this.content = el('div', 'tl-content')
    this.content.append(ruler, this.rowsHost, this.playhead)

    const scroll = el('div', 'tl-scroll')
    scroll.appendChild(this.content)
    scroll.addEventListener('pointerdown', (event) => this.onTrackPointerDown(event))

    container.append(controls, scroll, this.menu)

    editor.onDocChange(() => this.render())
    editor.onFrameChange(() => {
      this.updatePlayhead()
      this.refreshShapeKeyframeButtons()
      this.refreshShapeTweenButtons()
    })
    editor.onUiChange(() => this.render())
    this.render()
  }

  private onTrackPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement
    // An inline rename field must survive selection changes.
    if (target instanceof HTMLInputElement) return
    const frameAttr = target.dataset?.frame
    if (frameAttr !== undefined) {
      this.editor.seekToFrame(Number(frameAttr))
      return
    }
    const shapeRow = target.closest<HTMLElement>('.tl-shape-row')
    if (shapeRow?.dataset.shapeId) {
      this.editor.setCurrentLayer(shapeRow.dataset.layerId!)
      this.editor.selectShape(shapeRow.dataset.shapeId)
      return
    }
    const row = target.closest<HTMLElement>('.tl-row')
    if (row?.dataset.layerId) {
      this.editor.setCurrentLayer(row.dataset.layerId)
    }
  }

  render(): void {
    const editor = this.editor
    const doc = editor.document
    const frames = Math.max(editor.duration, MIN_FRAMES)
    this.content.style.setProperty('--frame-width', `${FRAME_WIDTH}px`)
    this.content.style.width = `${HEAD_WIDTH + frames * FRAME_WIDTH}px`

    // Frame ruler: numbers every 5 frames.
    const ruler = this.content.querySelector<HTMLElement>('.tl-ruler')
    if (ruler) {
      ruler.textContent = ''
      for (let frame = 0; frame < frames; frame += 5) {
        const label = el('span', 'tl-num', String(frame + 1))
        label.style.left = `${HEAD_WIDTH + frame * FRAME_WIDTH + 2}px`
        ruler.appendChild(label)
      }
    }

    this.shapeKeyframeButtons = []
    this.shapeTweenButtons = []
    this.rowsHost.textContent = ''
    for (const layer of doc.layers) {
      this.rowsHost.appendChild(this.buildLayerGroup(layer, frames))
    }
    // The layer list always ends with a line to append a layer.
    this.rowsHost.appendChild(this.buildAddLayerRow())

    // Playback state lives on the top controls now.
    this.playButton.textContent = editor.playing ? 'Pause' : 'Play'
    this.loopButton.classList.toggle('active', editor.loop)
    if (document.activeElement !== this.fpsInput) this.fpsInput.value = String(doc.fps)

    this.refreshShapeKeyframeButtons()
    this.refreshShapeTweenButtons()
    this.updatePlayhead()
  }

  /** A layer row, followed by one child row per shape when expanded. */
  private buildLayerGroup(layer: Layer, frames: number): HTMLDivElement {
    const group = el('div', 'tl-layer-group')
    const expanded = this.expandedLayers.has(layer.id)

    group.appendChild(this.buildLayerRow(layer, expanded, frames))

    // Shape child rows, rendered only while the layer is expanded.
    if (expanded) {
      const shapes = this.collectAllShapes(layer)
      if (shapes.length === 0) {
        group.appendChild(this.buildEmptyShapeRow(frames))
      } else {
        for (const shape of shapes) {
          group.appendChild(this.buildShapeRow(layer, shape, frames))
        }
      }
    }

    return group
  }

  private buildLayerRow(layer: Layer, expanded: boolean, frames: number): HTMLDivElement {
    const editor = this.editor
    const row = el('div', 'tl-row')
    row.dataset.layerId = layer.id
    if (layer.id === editor.currentLayerId) row.classList.add('current')

    const head = el('div', 'tl-head')
    const toggle = el('span', 'tl-toggle', expanded ? '▾' : '▸')
    toggle.title = expanded ? 'Collapse layer' : 'Expand layer'
    toggle.addEventListener('click', (event) => {
      event.stopPropagation()
      this.toggleExpand(layer.id)
    })
    const visibilityButton = el('button', 'tl-icon', layer.visible ? '◉' : '○')
    visibilityButton.title = layer.visible ? 'Hide layer' : 'Show layer'
    visibilityButton.addEventListener('click', (event) => {
      event.stopPropagation()
      editor.toggleLayerVisibility(layer.id)
    })
    const name = el('span', 'name', layer.name)
    name.title = layer.name
    const lockButton = el('button', 'tl-icon', layer.locked ? 'L' : '·')
    lockButton.title = layer.locked ? 'Unlock layer' : 'Lock layer'
    lockButton.addEventListener('click', (event) => {
      event.stopPropagation()
      editor.toggleLayerLock(layer.id)
    })
    lockButton.classList.toggle('active', layer.locked)
    head.append(toggle, visibilityButton, name, lockButton)
    head.addEventListener('click', (event) => {
      if (event.target instanceof HTMLInputElement) return
      editor.setCurrentLayer(layer.id)
    })
    row.appendChild(head)

    // Right-click: rename or delete the layer.
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.openContextMenu({ layerId: layer.id, shapeId: null }, event)
    })

    // Drag and drop reorders layers (index 0 = top of the stack).
    row.draggable = true
    row.addEventListener('dragstart', (event) => {
      this.draggedLayerId = layer.id
      if (event.dataTransfer) {
        event.dataTransfer.setData('text/plain', layer.id)
        event.dataTransfer.effectAllowed = 'move'
      }
      row.classList.add('dragging')
    })
    row.addEventListener('dragover', (event) => {
      if (!this.draggedLayerId || this.draggedLayerId === layer.id) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      const below = this.isPointerBelowRow(event, row)
      row.classList.toggle('drop-before', !below)
      row.classList.toggle('drop-after', below)
    })
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'))
    row.addEventListener('drop', (event) => {
      event.preventDefault()
      const draggedId = this.draggedLayerId
      const below = this.isPointerBelowRow(event, row)
      this.clearDragState()
      if (!draggedId || draggedId === layer.id) return
      const doc = this.editor.document
      const fromIndex = doc.layers.findIndex((candidate) => candidate.id === draggedId)
      const targetIndex = doc.layers.findIndex((candidate) => candidate.id === layer.id)
      if (fromIndex === -1 || targetIndex === -1) return
      let to = targetIndex + (below ? 1 : 0)
      if (fromIndex < to) to -= 1
      if (to !== fromIndex) this.editor.moveLayer(draggedId, to)
    })
    row.addEventListener('dragend', () => this.clearDragState())

    row.appendChild(this.buildBarTrack(null, null, frames))
    return row
  }

  /** Permanent line at the end of the layer list to append a layer. */
  private buildAddLayerRow(): HTMLDivElement {
    const row = el('div', 'tl-add-layer', '+ Add layer')
    row.title = 'Add a layer at the bottom of the stack'
    row.addEventListener('click', () => this.editor.addLayerAtBottom())
    return row
  }

  private buildEmptyShapeRow(frames: number): HTMLDivElement {
    const row = el('div', 'tl-row tl-shape-row')
    const head = el('div', 'tl-head')
    const label = el('span', 'name', 'no shapes on this layer')
    label.style.fontStyle = 'italic'
    label.style.color = 'var(--muted)'
    head.appendChild(label)
    row.appendChild(head)
    row.appendChild(this.buildBarTrack(null, null, frames))
    return row
  }

  private buildShapeRow(layer: Layer, shape: Shape, frames: number): HTMLDivElement {
    const editor = this.editor
    const row = el('div', 'tl-row tl-shape-row')
    row.dataset.layerId = layer.id
    row.dataset.shapeId = shape.id
    if (editor.selectedShapeId === shape.id) row.classList.add('selected')

    const head = el('div', 'tl-head')
    const swatch = el('span', 'tl-swatch')
    swatch.style.background = shape.fill
    const label = el('span', 'name', shape.name || SHAPE_KIND_LABELS[shape.kind] || 'Object')
    label.title = label.textContent ?? ''
    const span = this.getShapeFrameSpan(layer, shape.id)
    const kfLabel = el('span', 'tl-kf-label', span ? `${span.start + 1}\u2013${span.end}` : '')

    // Tween toggle: only meaningful when this object owns the keyframe at the
    // current frame and has an earlier keyframe to animate from.
    const tweenButton = el('button', 'tl-icon tl-shape-tween', '\u2248')
    tweenButton.dataset.layerId = layer.id
    tweenButton.dataset.shapeId = shape.id
    this.shapeTweenButtons.push(tweenButton)
    tweenButton.addEventListener('click', (event) => {
      event.stopPropagation()
      editor.setCurrentLayer(layer.id)
      editor.toggleTweenHere()
    })

    // Per-object keyframe button: ◇ adds a keyframe, × deletes it.
    const kfButton = el('button', 'tl-icon tl-shape-kf', '\u25c7')
    kfButton.dataset.layerId = layer.id
    kfButton.dataset.shapeId = shape.id
    this.shapeKeyframeButtons.push(kfButton)
    kfButton.addEventListener('click', (event) => {
      event.stopPropagation()
      editor.setCurrentLayer(layer.id)
      editor.selectShape(shape.id)
      if (editor.hasShapeKeyframeAt(layer.id, shape.id, editor.currentFrame)) {
        editor.removeShapeKeyframe(shape.id)
      } else {
        editor.ensureShapeKeyframe(shape.id)
      }
    })

    head.append(swatch, label, kfLabel, tweenButton, kfButton)
    head.addEventListener('click', (event) => {
      if (event.target instanceof HTMLInputElement) return
      editor.setCurrentLayer(layer.id)
      editor.selectShape(shape.id)
    })
    row.appendChild(head)

    // Right-click: rename or delete the object.
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.openContextMenu({ layerId: layer.id, shapeId: shape.id }, event)
    })

    row.appendChild(this.buildShapeTrack(layer, shape, frames))
    return row
  }

  /**
   * Track of one object: its frame-span bar plus a marker on every keyframe
   * that holds the object and a tween span running to the object's next
   * keyframe. Layer rows intentionally carry no keyframe markers.
   */
  private buildShapeTrack(layer: Layer, shape: Shape, frames: number): HTMLDivElement {
    const span = this.getShapeFrameSpan(layer, shape.id)
    const track = this.buildBarTrack(
      span ? span.start : null,
      span ? span.end : null,
      frames,
      shape.fill
    )
    const sorted = [...layer.keyframes].sort((a, b) => a.frame - b.frame)
    for (let i = 0; i < sorted.length; i++) {
      const keyframe = sorted[i]
      if (!keyframe.shapes.some((candidate) => candidate.id === shape.id)) continue
      const next = sorted
        .slice(i + 1)
        .find((candidate) => candidate.shapes.some((s) => s.id === shape.id))
      if (keyframe.tween && next) {
        const tweenSpan = el('div', 'tl-tween')
        tweenSpan.style.left = `${keyframe.frame * FRAME_WIDTH}px`
        tweenSpan.style.width = `${(next.frame - keyframe.frame) * FRAME_WIDTH}px`
        track.appendChild(tweenSpan)
      }
      const marker = el('div', 'tl-key')
      marker.style.left = `${keyframe.frame * FRAME_WIDTH + FRAME_WIDTH / 2}px`
      marker.dataset.frame = String(keyframe.frame)
      marker.title = `Keyframe ${keyframe.frame + 1}${keyframe.tween ? ' · tween' : ''}`
      track.appendChild(marker)
    }
    return track
  }

  /** Track with seek cells and an optional span bar for one row height. */
  private buildBarTrack(
    spanStart: number | null,
    spanEnd: number | null,
    frames: number,
    fill?: string
  ): HTMLDivElement {
    const track = el('div', 'tl-track')
    track.style.width = `${frames * FRAME_WIDTH}px`
    track.style.height = `${ROW_HEIGHT}px`
    if (spanStart !== null && spanEnd !== null) {
      const bar = el('div', 'tl-shape-span')
      bar.style.left = `${spanStart * FRAME_WIDTH}px`
      bar.style.width = `${(spanEnd - spanStart) * FRAME_WIDTH}px`
      if (fill) bar.style.background = fill
      bar.title = `frames ${spanStart + 1}\u2013${spanEnd}`
      track.appendChild(bar)
    }
    for (let frame = 0; frame < frames; frame++) {
      const cell = el('div', 'tl-cell')
      cell.dataset.frame = String(frame)
      cell.style.left = `${frame * FRAME_WIDTH}px`
      track.appendChild(cell)
    }
    return track
  }

  /**
   * Refreshes the per-object keyframe buttons after a seek: each button shows
   * ◇ (add) or × (delete) depending on whether ITS shape owns a keyframe at
   * the current frame. Avoids a full re-render during playback.
   */
  private refreshShapeKeyframeButtons(): void {
    const editor = this.editor
    for (const button of this.shapeKeyframeButtons) {
      const layerId = button.dataset.layerId
      const shapeId = button.dataset.shapeId
      if (!layerId || !shapeId) continue
      const keyed = editor.hasShapeKeyframeAt(layerId, shapeId, editor.currentFrame)
      button.textContent = keyed ? '\u00d7' : '\u25c7'
      button.title = keyed
        ? `Remove the keyframe of this object at frame ${editor.currentFrame + 1}`
        : `Add a keyframe for this object at frame ${editor.currentFrame + 1}`
    }
  }

  /** Refreshes the per-object tween toggles after a seek. */
  private refreshShapeTweenButtons(): void {
    const editor = this.editor
    for (const button of this.shapeTweenButtons) {
      const layerId = button.dataset.layerId
      const shapeId = button.dataset.shapeId
      if (!layerId || !shapeId) continue
      const layer = getLayer(editor.document, layerId)
      if (!layer) continue
      const keyframe = findKeyframeAtFrame(layer, editor.currentFrame)
      const keyed = keyframe?.shapes.some((shape) => shape.id === shapeId) ?? false
      const previousIndex = findNearestShapeKeyframeIndex(layer, shapeId, editor.currentFrame - 1)
      const hasPrevious =
        previousIndex !== -1 && layer.keyframes[previousIndex].frame < editor.currentFrame
      button.disabled = !keyed || !hasPrevious
      button.classList.toggle('active', keyed && keyframe?.tween !== undefined)
      button.title = keyed
        ? hasPrevious
          ? keyframe?.tween
            ? 'Disable the tween starting at this keyframe'
            : 'Tween from this keyframe to the next'
          : 'No earlier keyframe for this object'
        : 'Add a keyframe first to tween this object'
    }
  }

  private openContextMenu(target: MenuTarget, event: MouseEvent): void {
    const layer = getLayer(this.editor.document, target.layerId)
    if (!layer) return
    this.menuTarget = target
    this.menuDeleteButton.disabled =
      target.shapeId === null && this.editor.document.layers.length <= 1
    this.menu.classList.remove('hidden')
    const x = Math.min(event.clientX, window.innerWidth - 170)
    const y = Math.min(event.clientY, window.innerHeight - 84)
    this.menu.style.left = `${Math.max(4, x)}px`
    this.menu.style.top = `${Math.max(4, y)}px`
  }

  private closeContextMenu(): void {
    this.menuTarget = null
    this.menu.classList.add('hidden')
  }

  /** Replaces a row label with an inline rename field. */
  private startRename(target: MenuTarget): void {
    const layer = getLayer(this.editor.document, target.layerId)
    if (!layer) return
    const row = this.findRow(target)
    const label = row?.querySelector<HTMLElement>('.name')
    if (!row || !label) return
    let currentName = layer.name
    if (target.shapeId) {
      const shape = this.collectAllShapes(layer).find((candidate) => candidate.id === target.shapeId)
      if (!shape) return
      currentName = shape.name || SHAPE_KIND_LABELS[shape.kind] || 'Object'
    }

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'tl-rename-input'
    input.value = currentName
    input.setAttribute('aria-label', 'New name')
    label.replaceWith(input)
    input.focus()
    input.select()

    let finished = false
    const finish = (commit: boolean): void => {
      if (finished) return
      finished = true
      const value = input.value.trim()
      if (commit && value && value !== currentName) {
        if (target.shapeId) this.editor.renameShape(target.layerId, target.shapeId, value)
        else this.editor.renameLayer(target.layerId, value)
      } else {
        this.render()
      }
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') finish(true)
      else if (event.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', () => finish(true))
  }

  private findRow(target: MenuTarget): HTMLElement | null {
    for (const row of this.rowsHost.querySelectorAll<HTMLElement>('.tl-row')) {
      if (row.dataset.layerId !== target.layerId) continue
      const shapeId = row.dataset.shapeId ?? null
      if (shapeId === target.shapeId) return row
    }
    return null
  }

  private deleteTarget(target: MenuTarget): void {
    if (target.shapeId) this.editor.deleteShape(target.layerId, target.shapeId)
    else this.editor.removeLayer(target.layerId)
  }

  private isPointerBelowRow(event: DragEvent, row: HTMLElement): boolean {
    const bounds = row.getBoundingClientRect()
    return event.clientY > bounds.top + bounds.height / 2
  }

  private clearDragState(): void {
    this.draggedLayerId = null
    for (const row of this.rowsHost.querySelectorAll('.dragging, .drop-before, .drop-after')) {
      row.classList.remove('dragging', 'drop-before', 'drop-after')
    }
  }

  private toggleExpand(layerId: string): void {
    if (this.expandedLayers.has(layerId)) this.expandedLayers.delete(layerId)
    else this.expandedLayers.add(layerId)
    this.render()
  }

  /** Returns the frame range [start, end) where a shape is continuously active. */
  private getShapeFrameSpan(
    layer: Layer,
    shapeId: string
  ): { start: number; end: number } | null {
    // Object-level span: the object is on stage exactly from its first
    // keyframe to its last keyframe (inclusive) and is invisible after.
    const containing = [...layer.keyframes]
      .sort((a, b) => a.frame - b.frame)
      .filter((keyframe) => keyframe.shapes.some((s) => s.id === shapeId))
    if (containing.length === 0) return null
    return {
      start: containing[0].frame,
      end: containing[containing.length - 1].frame + 1
    }
  }

  /** Collects all unique shapes across every keyframe of a layer. */
  private collectAllShapes(layer: Layer): Shape[] {
    const seen = new Set<string>()
    const result: Shape[] = []
    for (const keyframe of layer.keyframes) {
      for (const shape of keyframe.shapes) {
        if (!seen.has(shape.id)) {
          seen.add(shape.id)
          result.push(shape)
        }
      }
    }
    return result
  }

  private updatePlayhead(): void {
    this.playhead.style.left = `${HEAD_WIDTH + this.editor.currentFrame * FRAME_WIDTH + FRAME_WIDTH / 2}px`
    this.frameLabel.textContent = `frame ${this.editor.currentFrame + 1} / ${this.editor.duration}`
  }
}
