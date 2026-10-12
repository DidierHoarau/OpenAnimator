import type { CubicBezierEasing, Easing, EasingName, EasingPreset } from '@shared/easing'
import { EASING_PRESETS, canonicalBezierFor } from '@shared/easing'
import { cubicBezierPoint } from '@shared/motionPath'
import { el } from './dom'

const CANVAS_SIZE = 160
const PADDING = 10
/** Vertical data range shown by the plot (overshoot stays visible). */
const VIEW_MIN_Y = -1
const VIEW_MAX_Y = 2
/** Input clamps: x stays in [0, 1] for solver monotonicity, y may overshoot. */
const X_MIN = 0
const X_MAX = 1
const Y_MIN = -2
const Y_MAX = 3
/** Handle pick radius, in data units (the x axis spans [0, 1]). */
const HANDLE_HIT = 0.12
const CURVE_SAMPLES = 48
const EPSILON = 1e-6

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function sameBezier(a: CubicBezierEasing, b: CubicBezierEasing): boolean {
  return (
    Math.abs(a.x1 - b.x1) < EPSILON &&
    Math.abs(a.y1 - b.y1) < EPSILON &&
    Math.abs(a.x2 - b.x2) < EPSILON &&
    Math.abs(a.y2 - b.y2) < EPSILON
  )
}

function readField(input: HTMLInputElement, fallback: number): number {
  const text = input.value.trim()
  if (text === '') return fallback
  const value = Number(text)
  return Number.isFinite(value) ? value : fallback
}

export interface EasingEditorEvents {
  /** Every picked easing (preset pick or numeric input change). */
  onChange: (easing: Easing) => void
  /** Canvas drag lifetime so the host coalesces it into one undo entry. */
  onDragStart?: () => void
  onDragEnd?: () => void
}

/**
 * Cubic-bezier easing widget: a preset `<select>`, a canvas plot of the unit
 * curve with two draggable control handles, and the numeric x1/y1/x2/y2
 * inputs. When `getContext('2d')` is unavailable (happy-dom) the plot is
 * skipped entirely, leaving the select and the inputs as the whole widget.
 * Preset picks emit the named easing when the preset is one; input changes
 * and handle drags emit `{x1, y1, x2, y2}` bezier objects.
 */
export class EasingEditor {
  readonly root: HTMLDivElement
  private readonly events: EasingEditorEvents
  private readonly presetSelect: HTMLSelectElement
  private readonly canvas: HTMLCanvasElement | null = null
  private readonly context: CanvasRenderingContext2D | null = null
  private readonly x1Input: HTMLInputElement
  private readonly y1Input: HTMLInputElement
  private readonly x2Input: HTMLInputElement
  private readonly y2Input: HTMLInputElement
  private value: CubicBezierEasing = canonicalBezierFor('linear')
  private named: EasingName | null = 'linear'
  private drag: { handle: 'c1' | 'c2'; started: boolean } | null = null

  constructor(events: EasingEditorEvents) {
    this.events = events
    this.root = el('div', 'easing-editor')

    this.presetSelect = el('select', 'easing-editor__preset')
    this.presetSelect.title = 'Easing preset of the tween starting at the current keyframe'
    for (const preset of EASING_PRESETS) {
      const option = el('option', undefined, preset.label)
      option.value = preset.id
      this.presetSelect.appendChild(option)
    }
    const custom = el('option', undefined, 'Custom')
    custom.value = 'custom'
    this.presetSelect.appendChild(custom)
    this.presetSelect.addEventListener('change', () => this.onPresetPick())

    const canvas = document.createElement('canvas')
    canvas.className = 'easing-editor__canvas'
    canvas.width = CANVAS_SIZE
    canvas.height = CANVAS_SIZE
    canvas.title = 'Drag the two control handles to shape the curve'
    const context = canvas.getContext('2d')
    if (context) {
      this.canvas = canvas
      this.context = context
      canvas.addEventListener('pointerdown', (event) => this.onCanvasPointerDown(event))
      canvas.addEventListener('pointermove', (event) => this.onCanvasPointerMove(event))
      canvas.addEventListener('pointerup', () => this.finishDrag())
      canvas.addEventListener('pointercancel', () => this.finishDrag())
    }

    this.x1Input = this.numberField('x1', 'x of the first control point (0–1)')
    this.y1Input = this.numberField('y1', 'y of the first control point (−2–3)')
    this.x2Input = this.numberField('x2', 'x of the second control point (0–1)')
    this.y2Input = this.numberField('y2', 'y of the second control point (−2–3)')
    const fields = el('div', 'easing-editor__fields')
    fields.append(this.x1Input, this.y1Input, this.x2Input, this.y2Input)

    this.root.appendChild(this.presetSelect)
    if (this.canvas) this.root.appendChild(this.canvas)
    this.root.appendChild(fields)
    this.sync()
  }

  /** Syncs the widget from an evaluated tween easing; never fires onChange. */
  setValue(easing: Easing): void {
    if (typeof easing === 'string') {
      this.named = easing
      this.value = canonicalBezierFor(easing)
    } else {
      this.named = null
      this.value = { ...easing }
    }
    this.sync()
  }

  /** Enables or disables the whole widget (no tween at the playhead). */
  setDisabled(disabled: boolean): void {
    this.presetSelect.disabled = disabled
    for (const input of this.inputs()) input.disabled = disabled
    this.root.classList.toggle('disabled', disabled)
    if (this.canvas) this.canvas.style.pointerEvents = disabled ? 'none' : ''
  }

  private inputs(): HTMLInputElement[] {
    return [this.x1Input, this.y1Input, this.x2Input, this.y2Input]
  }

  private numberField(field: string, title: string): HTMLInputElement {
    const input = el('input', 'easing-editor__input')
    input.type = 'number'
    input.step = '0.01'
    input.title = title
    input.dataset.field = field
    input.addEventListener('change', () => this.readInputs())
    return input
  }

  private readInputs(): void {
    const current = this.value
    this.value = {
      x1: clamp(readField(this.x1Input, current.x1), X_MIN, X_MAX),
      y1: clamp(readField(this.y1Input, current.y1), Y_MIN, Y_MAX),
      x2: clamp(readField(this.x2Input, current.x2), X_MIN, X_MAX),
      y2: clamp(readField(this.y2Input, current.y2), Y_MIN, Y_MAX)
    }
    this.named = null
    this.sync(true)
    this.events.onChange({ ...this.value })
  }

  private onPresetPick(): void {
    const picked = EASING_PRESETS.find((preset) => preset.id === this.presetSelect.value)
    if (!picked) {
      // 'Custom' is a display state, not a value: restore the previous pick.
      this.sync()
      return
    }
    this.named = picked.named ?? null
    this.value = { ...picked.bezier }
    this.sync(true)
    this.events.onChange(picked.named ?? { ...picked.bezier })
  }

  /** The preset shown as selected; `null` means the Custom option. */
  private matchingPreset(): EasingPreset | null {
    if (this.named) {
      return EASING_PRESETS.find((preset) => preset.named === this.named) ?? null
    }
    return EASING_PRESETS.find((preset) => sameBezier(preset.bezier, this.value)) ?? null
  }

  private sync(forceFields = false): void {
    const value = this.value
    const fields: [HTMLInputElement, number][] = [
      [this.x1Input, value.x1],
      [this.y1Input, value.y1],
      [this.x2Input, value.x2],
      [this.y2Input, value.y2]
    ]
    for (const [input, component] of fields) {
      if (forceFields || document.activeElement !== input) input.value = String(round3(component))
    }
    const preset = this.matchingPreset()
    this.presetSelect.value = preset ? preset.id : 'custom'
    this.draw()
  }

  /** Canvas-space x of a data-space x (0–1 across the plot). */
  private toCanvasX(x: number): number {
    const plot = CANVAS_SIZE - PADDING * 2
    return PADDING + clamp(x, 0, 1) * plot
  }

  /** Canvas-space y of a data-space y, clamped into the plot rect. */
  private toCanvasY(y: number): number {
    const plot = CANVAS_SIZE - PADDING * 2
    const ratio = (VIEW_MAX_Y - y) / (VIEW_MAX_Y - VIEW_MIN_Y)
    return PADDING + clamp(ratio, 0, 1) * plot
  }

  /** Data-space point under a canvas pointer event (x clamped to [0, 1]). */
  private pointerData(event: PointerEvent): { x: number; y: number } {
    const canvas = this.canvas as HTMLCanvasElement
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / Math.max(1, rect.width)
    const scaleY = canvas.height / Math.max(1, rect.height)
    const px = (event.clientX - rect.left) * scaleX
    const py = (event.clientY - rect.top) * scaleY
    const plot = CANVAS_SIZE - PADDING * 2
    const x = clamp((px - PADDING) / plot, 0, 1)
    const y = VIEW_MAX_Y - clamp((py - PADDING) / plot, 0, 1) * (VIEW_MAX_Y - VIEW_MIN_Y)
    return { x, y: clamp(y, Y_MIN, Y_MAX) }
  }

  private onCanvasPointerDown(event: PointerEvent): void {
    if (!this.canvas) return
    const point = this.pointerData(event)
    const toFirst = Math.hypot(point.x - this.value.x1, point.y - this.value.y1)
    const toSecond = Math.hypot(point.x - this.value.x2, point.y - this.value.y2)
    if (Math.min(toFirst, toSecond) > HANDLE_HIT) return
    this.drag = { handle: toFirst <= toSecond ? 'c1' : 'c2', started: false }
    this.canvas.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  private onCanvasPointerMove(event: PointerEvent): void {
    const drag = this.drag
    if (!drag) return
    const point = this.pointerData(event)
    const next: CubicBezierEasing = { ...this.value }
    if (drag.handle === 'c1') {
      next.x1 = round3(point.x)
      next.y1 = round3(point.y)
    } else {
      next.x2 = round3(point.x)
      next.y2 = round3(point.y)
    }
    if (sameBezier(next, this.value)) return
    if (!drag.started) {
      // Open the host interaction only once the drag actually changes the
      // value, so a plain click never leaves an undo entry.
      drag.started = true
      this.events.onDragStart?.()
    }
    this.value = next
    this.named = null
    this.sync(true)
    this.events.onChange({ ...next })
    event.preventDefault()
  }

  private finishDrag(): void {
    if (this.drag?.started) this.events.onDragEnd?.()
    this.drag = null
  }

  /** Paints the unit curve, the handle stems and the two handle dots. */
  private draw(): void {
    const context = this.context
    if (!context) return
    const plot = CANVAS_SIZE - PADDING * 2
    context.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    context.strokeStyle = '#3d4759'
    context.lineWidth = 1
    context.strokeRect(PADDING, PADDING, plot, plot)
    context.beginPath()
    context.moveTo(this.toCanvasX(0), this.toCanvasY(0))
    context.lineTo(this.toCanvasX(1), this.toCanvasY(1))
    context.stroke()

    const value = this.value
    context.strokeStyle = '#38bdf8'
    context.lineWidth = 2
    context.beginPath()
    for (let sample = 0; sample <= CURVE_SAMPLES; sample++) {
      const point = cubicBezierPoint(
        { x: 0, y: 0 },
        { x: value.x1, y: value.y1 },
        { x: value.x2, y: value.y2 },
        { x: 1, y: 1 },
        sample / CURVE_SAMPLES
      )
      if (sample === 0) context.moveTo(this.toCanvasX(point.x), this.toCanvasY(point.y))
      else context.lineTo(this.toCanvasX(point.x), this.toCanvasY(point.y))
    }
    context.stroke()

    context.strokeStyle = '#94a3b8'
    context.lineWidth = 1
    context.beginPath()
    context.moveTo(this.toCanvasX(0), this.toCanvasY(0))
    context.lineTo(this.toCanvasX(value.x1), this.toCanvasY(value.y1))
    context.moveTo(this.toCanvasX(1), this.toCanvasY(1))
    context.lineTo(this.toCanvasX(value.x2), this.toCanvasY(value.y2))
    context.stroke()

    context.fillStyle = '#e2e8f0'
    context.beginPath()
    context.arc(this.toCanvasX(value.x1), this.toCanvasY(value.y1), 4, 0, Math.PI * 2)
    context.fill()
    context.beginPath()
    context.arc(this.toCanvasX(value.x2), this.toCanvasY(value.y2), 4, 0, Math.PI * 2)
    context.fill()
  }
}
