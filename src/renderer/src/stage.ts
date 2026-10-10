import { createId, evaluateLayerAtFrame } from '@shared/document'
import type { Vec2 } from '@shared/geometry'
import { hitTestShapes } from '@shared/hitTesting'
import type { Shape } from '@shared/model'
import type { Editor } from './editor'

const SVG_NS = 'http://www.w3.org/2000/svg'
const DEFAULT_FILL = '#38bdf8'
const MIN_DRAG = 4

interface DragState {
  mode: 'create' | 'move'
  kind: 'rect' | 'ellipse'
  start: Vec2
  last: Vec2
  origin: Vec2
  preview: SVGElement | null
}

/** Renders the document on an SVG stage and handles stage interactions. */
export class StageView {
  private readonly svg: SVGSVGElement
  private drag: DragState | null = null

  constructor(
    private readonly editor: Editor,
    host: HTMLElement
  ) {
    this.svg = document.createElementNS(SVG_NS, 'svg')
    this.svg.classList.add('stage')
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    host.appendChild(this.svg)

    this.svg.addEventListener('pointerdown', (event) => this.onPointerDown(event))
    this.svg.addEventListener('pointermove', (event) => this.onPointerMove(event))
    this.svg.addEventListener('pointerup', (event) => this.onPointerUp(event))
    this.svg.addEventListener('pointercancel', () => {
      this.cancelDrag()
    })

    editor.onDocChange(() => this.render())
    editor.onFrameChange(() => this.render())
    editor.onUiChange(() => this.render())
    this.render()
  }

  private toStagePoint(event: PointerEvent): Vec2 {
    const ctm = this.svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse())
    return { x: point.x, y: point.y }
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    const editor = this.editor
    const point = this.toStagePoint(event)
    const layer = editor.currentLayer

    if (editor.tool === 'select') {
      const content = layer ? evaluateLayerAtFrame(layer, editor.currentFrame) : []
      const hit = layer && layer.visible ? hitTestShapes(content, point) : undefined
      editor.selectShape(hit?.id ?? null)
      if (hit && layer && !layer.locked) {
        editor.ensureSelectedShapeKeyframe()
        this.drag = { mode: 'move', kind: 'rect', start: point, last: point, origin: { ...hit.center }, preview: null }
        this.svg.setPointerCapture(event.pointerId)
      }
    } else if (layer && !layer.locked && layer.visible) {
      this.drag = {
        mode: 'create',
        kind: editor.tool,
        start: point,
        last: point,
        origin: { ...point },
        preview: null
      }
      this.svg.setPointerCapture(event.pointerId)
    } else {
      return
    }
    event.preventDefault()
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag
    if (!drag) return
    drag.last = this.toStagePoint(event)
    if (drag.mode === 'create') {
      this.updatePreview(drag)
    } else {
      const dx = drag.last.x - drag.start.x
      const dy = drag.last.y - drag.start.y
      this.editor.updateSelectedShape((shape) => {
        shape.center.x = drag.origin.x + dx
        shape.center.y = drag.origin.y + dy
      })
    }
    event.preventDefault()
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag
    if (!drag) return
    this.drag = null
    if (drag.mode === 'create') {
      drag.preview?.remove()
      let width = Math.abs(drag.last.x - drag.start.x)
      let height = Math.abs(drag.last.y - drag.start.y)
      let center = {
        x: (drag.start.x + drag.last.x) / 2,
        y: (drag.start.y + drag.last.y) / 2
      }
      if (width < MIN_DRAG && height < MIN_DRAG) {
        // A click without a real drag produces a default-size shape.
        width = 120
        height = 90
        center = { ...drag.start }
      }
      const shape: Shape = {
        id: createId('shape'),
        kind: drag.kind,
        center,
        width: Math.max(2, width),
        height: Math.max(2, height),
        rotation: 0,
        fill: DEFAULT_FILL,
        opacity: 1
      }
      this.editor.addShape(shape)
    }
    if (this.svg.hasPointerCapture(event.pointerId)) {
      this.svg.releasePointerCapture(event.pointerId)
    }
  }

  private cancelDrag(): void {
    if (this.drag?.preview) this.drag.preview.remove()
    this.drag = null
  }

  private updatePreview(drag: DragState): void {
    let preview = drag.preview
    if (!preview) {
      preview = document.createElementNS(SVG_NS, drag.kind === 'rect' ? 'rect' : 'ellipse')
      preview.setAttribute('fill', 'rgba(56, 189, 248, 0.2)')
      preview.setAttribute('stroke', DEFAULT_FILL)
      preview.setAttribute('stroke-width', '1')
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

  render(): void {
    const editor = this.editor
    const doc = editor.document
    this.svg.setAttribute('viewBox', `0 0 ${doc.width} ${doc.height}`)
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
        for (const layer of [...doc.layers].reverse()) {
          if (!layer.visible) continue
          for (const shape of evaluateLayerAtFrame(layer, frame)) {
            group.appendChild(createShapeElement(shape))
          }
        }
        ghosts.appendChild(group)
      }
      this.svg.appendChild(ghosts)
    }

    const stageContent = document.createElementNS(SVG_NS, 'g')
    for (const layer of [...doc.layers].reverse()) {
      if (!layer.visible) continue
      for (const shape of evaluateLayerAtFrame(layer, editor.currentFrame)) {
        stageContent.appendChild(createShapeElement(shape))
      }
    }
    this.svg.appendChild(stageContent)

    const selected = this.getSelectedShape()
    if (selected) {
      const overlay = document.createElementNS(SVG_NS, 'rect')
      overlay.classList.add('stage__selection')
      overlay.setAttribute('x', String(-selected.width / 2))
      overlay.setAttribute('y', String(-selected.height / 2))
      overlay.setAttribute('width', String(selected.width))
      overlay.setAttribute('height', String(selected.height))
      overlay.setAttribute(
        'transform',
        `translate(${selected.center.x} ${selected.center.y}) rotate(${selected.rotation})`
      )
      this.svg.appendChild(overlay)
    }
  }

  private getSelectedShape(): Shape | undefined {
    const editor = this.editor
    if (!editor.selectedShapeId) return undefined
    const layer = editor.currentLayer
    if (!layer || !layer.visible) return undefined
    return evaluateLayerAtFrame(layer, editor.currentFrame).find(
      (shape) => shape.id === editor.selectedShapeId
    )
  }
}

function createShapeElement(shape: Shape): SVGElement {
  let element: SVGElement
  if (shape.kind === 'ellipse') {
    const ellipse = document.createElementNS(SVG_NS, 'ellipse')
    ellipse.setAttribute('rx', String(shape.width / 2))
    ellipse.setAttribute('ry', String(shape.height / 2))
    element = ellipse
  } else {
    const rect = document.createElementNS(SVG_NS, 'rect')
    rect.setAttribute('x', String(-shape.width / 2))
    rect.setAttribute('y', String(-shape.height / 2))
    rect.setAttribute('width', String(shape.width))
    rect.setAttribute('height', String(shape.height))
    element = rect
  }
  element.setAttribute('fill', shape.fill)
  if (shape.stroke) element.setAttribute('stroke', shape.stroke)
  if (shape.strokeWidth !== undefined) element.setAttribute('stroke-width', String(shape.strokeWidth))
  element.setAttribute(
    'transform',
    `translate(${shape.center.x} ${shape.center.y}) rotate(${shape.rotation})`
  )
  element.setAttribute('opacity', String(shape.opacity))
  return element
}
