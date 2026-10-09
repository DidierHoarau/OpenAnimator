import { formatHexColor, parseHexColor } from '@shared/color'
import { findKeyframeIndexForFrame } from '@shared/document'
import type { Shape } from '@shared/model'

import type { Editor } from './editor'
import { el } from './dom'

const DEFAULT_FILL = '#38bdf8'
const DEFAULT_STROKE = '#e6edf3'
const DEFAULT_STROKE_WIDTH = 2

function normalizeHex(value: string, fallback: string): string {
  const parsed = parseHexColor(value)
  return parsed ? formatHexColor(parsed) : fallback
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Right panel with sections; the "Shape" section edits the selected shape of
 * the active keyframe (position, size, rotation, opacity, fill, outline).
 */
export class PropertiesView {
  private readonly empty: HTMLParagraphElement
  private readonly posX: HTMLInputElement
  private readonly posY: HTMLInputElement
  private readonly width: HTMLInputElement
  private readonly height: HTMLInputElement
  private readonly rotation: HTMLInputElement
  private readonly opacity: HTMLInputElement
  private readonly fillColor: HTMLInputElement
  private readonly fillHex: HTMLInputElement
  private readonly strokeToggle: HTMLInputElement
  private readonly strokeColor: HTMLInputElement
  private readonly strokeWidth: HTMLInputElement
  private lastShapeId: string | null = null

  constructor(
    private readonly editor: Editor,
    container: HTMLElement
  ) {
    const scroll = el('div', 'props-scroll')
    const section = el('section', 'panel-section')
    section.appendChild(el('h3', 'panel-section-title', 'Shape'))
    const rows = el('div', 'panel-rows')

    this.empty = el('p', 'panel-empty', 'Select a shape to edit its properties.')

    this.posX = this.numberInput(rows, 'Position', 'x', () => this.applyPosition('x'))
    this.posY = this.numberInput(rows, '', 'y', () => this.applyPosition('y'))
    this.width = this.numberInput(rows, 'Size', 'w', () => this.applySize('width'))
    this.height = this.numberInput(rows, '', 'h', () => this.applySize('height'))
    this.rotation = this.numberInput(rows, 'Rotation', '°', () => this.applyRotation())
    this.opacity = this.numberInput(rows, 'Opacity', '', () => this.applyOpacity())
    this.opacity.min = '0'
    this.opacity.max = '1'
    this.opacity.step = '0.1'

    const fillRow = this.row(rows, 'Fill')
    this.fillColor = el('input', 'color-swatch') as HTMLInputElement
    this.fillColor.type = 'color'
    this.fillColor.title = 'Fill color'
    this.fillHex = el('input', 'hex-input') as HTMLInputElement
    this.fillHex.type = 'text'
    this.fillHex.title = 'Fill color as hex'
    this.fillHex.placeholder = '#rrggbb'
    this.fillColor.addEventListener('input', () => {
      this.editor.updateSelectedShape((shape) => {
        shape.fill = this.fillColor.value
      })
    })
    this.fillHex.addEventListener('change', () => {
      if (parseHexColor(this.fillHex.value)) {
        this.editor.updateSelectedShape((shape) => {
          shape.fill = normalizeHex(this.fillHex.value, DEFAULT_FILL)
        })
      } else {
        this.render()
      }
    })
    fillRow.append(this.fillColor, this.fillHex)

    const outlineRow = this.row(rows, 'Outline')
    this.strokeToggle = el('input', undefined) as HTMLInputElement
    this.strokeToggle.type = 'checkbox'
    this.strokeToggle.title = 'Enable the outline'
    this.strokeToggle.addEventListener('change', () => {
      const enabled = this.strokeToggle.checked
      this.editor.updateSelectedShape((shape) => {
        if (enabled) {
          shape.stroke = shape.stroke ?? DEFAULT_STROKE
          shape.strokeWidth = shape.strokeWidth ?? DEFAULT_STROKE_WIDTH
        } else {
          delete shape.stroke
          delete shape.strokeWidth
        }
      })
      this.render()
    })
    this.strokeColor = el('input', 'color-swatch') as HTMLInputElement
    this.strokeColor.type = 'color'
    this.strokeColor.title = 'Outline color'
    this.strokeColor.addEventListener('input', () => {
      this.editor.updateSelectedShape((shape) => {
        shape.stroke = this.strokeColor.value
      })
    })
    this.strokeWidth = el('input', undefined) as HTMLInputElement
    this.strokeWidth.type = 'number'
    this.strokeWidth.min = '0'
    this.strokeWidth.step = '1'
    this.strokeWidth.title = 'Outline width'
    this.strokeWidth.addEventListener('change', () => {
      const value = Number(this.strokeWidth.value)
      if (!Number.isFinite(value)) {
        this.render()
        return
      }
      this.editor.updateSelectedShape((shape) => {
        shape.strokeWidth = Math.max(0, value)
      })
    })
    outlineRow.append(this.strokeToggle, this.strokeColor, this.strokeWidth)

    section.append(this.empty, rows)
    scroll.appendChild(section)
    container.appendChild(scroll)

    editor.onDocChange(() => this.render())
    editor.onFrameChange(() => this.render())
    editor.onUiChange(() => this.render())
    this.render()
  }

  private row(host: HTMLElement, label: string): HTMLDivElement {
    const row = el('div', 'panel-row')
    row.appendChild(el('label', undefined, label))
    host.appendChild(row)
    return row
  }

  private numberInput(
    host: HTMLElement,
    label: string,
    suffix: string,
    onChange: () => void
  ): HTMLInputElement {
    const row = this.row(host, label)
    if (suffix) row.appendChild(el('span', 'panel-suffix', suffix))
    const input = el('input') as HTMLInputElement
    input.type = 'number'
    input.addEventListener('change', onChange)
    row.appendChild(input)
    return input
  }

  private applyNumber(input: HTMLInputElement, apply: (shape: Shape, value: number) => void): void {
    const value = Number(input.value)
    if (!Number.isFinite(value)) {
      this.render()
      return
    }
    this.editor.updateSelectedShape((shape) => apply(shape, value))
  }

  private applyPosition(axis: 'x' | 'y'): void {
    this.applyNumber(axis === 'x' ? this.posX : this.posY, (shape, value) => {
      if (axis === 'x') shape.center.x = value
      else shape.center.y = value
    })
  }

  private applySize(field: 'width' | 'height'): void {
    this.applyNumber(field === 'width' ? this.width : this.height, (shape, value) => {
      shape[field] = Math.max(2, value)
    })
  }

  private applyRotation(): void {
    this.applyNumber(this.rotation, (shape, value) => {
      shape.rotation = value
    })
  }

  private applyOpacity(): void {
    this.applyNumber(this.opacity, (shape, value) => {
      shape.opacity = Math.min(1, Math.max(0, value))
    })
  }

  render(): void {
    const editor = this.editor
    const shape = this.selectedKeyframeShape()
    const layer = editor.currentLayer
    const editable = shape !== null && layer !== undefined && !layer.locked && layer.visible
    this.empty.classList.toggle('hidden', shape !== null)

    const inputs = [
      this.posX,
      this.posY,
      this.width,
      this.height,
      this.rotation,
      this.opacity,
      this.fillColor,
      this.fillHex,
      this.strokeToggle,
      this.strokeColor,
      this.strokeWidth
    ]
    for (const input of inputs) input.disabled = !editable

    if (!shape) {
      this.lastShapeId = null
      return
    }

    const keepFocused = (input: HTMLInputElement): boolean =>
      document.activeElement === input && this.lastShapeId === shape.id

    if (!keepFocused(this.posX)) this.posX.value = String(round(shape.center.x))
    if (!keepFocused(this.posY)) this.posY.value = String(round(shape.center.y))
    if (!keepFocused(this.width)) this.width.value = String(round(shape.width))
    if (!keepFocused(this.height)) this.height.value = String(round(shape.height))
    if (!keepFocused(this.rotation)) this.rotation.value = String(round(shape.rotation))
    if (!keepFocused(this.opacity)) this.opacity.value = String(shape.opacity)
    const fill = normalizeHex(shape.fill, DEFAULT_FILL)
    if (!keepFocused(this.fillColor)) this.fillColor.value = fill
    if (!keepFocused(this.fillHex)) this.fillHex.value = shape.fill
    const outlined = shape.stroke !== undefined
    if (!keepFocused(this.strokeToggle)) this.strokeToggle.checked = outlined
    if (!keepFocused(this.strokeColor)) {
      this.strokeColor.value = normalizeHex(shape.stroke ?? DEFAULT_STROKE, DEFAULT_STROKE)
    }
    if (!keepFocused(this.strokeWidth)) {
      this.strokeWidth.value = String(shape.strokeWidth ?? DEFAULT_STROKE_WIDTH)
    }
    this.strokeColor.disabled = !editable || !outlined
    this.strokeWidth.disabled = !editable || !outlined
    this.lastShapeId = shape.id
  }

  private selectedKeyframeShape(): Shape | null {
    const editor = this.editor
    if (!editor.selectedShapeId) return null
    const layer = editor.currentLayer
    if (!layer) return null
    const index = findKeyframeIndexForFrame(layer, editor.currentFrame)
    if (index === -1) return null
    return layer.keyframes[index].shapes.find((shape) => shape.id === editor.selectedShapeId) ?? null
  }
}
