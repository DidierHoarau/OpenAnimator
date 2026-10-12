import { MAX_GRADIENT_STOPS, MIN_GRADIENT_STOPS, createDefaultGradientPaint } from '@shared/paint'
import type { GradientStop, Paint } from '@shared/paint'

import { el } from './dom'

export interface GradientEditorCallbacks {
  /** Applies a replacement paint (called on every edit). */
  onApply: (paint: Paint) => void
  /** Opens a coalesced interaction around a color-picker drag. */
  onDragStart: () => void
  onDragEnd: () => void
}

type PaintKind = 'solid' | 'linear' | 'radial'

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Reusable paint editor widget: a Solid/Linear/Radial kind select plus — for
 * gradients — the geometry inputs (angle for linear, center/radius for
 * radial) and the stop list (color, offset, opacity, add/remove). Every edit
 * applies immediately through `onApply`; stop-color picker drags are
 * coalesced into one undo entry through `onDragStart`/`onDragEnd`. Stop rows
 * are rebuilt only when the kind, the stop count or a stop opacity changes,
 * so the color input being dragged survives the re-renders its own edits
 * trigger.
 */
export class GradientEditor {
  readonly root: HTMLDivElement

  private readonly kindSelect: HTMLSelectElement
  private readonly gradientRows: HTMLDivElement
  private readonly angleRow: HTMLDivElement
  private readonly angleInput: HTMLInputElement
  private readonly centerRow: HTMLDivElement
  private readonly centerXInput: HTMLInputElement
  private readonly centerYInput: HTMLInputElement
  private readonly radiusRow: HTMLDivElement
  private readonly radiusInput: HTMLInputElement
  private readonly stopsHost: HTMLDivElement
  private readonly addStopButton: HTMLButtonElement
  private readonly callbacks: GradientEditorCallbacks

  private kind: PaintKind = 'solid'
  private solidColor = '#38bdf8'
  private angle = 90
  private center = { cx: 0.5, cy: 0.5 }
  private radius = 0.5
  private stops: GradientStop[] = []
  private structureKey = ''
  private disabled = false
  private stopInteracting = false

  constructor(callbacks: GradientEditorCallbacks) {
    this.callbacks = callbacks
    this.root = el('div', 'gradient-editor')

    const kindRow = el('div', 'panel-row')
    kindRow.appendChild(el('label', undefined, 'Paint'))
    this.kindSelect = el('select', 'tl-select') as HTMLSelectElement
    for (const [value, label] of [
      ['solid', 'Solid'],
      ['linear', 'Linear gradient'],
      ['radial', 'Radial gradient']
    ] as const) {
      const option = el('option', undefined, label)
      option.value = value
      this.kindSelect.appendChild(option)
    }
    this.kindSelect.title = 'Paint type: a flat color or a gradient with 2–8 stops'
    this.kindSelect.addEventListener('change', () => this.onKindChange())
    kindRow.appendChild(this.kindSelect)
    this.root.appendChild(kindRow)

    this.angleRow = el('div', 'panel-row')
    this.angleRow.appendChild(el('label', undefined, 'Angle'))
    this.angleRow.appendChild(el('span', 'panel-suffix', '°'))
    this.angleInput = el('input') as HTMLInputElement
    this.angleInput.type = 'number'
    this.angleInput.step = '5'
    this.angleInput.title = 'Gradient direction in degrees (0 = left→right, positive clockwise)'
    this.angleInput.addEventListener('change', () => {
      const value = Number(this.angleInput.value)
      if (!Number.isFinite(value)) {
        this.syncValues()
        return
      }
      this.angle = value
      this.applyGradient()
    })
    this.angleRow.appendChild(this.angleInput)

    this.centerRow = el('div', 'panel-row')
    this.centerRow.appendChild(el('label', undefined, 'Center'))
    this.centerXInput = el('input') as HTMLInputElement
    this.centerXInput.type = 'number'
    this.centerXInput.step = '0.05'
    this.centerXInput.title = 'Radial center X as a fraction of the bounding box'
    this.centerYInput = el('input') as HTMLInputElement
    this.centerYInput.type = 'number'
    this.centerYInput.step = '0.05'
    this.centerYInput.title = 'Radial center Y as a fraction of the bounding box'
    for (const input of [this.centerXInput, this.centerYInput]) {
      input.addEventListener('change', () => {
        const x = Number(this.centerXInput.value)
        const y = Number(this.centerYInput.value)
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          this.syncValues()
          return
        }
        this.center = { cx: x, cy: y }
        this.applyGradient()
      })
    }
    this.centerRow.append(this.centerXInput, this.centerYInput)

    this.radiusRow = el('div', 'panel-row')
    this.radiusRow.appendChild(el('label', undefined, 'Radius'))
    this.radiusInput = el('input') as HTMLInputElement
    this.radiusInput.type = 'number'
    this.radiusInput.step = '0.05'
    this.radiusInput.title = 'Radial radius as a fraction of the bounding box (0.5 reaches the box edge)'
    this.radiusInput.addEventListener('change', () => {
      const value = Number(this.radiusInput.value)
      if (!Number.isFinite(value)) {
        this.syncValues()
        return
      }
      this.radius = Math.max(0, value)
      this.applyGradient()
    })
    this.radiusRow.appendChild(this.radiusInput)

    this.stopsHost = el('div', 'gradient-stops')
    const stopActions = el('div', 'panel-buttons')
    this.addStopButton = el('button', undefined, '+ Stop') as HTMLButtonElement
    this.addStopButton.type = 'button'
    this.addStopButton.title = `Add a gradient stop (up to ${MAX_GRADIENT_STOPS})`
    this.addStopButton.addEventListener('click', () => this.addStop())
    stopActions.appendChild(this.addStopButton)

    this.gradientRows = el('div', 'gradient-rows')
    this.gradientRows.append(
      this.angleRow,
      this.centerRow,
      this.radiusRow,
      this.stopsHost,
      stopActions
    )
    this.root.appendChild(this.gradientRows)
  }

  /** Syncs the widget with the paint of the active target. */
  setValue(paint: Paint, editable: boolean): void {
    this.disabled = !editable
    if (typeof paint === 'string') {
      this.kind = 'solid'
      this.solidColor = paint
    } else {
      this.kind = paint.type
      this.stops = paint.stops.map((stop) => ({ ...stop })).sort((a, b) => a.offset - b.offset)
      if (paint.type === 'linear') {
        this.angle = paint.angle
      } else {
        this.center = { cx: paint.cx, cy: paint.cy }
        this.radius = paint.r
      }
    }
    const key =
      this.kind === 'solid'
        ? 'solid'
        : `${this.kind}|${this.stops.length}|${this.stops.map((stop) => stop.alpha ?? 1).join(',')}`
    if (key !== this.structureKey) {
      this.structureKey = key
      this.rebuildStructure()
    }
    this.syncValues()
  }

  private rebuildStructure(): void {
    const gradient = this.kind !== 'solid'
    this.gradientRows.classList.toggle('hidden', !gradient)
    this.angleRow.classList.toggle('hidden', this.kind !== 'linear')
    this.centerRow.classList.toggle('hidden', this.kind !== 'radial')
    this.radiusRow.classList.toggle('hidden', this.kind !== 'radial')
    this.rebuildStops()
  }

  private rebuildStops(): void {
    while (this.stopsHost.firstChild) this.stopsHost.removeChild(this.stopsHost.firstChild)
    this.stops.forEach((_stop, index) => {
      const row = el('div', 'panel-row gradient-stop')
      row.appendChild(el('label', undefined, index === 0 ? 'Stops' : ''))

      const color = el('input', 'color-swatch') as HTMLInputElement
      color.type = 'color'
      color.title = 'Stop color'
      color.addEventListener('input', () => {
        if (!this.stopInteracting) {
          this.stopInteracting = true
          this.callbacks.onDragStart()
        }
        this.updateStop(index, (current) => {
          current.color = color.value
        })
        this.applyGradient()
      })
      const endDrag = (): void => {
        if (this.stopInteracting) {
          this.stopInteracting = false
          this.callbacks.onDragEnd()
        }
      }
      color.addEventListener('change', endDrag)
      color.addEventListener('cancel', endDrag)

      const offset = el('input') as HTMLInputElement
      offset.type = 'number'
      offset.min = '0'
      offset.max = '1'
      offset.step = '0.05'
      offset.title = 'Stop position along the gradient (0..1)'
      offset.addEventListener('change', () => {
        const value = Number(offset.value)
        if (!Number.isFinite(value)) {
          this.syncValues()
          return
        }
        const clamped = Math.min(1, Math.max(0, value))
        this.updateStop(index, (current) => {
          current.offset = clamped
        })
        this.applyGradient()
      })

      const alpha = el('input', 'gradient-stop-alpha') as HTMLInputElement
      alpha.type = 'number'
      alpha.min = '0'
      alpha.max = '1'
      alpha.step = '0.05'
      alpha.placeholder = '1'
      alpha.title = 'Stop opacity (0..1; blank or 1 = fully opaque)'
      alpha.addEventListener('change', () => {
        if (alpha.value.trim() === '') {
          this.updateStop(index, (current) => {
            delete current.alpha
          })
          this.applyGradient()
          return
        }
        const value = Number(alpha.value)
        if (!Number.isFinite(value)) {
          this.syncValues()
          return
        }
        const clamped = Math.min(1, Math.max(0, value))
        this.updateStop(index, (current) => {
          if (clamped === 1) delete current.alpha
          else current.alpha = clamped
        })
        this.applyGradient()
      })

      const remove = el('button', 'gradient-stop-remove', '✕') as HTMLButtonElement
      remove.type = 'button'
      remove.title = `Remove this stop (at least ${MIN_GRADIENT_STOPS} are required)`
      remove.disabled = this.disabled || this.stops.length <= MIN_GRADIENT_STOPS
      remove.addEventListener('click', () => this.removeStop(index))

      row.append(color, offset, alpha, remove)
      this.stopsHost.appendChild(row)
    })
  }

  private syncValues(): void {
    const focused = document.activeElement
    if (focused !== this.kindSelect) this.kindSelect.value = this.kind
    if (focused !== this.angleInput) this.angleInput.value = String(round(this.angle))
    if (focused !== this.centerXInput) this.centerXInput.value = String(round(this.center.cx))
    if (focused !== this.centerYInput) this.centerYInput.value = String(round(this.center.cy))
    if (focused !== this.radiusInput) this.radiusInput.value = String(round(this.radius))
    this.kindSelect.disabled = this.disabled
    this.angleInput.disabled = this.disabled
    this.centerXInput.disabled = this.disabled
    this.centerYInput.disabled = this.disabled
    this.radiusInput.disabled = this.disabled
    this.addStopButton.disabled = this.disabled || this.stops.length >= MAX_GRADIENT_STOPS
    const rows = Array.from(this.stopsHost.querySelectorAll<HTMLElement>('.gradient-stop'))
    rows.forEach((row, index) => {
      const stop = this.stops[index]
      if (!stop) return
      const color = row.querySelector<HTMLInputElement>('input[type="color"]')
      const offset = row.querySelector<HTMLInputElement>('input[type="number"]')
      const alpha = row.querySelector<HTMLInputElement>('.gradient-stop-alpha')
      const remove = row.querySelector<HTMLButtonElement>('button')
      if (color && focused !== color) color.value = stop.color
      if (offset && focused !== offset) offset.value = String(round(stop.offset))
      if (alpha && focused !== alpha) {
        alpha.value = stop.alpha !== undefined ? String(round(stop.alpha)) : ''
      }
      if (remove) remove.disabled = this.disabled || this.stops.length <= MIN_GRADIENT_STOPS
    })
  }

  private updateStop(index: number, update: (stop: GradientStop) => void): void {
    const stop = this.stops[index]
    if (stop) update(stop)
  }

  private primaryColor(): string {
    if (this.kind === 'solid') return this.solidColor
    return this.stops[0]?.color ?? this.solidColor
  }

  private onKindChange(): void {
    const next = this.kindSelect.value as PaintKind
    if (next === this.kind) return
    if (next === 'solid') {
      // Back to a flat color: the primary stop (or the last solid color).
      this.callbacks.onApply(this.primaryColor())
      return
    }
    const base = createDefaultGradientPaint(next, this.primaryColor())
    if (this.kind !== 'solid') {
      base.stops = this.stops.map((stop) => ({ ...stop }))
    }
    this.callbacks.onApply(base)
  }

  private addStop(): void {
    if (this.stops.length >= MAX_GRADIENT_STOPS) return
    const last = this.stops[this.stops.length - 1]
    const beforeLast = this.stops[this.stops.length - 2]
    const offset = round((beforeLast.offset + last.offset) / 2)
    const inserted: GradientStop = { offset, color: last.color }
    if (last.alpha !== undefined) inserted.alpha = last.alpha
    this.stops = [...this.stops.slice(0, -1), inserted, last]
    this.applyGradient()
  }

  private removeStop(index: number): void {
    if (this.stops.length <= MIN_GRADIENT_STOPS) return
    this.stops = this.stops.filter((_, current) => current !== index)
    this.applyGradient()
  }

  private applyGradient(): void {
    const stops = this.stops.map((stop) => ({ ...stop }))
    if (this.kind === 'linear') {
      this.callbacks.onApply({ type: 'linear', angle: this.angle, stops })
    } else if (this.kind === 'radial') {
      this.callbacks.onApply({
        type: 'radial',
        cx: this.center.cx,
        cy: this.center.cy,
        r: this.radius,
        stops
      })
    }
  }
}
