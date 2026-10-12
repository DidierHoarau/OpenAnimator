import { createId, evaluateLayerAtFrame } from '@shared/document'
import type { Vec2 } from '@shared/geometry'
import { hitTestNodes, nodeBounds, rectIntersectsRect } from '@shared/hitTesting'
import type { Rect } from '@shared/hitTesting'
import { evaluateDocumentAtFrame } from '@shared/render'
import { renderLayersToSvgMarkup } from '@shared/renderSvg'
import type { SvgRenderOptions } from '@shared/renderSvg'
import { embeddedFamilyResolverFor } from '@shared/fontPolicy'
import { isObjectLayer } from '@shared/model'
import type { AnimatorDocument, PathAnchor, PathNode, PrimitiveNode, TextNode } from '@shared/model'
import { motionPathForNode } from '@shared/motionPath'
import type { MotionPath } from '@shared/motionPath'
import { buildPathData, normalizePathData, pathDataBounds } from '@shared/pathModel'
import { applyTextMetrics } from '@shared/textModel'
import { identityView, panView, zoomAtView } from '@shared/viewTransform'
import type { ViewTransform } from '@shared/viewTransform'
import { DrawingSession, strokeToPathData } from './drawing'
import type { StrokePoint } from './drawing'
import type { Editor } from './editor'

const SVG_NS = 'http://www.w3.org/2000/svg'
const DEFAULT_FILL = '#38bdf8'
const DEFAULT_TEXT_FILL = '#e2e8f0'
/** Minimum drag distance in screen pixels before a gesture is a drag. */
const MIN_DRAG = 4
const DEFAULT_CREATE_WIDTH = 120
const DEFAULT_CREATE_HEIGHT = 90
const ZOOM_STEP = 1.25
/** Pen: stage-space distance within which a click closes the path. */
const PEN_CLOSE_RADIUS = 10
const PEN_STROKE = '#e2e8f0'
const PEN_STROKE_WIDTH = 3
/** Flat stroke color of outlined onion ghosts (a neutral slate). */
const ONION_OUTLINE_COLOR = '#94a3b8'

interface DragState {
  mode: 'create' | 'move' | 'marquee' | 'pan' | 'pen'
  kind: 'rect' | 'ellipse' | 'line'
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
  /** Pen: index of the anchor whose handles are being dragged. */
  penIndex: number
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
  /** Pen tool: committed anchors of the path being placed (stage coords). */
  private penAnchors: PathAnchor[] = []
  /** Pen tool: current pointer position for the rubber-band segment. */
  private penCursor: Vec2 | null = null
  private penPreview: SVGGElement | null = null
  /** Vector brush: sampled centerline of the stroke being drawn (stage coords). */
  private vectorPoints: StrokePoint[] | null = null
  private vectorPreview: SVGPathElement | null = null
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
    this.svg.addEventListener('dblclick', () => {
      if (this.editor.tool === 'pen') this.commitPen(false)
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
    } else if (
      this.editor.tool === 'brush' ||
      this.editor.tool === 'eraser' ||
      this.editor.tool === 'pen' ||
      this.editor.tool === 'text' ||
      this.editor.tool === 'line' ||
      this.editor.tool === 'vector'
    ) {
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

    if (editor.tool === 'vector') {
      if (!layer || !layer.visible || layer.locked) return
      this.vectorPoints = [{ ...point, pressure: event.pressure }]
      this.svg.setPointerCapture(event.pointerId)
      this.drawVectorPreview()
      event.preventDefault()
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
      (editor.tool === 'rect' || editor.tool === 'ellipse' || editor.tool === 'line') &&
      layer &&
      !layer.locked &&
      layer.visible
    ) {
      this.drag = this.newDrag('create', point, editor.tool)
      this.svg.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }

    if (editor.tool === 'pen' && layer && !layer.locked && layer.visible) {
      // Clicking the first anchor closes the path; anything else places one.
      const first = this.penAnchors[0]
      if (
        first &&
        this.penAnchors.length >= 3 &&
        Math.hypot(point.x - first.x, point.y - first.y) < PEN_CLOSE_RADIUS / this.view.scale
      ) {
        this.commitPen(true)
        return
      }
      this.penAnchors.push({ x: point.x, y: point.y })
      this.penCursor = point
      const drag = this.newDrag('pen', point)
      drag.penIndex = this.penAnchors.length - 1
      this.drag = drag
      this.svg.setPointerCapture(event.pointerId)
      this.drawPenPreview()
      event.preventDefault()
      return
    }

    if (editor.tool === 'text' && layer && !layer.locked && layer.visible) {
      this.placeTextNode(point)
      event.preventDefault()
    }
  }

  /** Creates a default text node at `point` and selects it; content and font
   * are edited in the properties panel. The tool switches back to select so
   * extra clicks do not stack more text nodes. */
  private placeTextNode(point: Vec2): void {
    const node: TextNode = {
      id: createId('node'),
      type: 'text',
      center: point,
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      text: 'Text',
      fontFamily: 'Noto Sans',
      fontSize: 48,
      fontWeight: 400,
      fill: DEFAULT_TEXT_FILL,
      align: 'left'
    }
    applyTextMetrics(node, this.editor.measureText)
    this.editor.addNode(node)
    this.editor.setTool('select')
  }

  private newDrag(mode: DragState['mode'], point: Vec2, kind: DragState['kind'] = 'rect'): DragState {
    return {
      mode,
      kind,
      start: point,
      last: point,
      additive: false,
      moveStarted: false,
      origins: new Map(),
      startView: { ...this.view },
      preview: null,
      penIndex: -1
    }
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.session) {
      const point = this.toStagePoint(event)
      this.session.extend({ ...point, pressure: event.pressure })
      event.preventDefault()
      return
    }
    if (this.vectorPoints) {
      const point = this.toStagePoint(event)
      this.vectorPoints.push({ ...point, pressure: event.pressure })
      this.drawVectorPreview()
      event.preventDefault()
      return
    }
    const drag = this.drag
    if (!drag) {
      // Pen hover: keep the rubber-band segment attached to the pointer.
      if (this.editor.tool === 'pen' && this.penAnchors.length > 0) {
        this.penCursor = this.toStagePoint(event)
        this.drawPenPreview()
      }
      return
    }
    drag.last = this.toStagePoint(event)
    if (drag.mode === 'create') {
      this.updatePreview(drag)
    } else if (drag.mode === 'pen') {
      this.updatePenHandles(drag)
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
    if (this.vectorPoints) {
      const points = this.vectorPoints
      this.vectorPoints = null
      this.clearVectorPreview()
      // The commit is one undo step (Editor.addNode auto-keys and selects).
      this.commitVectorStroke(points)
      this.releasePointer(event)
      return
    }
    const drag = this.drag
    if (!drag) return
    this.drag = null
    if (drag.mode === 'create') {
      drag.preview?.remove()
      this.finishCreate(drag)
    } else if (drag.mode === 'pen') {
      // The anchor (with its handles) stays placed; the path commits on
      // double-click, closing click, Enter or layer/tool change.
      this.drawPenPreview()
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
    if (drag.kind === 'line') {
      this.finishLineCreate(drag)
      return
    }
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

  /** Commits a line-tool drag as a straight 2-anchor path node. */
  private finishLineCreate(drag: DragState): void {
    const minSize = MIN_DRAG / this.view.scale
    let start = drag.start
    let end = drag.last
    if (Math.abs(end.x - start.x) < minSize && Math.abs(end.y - start.y) < minSize) {
      // A click without a real drag produces a default-length horizontal line.
      const half = DEFAULT_CREATE_WIDTH / this.view.scale / 2
      start = { x: start.x - half, y: start.y }
      end = { x: start.x + 2 * half, y: start.y }
    }
    const raw = buildPathData(
      [
        { x: start.x, y: start.y },
        { x: end.x, y: end.y }
      ],
      false
    )
    const bounds = pathDataBounds(raw)
    const d = normalizePathData(raw)
    const node: PathNode = {
      id: createId('node'),
      type: 'path',
      center: bounds
        ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
        : { ...start },
      width: Math.max(2, bounds?.width ?? 2),
      height: Math.max(2, bounds?.height ?? 2),
      rotation: 0,
      opacity: 1,
      d,
      stroke: PEN_STROKE,
      strokeWidth: PEN_STROKE_WIDTH
    }
    this.editor.addNode(node)
  }

  /**
   * Commits the pen path: consecutive duplicate anchors are dropped, short
   * paths are discarded, and the geometry is normalized into a PathNode —
   * filled when closed, stroked when open.
   */
  private commitPen(closed: boolean): void {
    const anchors = this.penAnchors.filter((anchor, index) => {
      const previous = this.penAnchors[index - 1]
      return !previous || Math.hypot(anchor.x - previous.x, anchor.y - previous.y) > 0.5
    })
    this.cancelPen()
    if (anchors.length < 2) return
    const raw = buildPathData(anchors, closed)
    const bounds = pathDataBounds(raw)
    if (!bounds) return
    const node: PathNode = {
      id: createId('node'),
      type: 'path',
      center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      width: Math.max(2, bounds.width),
      height: Math.max(2, bounds.height),
      rotation: 0,
      opacity: 1,
      d: normalizePathData(raw),
      ...(closed
        ? { fill: DEFAULT_FILL, stroke: PEN_STROKE, strokeWidth: PEN_STROKE_WIDTH }
        : { stroke: PEN_STROKE, strokeWidth: PEN_STROKE_WIDTH })
    }
    this.editor.addNode(node)
  }

  /** Discards the in-progress pen path and its preview. */
  cancelPen(): void {
    this.penAnchors = []
    this.penCursor = null
    this.clearPenPreview()
  }

  /** Public hook for the keyboard shortcuts (Enter commits, Escape cancels). */
  finishPen(): void {
    if (this.editor.tool === 'pen') this.commitPen(false)
  }

  private updatePenHandles(drag: DragState): void {
    const anchor = this.penAnchors[drag.penIndex]
    if (!anchor) return
    const out = { x: drag.last.x - anchor.x, y: drag.last.y - anchor.y }
    if (Math.hypot(out.x, out.y) < 2 / this.view.scale) {
      delete anchor.out
      delete anchor.in
    } else {
      // A drag pulls a mirrored smooth handle pair out of the anchor.
      anchor.out = out
      anchor.in = { x: -out.x, y: -out.y }
    }
    this.drawPenPreview()
  }

  /** Dashed preview of the in-progress pen path with its anchors. */
  private drawPenPreview(): void {
    if (!this.penPreview) {
      this.penPreview = document.createElementNS(SVG_NS, 'g')
      this.penPreview.classList.add('stage__pen')
      this.svg.appendChild(this.penPreview)
    }
    const group = this.penPreview
    while (group.firstChild) group.removeChild(group.firstChild)
    if (this.penAnchors.length === 0) return
    const preview = document.createElementNS(SVG_NS, 'path')
    const anchors = [...this.penAnchors]
    if (this.penCursor && this.drag === null) {
      anchors.push({ x: this.penCursor.x, y: this.penCursor.y })
    }
    preview.setAttribute('d', buildPathData(anchors, false))
    preview.setAttribute('fill', 'none')
    preview.setAttribute('stroke', DEFAULT_FILL)
    preview.setAttribute('stroke-width', '1.5')
    preview.setAttribute('stroke-dasharray', '6 4')
    preview.setAttribute('vector-effect', 'non-scaling-stroke')
    group.appendChild(preview)
    for (const anchor of this.penAnchors) {
      const dot = document.createElementNS(SVG_NS, 'circle')
      dot.setAttribute('cx', String(anchor.x))
      dot.setAttribute('cy', String(anchor.y))
      dot.setAttribute('r', String(3 / this.view.scale))
      dot.setAttribute('fill', DEFAULT_FILL)
      group.appendChild(dot)
    }
  }

  private clearPenPreview(): void {
    this.penPreview?.remove()
    this.penPreview = null
  }

  /** Live preview of the in-progress vector stroke: the smoothed centerline
   * drawn with the current brush color, size and opacity. */
  private drawVectorPreview(): void {
    const points = this.vectorPoints
    if (!points || points.length === 0) return
    if (!this.vectorPreview) {
      this.vectorPreview = document.createElementNS(SVG_NS, 'path')
      this.vectorPreview.classList.add('stage__vector')
      this.vectorPreview.setAttribute('pointer-events', 'none')
      this.svg.appendChild(this.vectorPreview)
    }
    const preview = this.vectorPreview
    preview.setAttribute('d', strokeToPathData(points))
    preview.setAttribute('fill', 'none')
    preview.setAttribute('stroke', this.editor.brushColor)
    preview.setAttribute('stroke-width', String(this.editor.brushSize))
    preview.setAttribute('stroke-linecap', 'round')
    preview.setAttribute('stroke-linejoin', 'round')
    preview.setAttribute('opacity', String(this.editor.brushOpacity))
  }

  private clearVectorPreview(): void {
    this.vectorPreview?.remove()
    this.vectorPreview = null
  }

  /** Discards the in-progress vector stroke (Escape, tool change). */
  cancelVectorStroke(): void {
    this.vectorPoints = null
    this.clearVectorPreview()
  }

  /**
   * Commits the pointed stroke as one editable `PathNode`: the smoothed
   * centerline becomes `d` (normalized so the bbox center sits at the node
   * center), the node carries the brush color/size/opacity with fill `none`.
   */
  private commitVectorStroke(points: StrokePoint[]): void {
    const filtered = points.filter((point, index) => {
      const previous = points[index - 1]
      return !previous || Math.hypot(point.x - previous.x, point.y - previous.y) > 0.5
    })
    const raw = strokeToPathData(filtered)
    if (!raw) return
    const bounds = pathDataBounds(raw)
    if (!bounds) return
    const node: PathNode = {
      id: createId('node'),
      type: 'path',
      center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      width: Math.max(2, bounds.width),
      height: Math.max(2, bounds.height),
      rotation: 0,
      opacity: this.editor.brushOpacity,
      d: normalizePathData(raw),
      fill: 'none',
      stroke: this.editor.brushColor,
      strokeWidth: this.editor.brushSize
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
    if (this.vectorPoints) {
      this.cancelVectorStroke()
      this.updateCursor()
      return
    }
    const drag = this.drag
    if (!drag) return
    this.drag = null
    if (drag.mode === 'pen') {
      // The in-flight anchor was never committed by the user: drop it.
      this.penAnchors.splice(drag.penIndex, 1)
      if (this.penAnchors.length === 0) this.clearPenPreview()
      else this.drawPenPreview()
      this.updateCursor()
      return
    }
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
    if (drag.kind === 'line') {
      let preview = drag.preview as SVGLineElement | null
      if (!preview) {
        preview = document.createElementNS(SVG_NS, 'line')
        preview.setAttribute('stroke', DEFAULT_FILL)
        preview.setAttribute('stroke-width', '1.5')
        preview.setAttribute('vector-effect', 'non-scaling-stroke')
        this.svg.appendChild(preview)
        drag.preview = preview
      }
      preview.setAttribute('x1', String(drag.start.x))
      preview.setAttribute('y1', String(drag.start.y))
      preview.setAttribute('x2', String(drag.last.x))
      preview.setAttribute('y2', String(drag.last.y))
      return
    }
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
      const tint = editor.onionTint
        ? {
            before: this.appendOnionTintFilter(ghosts, 'stage-onion-before', editor.onionTintBefore),
            after: this.appendOnionTintFilter(ghosts, 'stage-onion-after', editor.onionTintAfter)
          }
        : null
      const outline: SvgRenderOptions | undefined = editor.onionOutline
        ? { outline: { color: ONION_OUTLINE_COLOR } }
        : undefined
      const step = editor.holdStep
      for (let depth = 1; depth <= editor.onionBefore; depth++) {
        const frame = editor.currentFrame - depth * step
        if (frame < 0) continue
        ghosts.appendChild(this.onionGhost(doc, frame, depth, tint?.before, outline))
      }
      for (let depth = 1; depth <= editor.onionAfter; depth++) {
        const frame = editor.currentFrame + depth * step
        if (frame >= editor.duration) continue
        ghosts.appendChild(this.onionGhost(doc, frame, depth, tint?.after, outline))
      }
      this.svg.appendChild(ghosts)
    }

    const stageContent = document.createElementNS(SVG_NS, 'g')
    const evaluated = evaluateDocumentAtFrame(doc, editor.currentFrame)
    stageContent.innerHTML = renderLayersToSvgMarkup(
      evaluated.layers,
      (id) => editor.resources.getUrl(id),
      { resolveEmbeddedFont: embeddedFamilyResolverFor(doc.fonts) }
    )
    this.svg.appendChild(stageContent)

    // Display-only camera framing overlay: the stage stays in document space
    // (no coordinate remapping of tools), this rect shows where the active
    // camera looks — W/zoom × H/zoom around the pose center, rotated with it.
    if (evaluated.camera) {
      const pose = evaluated.camera
      const cameraFrame = document.createElementNS(SVG_NS, 'rect')
      cameraFrame.classList.add('stage__camera-frame')
      cameraFrame.setAttribute('x', String(-doc.width / (2 * pose.zoom)))
      cameraFrame.setAttribute('y', String(-doc.height / (2 * pose.zoom)))
      cameraFrame.setAttribute('width', String(doc.width / pose.zoom))
      cameraFrame.setAttribute('height', String(doc.height / pose.zoom))
      cameraFrame.setAttribute(
        'transform',
        `translate(${pose.center.x} ${pose.center.y}) rotate(${pose.rotation})`
      )
      cameraFrame.setAttribute('vector-effect', 'non-scaling-stroke')
      cameraFrame.setAttribute('pointer-events', 'none')
      this.svg.appendChild(cameraFrame)
    }

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
        // Read-only trajectory preview for tweened selected nodes.
        const motionPath = motionPathForNode(layer, node.id)
        if (motionPath) this.appendMotionPath(motionPath)
      }
    }
    this.updateCursor()
    // A pen path is abandoned when the tool changes; otherwise it previews.
    if (this.penAnchors.length > 0) {
      if (editor.tool === 'pen') this.drawPenPreview()
      else this.cancelPen()
    }
    // A vector stroke in progress survives re-renders; a tool change cancels it.
    if (this.vectorPoints) {
      if (editor.tool === 'vector') this.drawVectorPreview()
      else this.cancelVectorStroke()
    }
    if (this.session) this.paintOverlay()
    else this.clearOverlay()
  }

  /**
   * Defines the tint filter for one onion direction inside the ghost group and
   * returns its `url(#…)` reference: the ghost's pixels are replaced by a flat
   * flood color via `feFlood` + `feComposite operator="in"`.
   */
  private appendOnionTintFilter(parent: SVGGElement, id: string, color: string): string {
    const defs = document.createElementNS(SVG_NS, 'defs')
    const filter = document.createElementNS(SVG_NS, 'filter')
    filter.setAttribute('id', id)
    filter.setAttribute('color-interpolation-filters', 'sRGB')
    const flood = document.createElementNS(SVG_NS, 'feFlood')
    flood.setAttribute('flood-color', color)
    flood.setAttribute('result', 'tint')
    const composite = document.createElementNS(SVG_NS, 'feComposite')
    composite.setAttribute('in', 'tint')
    composite.setAttribute('in2', 'SourceGraphic')
    composite.setAttribute('operator', 'in')
    filter.append(flood, composite)
    defs.appendChild(filter)
    parent.appendChild(defs)
    return `url(#${id})`
  }

  /** One onion ghost at `frame`; the opacity ramp stays `0.24 / depth`. */
  private onionGhost(
    doc: AnimatorDocument,
    frame: number,
    depth: number,
    tintFilter: string | undefined,
    outline: SvgRenderOptions | undefined
  ): SVGGElement {
    const group = document.createElementNS(SVG_NS, 'g')
    group.setAttribute('opacity', String(0.24 / depth))
    if (tintFilter) group.setAttribute('filter', tintFilter)
    group.innerHTML = renderLayersToSvgMarkup(
      evaluateDocumentAtFrame(doc, frame).layers,
      (id) => this.editor.resources.getUrl(id),
      { ...outline, resolveEmbeddedFont: embeddedFamilyResolverFor(doc.fonts) }
    )
    return group
  }

  /**
   * Read-only motion-path overlay for one selected node: the tweened
   * trajectory as a polyline plus one dot per keyframe waypoint, in document
   * coordinates (no pointer handlers — the hit layer stays authoritative).
   */
  private appendMotionPath(motionPath: MotionPath): void {
    if (motionPath.polyline.length > 1) {
      const first = motionPath.polyline[0]
      let d = `M ${first.x} ${first.y}`
      for (let i = 1; i < motionPath.polyline.length; i++) {
        d += ` L ${motionPath.polyline[i].x} ${motionPath.polyline[i].y}`
      }
      const line = document.createElementNS(SVG_NS, 'path')
      line.classList.add('stage__motion-path')
      line.setAttribute('d', d)
      line.setAttribute('vector-effect', 'non-scaling-stroke')
      this.svg.appendChild(line)
    }
    for (const waypoint of motionPath.waypoints) {
      const dot = document.createElementNS(SVG_NS, 'circle')
      dot.classList.add('stage__motion-key')
      dot.setAttribute('cx', String(waypoint.point.x))
      dot.setAttribute('cy', String(waypoint.point.y))
      dot.setAttribute('r', String(3 / this.view.scale))
      this.svg.appendChild(dot)
    }
  }
}
