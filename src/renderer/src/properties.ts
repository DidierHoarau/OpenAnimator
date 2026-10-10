import { formatHexColor, parseHexColor } from '@shared/color'
import {
  findKeyframeAtFrame,
  findKeyframeIndexForFrame,
  findNearestShapeKeyframeIndex
} from '@shared/document'
import type { EasingName } from '@shared/easing'
import type { Shape } from '@shared/model'

import type { Editor } from './editor'
import { el } from './dom'
import {
  loadSectionState,
  saveSectionState,
  type SectionId,
  type SectionState
} from './sectionState'

const DEFAULT_FILL = '#38bdf8'
const DEFAULT_STROKE = '#e6edf3'
const DEFAULT_STROKE_WIDTH = 2
const EASINGS: EasingName[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out']

function normalizeHex(value: string, fallback: string): string {
  const parsed = parseHexColor(value)
  return parsed ? formatHexColor(parsed) : fallback
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** Collapsible panel section; collapse/expand state is controlled by the owner. */
class PanelSection {
  readonly root: HTMLElement
  private readonly body: HTMLDivElement
  private readonly chevron: HTMLSpanElement

  constructor(title: string, expanded: boolean, onToggle: () => void) {
    this.root = el('section', 'panel-section')
    const header = el('button', 'panel-section-header')
    header.type = 'button'
    header.title = `Collapse or expand the ${title} section`
    header.addEventListener('click', onToggle)
    this.chevron = el('span', 'panel-chevron', expanded ? '▾' : '▸')
    header.append(this.chevron, el('span', 'panel-section-title', title))
    this.body = el('div', 'panel-section-body')
    this.root.append(header, this.body)
    this.root.classList.toggle('collapsed', !expanded)
  }

  get content(): HTMLDivElement {
    return this.body
  }

  setExpanded(expanded: boolean): void {
    this.root.classList.toggle('collapsed', !expanded)
    this.chevron.textContent = expanded ? '▾' : '▸'
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible)
  }
}

/**
 * Right panel with collapsible sections: "Layer" operations on the selected
 * object (keyframe add/remove and tweening at the current frame) and the
 * "Shape" properties of the selected shape. Playback and frame controls live
 * at the top of the timeline; layers and per-object keyframes are managed in
 * the timeline tree (add line, context menu, drag and drop). The "Shape"
 * section only appears while a shape is selected.
 */
export class PropertiesView {
  private readonly editor: Editor
  private readonly sections = new Map<SectionId, PanelSection>()
  private sectionState: SectionState

  private readonly keyframeButton: HTMLButtonElement
  private readonly removeKeyframeButton: HTMLButtonElement
  private readonly tweenButton: HTMLButtonElement
  private readonly easingSelect: HTMLSelectElement

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

  constructor(editor: Editor, container: HTMLElement) {
    this.editor = editor
    this.sectionState = loadSectionState(window.localStorage)

    const scroll = el('div', 'props-scroll')

    // Layer operations on the selected object (keyframe and tween at the current frame).
    const layer = this.createSection('layer', 'Layer')
    const layerButtons = el('div', 'panel-buttons')
    this.keyframeButton = this.button(
      '+ Keyframe',
      'Insert keyframe for the selected object at the current frame (F6)',
      () => editor.insertKeyframeHere()
    )
    this.removeKeyframeButton = this.button(
      '− Keyframe',
      'Remove the keyframe of the selected object at the current frame',
      () => editor.removeKeyframeHere()
    )
    this.tweenButton = this.button(
      'Tween',
      "Toggle a classic tween from the selected object's keyframe at the current frame",
      () => editor.toggleTweenHere()
    )
    this.easingSelect = el('select', 'tl-select') as HTMLSelectElement
    for (const easing of EASINGS) {
      const option = el('option', undefined, easing)
      option.value = easing
      this.easingSelect.appendChild(option)
    }
    this.easingSelect.title = 'Easing of the tween starting at the current keyframe'
    this.easingSelect.addEventListener('change', () => {
      editor.setTweenEasingHere(this.easingSelect.value as EasingName)
    })
    layerButtons.append(this.keyframeButton, this.removeKeyframeButton)
    const tweenRow = el('div', 'panel-buttons')
    tweenRow.append(this.tweenButton, this.easingSelect)
    layer.content.append(layerButtons, tweenRow)

    // Shape properties, visible only while a shape is selected.
    const shape = this.createSection('shape', 'Shape')
    const rows = el('div', 'panel-rows')
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
      editor.ensureSelectedShapeKeyframe()
      editor.updateSelectedShape((current) => {
        current.fill = this.fillColor.value
      })
    })
    this.fillHex.addEventListener('change', () => {
      if (parseHexColor(this.fillHex.value)) {
        editor.ensureSelectedShapeKeyframe()
        editor.updateSelectedShape((current) => {
          current.fill = normalizeHex(this.fillHex.value, DEFAULT_FILL)
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
      editor.ensureSelectedShapeKeyframe()
      editor.updateSelectedShape((current) => {
        if (enabled) {
          current.stroke = current.stroke ?? DEFAULT_STROKE
          current.strokeWidth = current.strokeWidth ?? DEFAULT_STROKE_WIDTH
        } else {
          delete current.stroke
          delete current.strokeWidth
        }
      })
      this.render()
    })
    this.strokeColor = el('input', 'color-swatch') as HTMLInputElement
    this.strokeColor.type = 'color'
    this.strokeColor.title = 'Outline color'
    this.strokeColor.addEventListener('input', () => {
      editor.ensureSelectedShapeKeyframe()
      editor.updateSelectedShape((current) => {
        current.stroke = this.strokeColor.value
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
      editor.ensureSelectedShapeKeyframe()
      editor.updateSelectedShape((current) => {
        current.strokeWidth = Math.max(0, value)
      })
    })
    outlineRow.append(this.strokeToggle, this.strokeColor, this.strokeWidth)
    shape.content.appendChild(rows)

    scroll.append(layer.root, shape.root)
    container.appendChild(scroll)

    editor.onDocChange(() => this.render())
    editor.onFrameChange(() => this.render())
    editor.onUiChange(() => this.render())
    this.render()
  }

  private createSection(id: SectionId, title: string): PanelSection {
    const section = new PanelSection(title, this.sectionState[id], () => this.toggleSection(id))
    this.sections.set(id, section)
    return section
  }

  private toggleSection(id: SectionId): void {
    this.sectionState[id] = !this.sectionState[id]
    saveSectionState(window.localStorage, this.sectionState)
    this.sections.get(id)?.setExpanded(this.sectionState[id])
  }

  private button(title: string, tooltip: string, onClick: () => void): HTMLButtonElement {
    const button = el('button', undefined, title)
    button.title = tooltip
    button.addEventListener('click', onClick)
    return button
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
    this.editor.ensureSelectedShapeKeyframe()
    this.applyNumber(axis === 'x' ? this.posX : this.posY, (shape, value) => {
      if (axis === 'x') shape.center.x = value
      else shape.center.y = value
    })
  }

  private applySize(field: 'width' | 'height'): void {
    this.editor.ensureSelectedShapeKeyframe()
    this.applyNumber(field === 'width' ? this.width : this.height, (shape, value) => {
      shape[field] = Math.max(2, value)
    })
  }

  private applyRotation(): void {
    this.editor.ensureSelectedShapeKeyframe()
    this.applyNumber(this.rotation, (shape, value) => {
      shape.rotation = value
    })
  }

  private applyOpacity(): void {
    this.editor.ensureSelectedShapeKeyframe()
    this.applyNumber(this.opacity, (shape, value) => {
      shape.opacity = Math.min(1, Math.max(0, value))
    })
  }

  render(): void {
    this.renderLayerSection()
    this.renderShapeSection()
  }

  private renderLayerSection(): void {
    const editor = this.editor
    const layer = editor.currentLayer
    const editable = layer !== undefined && !layer.locked
    const selected = editor.selectedShapeId
    // Object-level: the buttons act on the selected object's own keyframe.
    const ownsKeyframe =
      layer !== undefined &&
      selected !== null &&
      editor.hasShapeKeyframeAt(layer.id, selected, editor.currentFrame)
    this.keyframeButton.disabled = !editable || selected === null || ownsKeyframe
    this.removeKeyframeButton.disabled = !editable || !ownsKeyframe
    this.tweenButton.disabled = !editable || !ownsKeyframe
    const keyframe = layer ? findKeyframeAtFrame(layer, editor.currentFrame) : undefined
    this.tweenButton.classList.toggle('active', ownsKeyframe && keyframe?.tween !== undefined)
    this.easingSelect.disabled = !ownsKeyframe || keyframe?.tween === undefined
    if (keyframe?.tween) this.easingSelect.value = keyframe.tween.easing
  }

  private renderShapeSection(): void {
    const editor = this.editor
    const shape = this.selectedShapePose()
    const layer = editor.currentLayer
    const editable = shape !== null && layer !== undefined && !layer.locked && layer.visible
    this.sections.get('shape')?.setVisible(shape !== null)
    if (!shape) {
      this.lastShapeId = null
      return
    }

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

  /**
   * Pose shown for the selected shape: the one in the keyframe active at the
   * current frame when present, otherwise its nearest existing pose (e.g. a
   * shape picked from the timeline tree that only exists in another keyframe).
   * The first edit materialises the pose at the current frame via auto-key.
   */
  private selectedShapePose(): Shape | null {
    const editor = this.editor
    if (!editor.selectedShapeId) return null
    const layer = editor.currentLayer
    if (!layer) return null
    const activeIndex = findKeyframeIndexForFrame(layer, editor.currentFrame)
    if (activeIndex !== -1) {
      const shape = layer.keyframes[activeIndex].shapes.find(
        (shape) => shape.id === editor.selectedShapeId
      )
      if (shape) return shape
    }
    const nearestIndex = findNearestShapeKeyframeIndex(
      layer,
      editor.selectedShapeId,
      editor.currentFrame
    )
    if (nearestIndex === -1) return null
    return (
      layer.keyframes[nearestIndex].shapes.find(
        (shape) => shape.id === editor.selectedShapeId
      ) ?? null
    )
  }
}
