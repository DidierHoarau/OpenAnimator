import { createId, evaluateLayerAtFrame } from '@shared/document'
import type { Vec2 } from '@shared/geometry'
import { hitTestNodes, nodeBounds, rectIntersectsRect } from '@shared/hitTesting'
import type { Rect } from '@shared/hitTesting'
import { evaluateDocumentAtFrame } from '@shared/render'
import { renderLayersToSvgMarkup } from '@shared/renderSvg'
import { isObjectLayer } from '@shared/model'
import type { PrimitiveNode } from '@shared/model'
import { identityView, panView, zoomAtView } from '@shared/viewTransform'
import type { ViewTransform } from '@shared/viewTransform'
import { DrawingSession } from './drawing'
import type { Editor } from './editor'

const SVG_NS = 'http://www.w3.org/2000/svg'
const DEFAULT_FILL = '#38bdf8'
/** Minimum drag distance in screen pixels before a gesture is a drag. */
const MIN_DRAG = 4
const DEFAULT_CREATE_WIDTH = 120
const DEFAULT_CREATE_HEIGHT = 90
const ZOOM_STEP = 1.25

interface DragState {
  mode: 'create' | 'move' | 'marquee' | 'pan'
  kind: 'rect' | 'ellipse'
  start: Vec2
  last: Vec2
  /** Marquee: union with the current selection instead of replacing it. */
  additive: boolean
  /** Move drag: whether the interaction was opened (past the drag threshold). */
  moveStarted: boolean
  /** Move drag: shape centers captured at pointer-down, per selected id. */
  origins: Map<string, Vec2>
  startView: ViewTransform
  preview: SVGElement | null
}

/**
 * Renders the document on an SVG stage and handles stage interactions:
 * drawing, (multi-)selection, and view navigation (zoom/pan). The view
 * transform lives only here — it is never part of the document. Rendering
 * goes through the shared evaluate + renderSvg pipeline so the stage and
 * onion skinning can never drift apart.
 */
export class StageView {
  /** Notified after every view change with the current scale (for the statusbar). */
  onViewChange?: (scale: number) => void

  private readonly svg: SVGSVGElement
  private readonly overlay: HTMLCanvasElement
  private readonly editor: Editor
  private drag: DragState | null = null
  /** Live paint stroke (brush/eraser), mirrored onto the overlay canvas. */
  private session: DrawingSession | null = null
  private view: ViewTransform = identityView()
  private spaceDown = false
  private spaceUsedForPan = false

  constructor(editor: Editor, host: HTMLElement) {
    this.editor = editor
    this.svg = document.createElementNS(SVG_NS, 'svg')
    this.svg.classList.add('stage')
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    host.appendChild(this.svg)

    // The live-stroke mirror: an absolutely positioned canvas over the stage
    // SVG showing the session buffer until the stroke is committed.
    this.overlay = document.createElement('canvas')
    this.overlay.className = 'stage-overlay'
    host.appendChild(this.overlay)

    this.svg.addEventListener('pointerdown', (event) => this.onPointerDown(event))
    this.svg.addEventListener('pointermove', (event) => this.onPointerMove(event))
    this.svg.addEventListener('pointerup', (event) => this.onPointerUp(event))
    this.svg.addEventListener('pointercancel', () => {
      this.cancelDrag()
    })
    this.svg.addEventListener('wheel', (event) => this.onWheel(event), { passive: false })

    editor.onDocChange(() => this.render())
    editor.onFrameChange(() => this.render())
    editor.onUiChange(() => this.render())
    this.render()
  }

  /** Marks the Space key state; the stage claims Space drags for panning. */
  setSpacePressed(down: boolean): void {
    if (down && this.spaceDown) return
    this.spaceDown = down
    if (down) this.spaceUsedForPan = false
    this.updateCursor()
  }

  /** The stage SVG element — drop target for library drags. */
  get element(): SVGSVGElement {
    return this.svg
  }

  /** True when the Space press was consumed by a pan drag (no play toggle). */
  get spaceUsed(): boolean {
    return this.spaceUsedForPan
  }

  zoomIn(): void {
    this.zoomBy(ZOOM_STEP)
  }

  zoomOut(): void {
    this.zoomBy(1 / ZOOM_STEP)
  }

  /** Resets to the 1:1 letterboxed fit of the stage in the viewport. */
  resetView(): void {
    this.view = identityView()
    this.applyView()
  }

  private zoomBy(factor: number): void {
    const doc = this.editor.document
    const center = {
      x: this.view.tx + doc.width / (2 * this.view.scale),
      y: this.view.ty + doc.height / (2 * this.view.scale)
    }
    this.view = zoomAtView(this.view, center, factor)
    this.applyView()
  }

  private applyView(): void {
    const doc = this.editor.document
    this.svg.setAttribute(
      'viewBox',
      `${this.view.tx} ${this.view.ty} ${doc.width / this.view.scale} ${doc.height / this.view.scale}`
    )
    if (this.session) this.paintOverlay()
    this.onViewChange?.(this.view.scale)
  }

  /** Stage-space point under a pointer/drag event (view transform applied). */
  toStagePoint(event: MouseEvent): Vec2 {
    const ctm = this.svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse())
    return { x: point.x, y: point.y }
  }

  private updateCursor(): void {
    if (this.spaceDown || this.editor.tool === 'hand') {
      this.svg.style.cursor = this.drag?.mode === 'pan' ? 'grabbing' : 'grab'
    } else if (this.editor.tool === 'brush' || this.editor.tool === 'eraser') {
      this.svg.style.cursor = 'crosshair'
    } else {
      this.svg.style.cursor = ''
    }
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault()
    const factor = Math.exp(-event.deltaY * 0.0015)
    this.view = zoomAtView(this.view, this.toStagePoint(event), factor)
    this.applyView()
  }

  private onPointerDown(event: PointerEvent): void {
    const editor = this.editor
    const point = this.toStagePoint(event)

    // Panning: middle-button drag, left drag with Space held, or the Hand tool.
    if (event.button === 1 || (event.button === 0 && (this.spaceDown || editor.tool === 'hand'))) {
      this.drag = this.newDrag('pan', point)
      if (this.spaceDown) this.spaceUsedForPan = true
      this.updateCursor()
      this.svg.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }
    if (event.button !== 0) return

    const layer = editor.currentLayer

    if (editor.tool === 'brush' || editor.tool === 'eraser') {
      if (!layer || !layer.visible || layer.locked) return
      // The tool matrix keeps brush/eraser on drawing layers only.
      const session = new DrawingSession(
        editor,
        { eraser: editor.tool === 'eraser', onPaint: () => this.paintOverlay() }
      )
      this.session = session
      this.svg.setPointerCapture(event.pointerId)
      event.preventDefault()
      void session.begin({ ...point, pressure: event.pressure })
      return
    }

    if (editor.tool === 'select') {
      const content =
        layer && isObjectLayer(layer) ? evaluateLayerAtFrame(layer, editor.currentFrame) : []
      const hit = layer && layer.visible && isObjectLayer(layer) ? hitTestNodes(content, point) : undefined
      if (!hit) {
        // Rubber-band selection from empty stage area; Shift unions.
        if (!event.shiftKey) editor.selectNodes([], 'replace')
        const drag = this.newDrag('marquee', point)
        drag.additive = event.shiftKey
        this.drag = drag
        this.svg.setPointerCapture(event.pointerId)
        event.preventDefault()
        return
      }
      if (event.shiftKey) {
        editor.selectNodes([hit.id], 'toggle')
      } else if (!editor.selectedNodeIds.includes(hit.id)) {
        editor.selectNodes([hit.id], 'replace')
      }
      if (layer && !layer.locked && editor.selectedNodeIds.includes(hit.id)) {
        const drag = this.newDrag('move', point)
        for (const node of content) {
          if (editor.selectedNodeIds.includes(node.id)) {
            drag.origins.set(node.id, { ...node.center })
          }
        }
        this.drag = drag
        this.svg.setPointerCapture(event.pointerId)
      }
      event.preventDefault()
      return
    }

    if (
      (editor.tool === 'rect' || editor.tool === 'ellipse') &&
      layer &&
      !layer.locked &&
      layer.visible
    ) {
      this.drag = this.newDrag('create', point, editor.tool)
      this.svg.setPointerCapture(event.pointerId)
      event.preventDefault()
    }
  }

  private newDrag(mode: DragState['mode'], point: Vec2, kind: 'rect' | 'ellipse' = 'rect'): DragState {
    return {
      mode,
      kind,
      start: point,
      last: point,
      additive: false,
      moveStarted: false,
      origins: new Map(),
      startView: { ...this.view },
      preview: null
    }
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.session) {
      const point = this.toStagePoint(event)
      this.session.extend({ ...point, pressure: event.pressure })
      event.preventDefault()
      return
    }
    const drag = this.drag
    if (!drag) return
    drag.last = this.toStagePoint(event)
    if (drag.mode === 'create') {
      this.updatePreview(drag)
    } else if (drag.mode === 'move') {
      this.updateMove(drag)
    } else if (drag.mode === 'marquee') {
      this.updateMarquee(drag)
    } else {
      const dx = drag.last.x - drag.start.x
      const dy = drag.last.y - drag.start.y
      this.view = panView(drag.startView, -dx, -dy)
      this.applyView()
    }
    event.preventDefault()
  }

  private updateMove(drag: DragState): void {
    if (!drag.moveStarted) {
      if (this.dragDistance(drag) < MIN_DRAG / this.view.scale) return
      drag.moveStarted = true
      // One history entry for the whole drag, including its auto-key.
      this.editor.beginInteraction()
      this.editor.ensureSelectedNodesKeyframes()
    }
    const dx = drag.last.x - drag.start.x
    const dy = drag.last.y - drag.start.y
    this.editor.updateSelectedNodes((node) => {
      const origin = drag.origins.get(node.id)
      if (!origin) return
      node.center.x = origin.x + dx
      node.center.y = origin.y + dy
    })
  }

  private dragDistance(drag: DragState): number {
    return Math.max(Math.abs(drag.last.x - drag.start.x), Math.abs(drag.last.y - drag.start.y))
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.session) {
      const session = this.session
      this.session = null
      // The commit is one undo step; the doc change re-renders the stage and
      // clears the overlay mirror.
      void session.end()
      this.releasePointer(event)
      return
    }
    const drag = this.drag
    if (!drag) return
    this.drag = null
    if (drag.mode === 'create') {
      drag.preview?.remove()
      this.finishCreate(drag)
    } else if (drag.mode === 'move') {
      if (drag.moveStarted) this.editor.endInteraction()
    } else if (drag.mode === 'marquee') {
      drag.preview?.remove()
      this.applyMarquee(drag)
    }
    this.updateCursor()
    this.releasePointer(event)
  }

  private releasePointer(event: PointerEvent): void {
    if (this.svg.hasPointerCapture(event.pointerId)) {
      this.svg.releasePointerCapture(event.pointerId)
    }
  }

  private finishCreate(drag: DragState): void {
    let width = Math.abs(drag.last.x - drag.start.x)
    let height = Math.abs(drag.last.y - drag.start.y)
    let center = {
      x: (drag.start.x + drag.last.x) / 2,
      y: (drag.start.y + drag.last.y) / 2
    }
    const minSize = MIN_DRAG / this.view.scale
    if (width < minSize && height < minSize) {
      // A click without a real drag produces a default-size shape; the sizes
      // are divided by the scale so they land at a constant size on screen.
      width = DEFAULT_CREATE_WIDTH / this.view.scale
      height = DEFAULT_CREATE_HEIGHT / this.view.scale
      center = { ...drag.start }
    }
    const node: PrimitiveNode = {
      id: createId('node'),
      type: 'primitive',
      primitive: drag.kind,
      center,
      width: Math.max(2, width),
      height: Math.max(2, height),
      rotation: 0,
      fill: DEFAULT_FILL,
      opacity: 1
    }
    this.editor.addNode(node)
  }

  private applyMarquee(drag: DragState): void {
    const width = Math.abs(drag.last.x - drag.start.x)
    const height = Math.abs(drag.last.y - drag.start.y)
    const minSize = MIN_DRAG / this.view.scale
    if (width < minSize && height < minSize) return
    const editor = this.editor
    const layer = editor.currentLayer
    if (!layer || !layer.visible) return
    const marquee: Rect = {
      x: Math.min(drag.start.x, drag.last.x),
      y: Math.min(drag.start.y, drag.last.y),
      width,
      height
    }
    const ids = isObjectLayer(layer)
      ? evaluateLayerAtFrame(layer, editor.currentFrame)
          .filter((node) => rectIntersectsRect(nodeBounds(node), marquee))
          .map((node) => node.id)
      : []
    editor.selectNodes(ids, drag.additive ? 'add' : 'replace')
  }

  private cancelDrag(): void {
    if (this.session) {
      this.session.cancel()
      this.session = null
      this.clearOverlay()
      this.updateCursor()
      return
    }
    const drag = this.drag
    if (!drag) return
    this.drag = null
    if (drag.mode === 'move' && drag.moveStarted) this.editor.endInteraction()
    drag.preview?.remove()
    this.updateCursor()
  }

  /**
   * Mirrors the live stroke buffer onto the overlay canvas: the buffer (stage
   * size × resolution scale) is drawn at the stage rect's current screen
   * position, so the mirror follows zoom/pan exactly like the SVG content.
   */
  private paintOverlay(): void {
    const session = this.session
    const buffer = session?.bufferCanvas
    if (!session || !buffer) {
      this.clearOverlay()
      return
    }
    const host = this.overlay.parentElement
    const ctx = this.overlay.getContext('2d')
    if (!host || !ctx) return
    const hostRect = host.getBoundingClientRect()
    const svgRect = this.svg.getBoundingClientRect()
    this.overlay.style.left = `${svgRect.left - hostRect.left}px`
    this.overlay.style.top = `${svgRect.top - hostRect.top}px`
    this.overlay.style.width = `${svgRect.width}px`
    this.overlay.style.height = `${svgRect.height}px`
    const canvasRect = this.overlay.getBoundingClientRect()
    if (this.overlay.width !== Math.round(svgRect.width) || this.overlay.height !== Math.round(svgRect.height)) {
      this.overlay.width = Math.max(1, Math.round(svgRect.width))
      this.overlay.height = Math.max(1, Math.round(svgRect.height))
    }
    const ctm = this.svg.getScreenCTM()
    if (!ctm) return
    const origin = new DOMPoint(0, 0).matrixTransform(ctm)
    const unitX = new DOMPoint(1, 0).matrixTransform(ctm)
    const unitY = new DOMPoint(0, 1).matrixTransform(ctm)
    const scaleX = Math.hypot(unitX.x - origin.x, unitX.y - origin.y)
    const scaleY = Math.hypot(unitY.x - origin.x, unitY.y - origin.y)
    const doc = this.editor.document
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(
      buffer,
      origin.x - canvasRect.left,
      origin.y - canvasRect.top,
      Math.max(1, doc.width * scaleX),
      Math.max(1, doc.height * scaleY)
    )
  }

  private clearOverlay(): void {
    const ctx = this.overlay.getContext('2d')
    ctx?.clearRect(0, 0, this.overlay.width, this.overlay.height)
  }

  private updatePreview(drag: DragState): void {
    let preview = drag.preview
    if (!preview) {
      preview = document.createElementNS(SVG_NS, drag.kind === 'rect' ? 'rect' : 'ellipse')
      preview.setAttribute('fill', 'rgba(56, 189, 248, 0.2)')
      preview.setAttribute('stroke', DEFAULT_FILL)
      preview.setAttribute('stroke-width', '1')
      preview.setAttribute('vector-effect', 'non-scaling-stroke')
      this.svg.appendChild(preview)
      drag.preview = preview
    }
    const width = Math.abs(drag.last.x - drag.start.x)
    const height = Math.abs(drag.last.y - drag.start.y)
    const cx = (drag.start.x + drag.last.x) / 2
    const cy = (drag.start.y + drag.last.y) / 2
    if (drag.kind === 'rect') {
      preview.setAttribute('x', String(Math.min(drag.start.x, drag.last.x)))
      preview.setAttribute('y', String(Math.min(drag.start.y, drag.last.y)))
      preview.setAttribute('width', String(width))
      preview.setAttribute('height', String(height))
    } else {
      preview.setAttribute('cx', String(cx))
      preview.setAttribute('cy', String(cy))
      preview.setAttribute('rx', String(width / 2))
      preview.setAttribute('ry', String(height / 2))
    }
  }

  private updateMarquee(drag: DragState): void {
    let marquee = drag.preview as SVGRectElement | null
    if (!marquee) {
      marquee = document.createElementNS(SVG_NS, 'rect')
      marquee.classList.add('stage__marquee')
      marquee.setAttribute('vector-effect', 'non-scaling-stroke')
      this.svg.appendChild(marquee)
      drag.preview = marquee
    }
    marquee.setAttribute('x', String(Math.min(drag.start.x, drag.last.x)))
    marquee.setAttribute('y', String(Math.min(drag.start.y, drag.last.y)))
    marquee.setAttribute('width', String(Math.abs(drag.last.x - drag.start.x)))
    marquee.setAttribute('height', String(Math.abs(drag.last.y - drag.start.y)))
  }

  render(): void {
    const editor = this.editor
    const doc = editor.document
    this.applyView()
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild)

    const backdrop = document.createElementNS(SVG_NS, 'rect')
    backdrop.setAttribute('x', '0')
    backdrop.setAttribute('y', '0')
    backdrop.setAttribute('width', String(doc.width))
    backdrop.setAttribute('height', String(doc.height))
    backdrop.setAttribute('fill', doc.background)
    this.svg.appendChild(backdrop)

    if (editor.onionSkin && !editor.playing) {
      const ghosts = document.createElementNS(SVG_NS, 'g')
      ghosts.classList.add('stage__onion')
      for (const offset of [-2, -1, 1, 2]) {
        const frame = editor.currentFrame + offset
        if (frame < 0 || frame >= editor.duration) continue
        const group = document.createElementNS(SVG_NS, 'g')
        group.setAttribute('opacity', String(0.24 / Math.abs(offset)))
        group.innerHTML = renderLayersToSvgMarkup(
          evaluateDocumentAtFrame(doc, frame),
          editor.resources.getUrl
        )
        ghosts.appendChild(group)
      }
      this.svg.appendChild(ghosts)
    }

    const stageContent = document.createElementNS(SVG_NS, 'g')
    stageContent.innerHTML = renderLayersToSvgMarkup(
      evaluateDocumentAtFrame(doc, editor.currentFrame),
      editor.resources.getUrl
    )
    this.svg.appendChild(stageContent)

    // One selection box per selected node of the current layer's content.
    const layer = editor.currentLayer
    if (layer && layer.visible && isObjectLayer(layer)) {
      for (const node of evaluateLayerAtFrame(layer, editor.currentFrame)) {
        if (!editor.selectedNodeIds.includes(node.id)) continue
        const overlay = document.createElementNS(SVG_NS, 'rect')
        overlay.classList.add('stage__selection')
        overlay.setAttribute('x', String(-node.width / 2))
        overlay.setAttribute('y', String(-node.height / 2))
        overlay.setAttribute('width', String(node.width))
        overlay.setAttribute('height', String(node.height))
        overlay.setAttribute(
          'transform',
          `translate(${node.center.x} ${node.center.y}) rotate(${node.rotation})`
        )
        overlay.setAttribute('vector-effect', 'non-scaling-stroke')
        this.svg.appendChild(overlay)
      }
    }
    this.updateCursor()
    if (this.session) this.paintOverlay()
    else this.clearOverlay()
  }
}
