import { formatHexColor, parseHexColor } from '@shared/color'
import {
  evaluateLayerAtFrame,
  findKeyframeAtFrame,
  findKeyframeIndexForFrame
} from '@shared/document'
import type { EasingName } from '@shared/easing'
import type { Layer, Shape } from '@shared/model'

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
const SHAPE_KIND_LABELS: Record<Shape['kind'], string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse'
}

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
 * Right panel with collapsible sections: the "Layer Explorer" tree (layers and
 * their shapes at the current frame), the "Layer" operations (keyframes,
 * frames, tweening, layer add/remove), the "Playback" controls and the "Shape"
 * properties of the selected shape. Sections react to the editor state: the
 * "Shape" section only appears while a shape is selected.
 */
export class PropertiesView {
  private readonly editor: Editor
  private readonly sections = new Map<SectionId, PanelSection>()
  private sectionState: SectionState

  private readonly explorerBody: HTMLDivElement
  private readonly keyframeButton: HTMLButtonElement
  private readonly blankKeyframeButton: HTMLButtonElement
  private readonly frameButton: HTMLButtonElement
  private readonly removeKeyframeButton: HTMLButtonElement
  private readonly tweenButton: HTMLButtonElement
  private readonly easingSelect: HTMLSelectElement
  private readonly addLayerButton: HTMLButtonElement
  private readonly removeLayerButton: HTMLButtonElement
  private readonly playButton: HTMLButtonElement
  private readonly loopButton: HTMLButtonElement
  private readonly fpsInput: HTMLInputElement

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

    // Layer Explorer: layers with their shapes at the current frame.
    const explorer = this.createSection('explorer', 'Layer Explorer')
    this.explorerBody = el('div', 'explorer-tree')
    explorer.content.appendChild(this.explorerBody)

    // Layer operations (keyframes, frames, tween, layers).
    const layer = this.createSection('layer', 'Layer')
    const layerButtons = el('div', 'panel-buttons')
    this.keyframeButton = this.button('+ Keyframe', 'Insert keyframe at the current frame (F6)', () =>
      editor.insertKeyframeHere()
    )
    this.blankKeyframeButton = this.button(
      '+ Blank Keyframe',
      'Insert blank keyframe at the current frame (F7)',
      () => editor.insertBlankKeyframeHere()
    )
    this.frameButton = this.button('+ Frame', 'Insert frame to extend the hold (F5)', () =>
      editor.insertFrameHere()
    )
    this.removeKeyframeButton = this.button(
      '− Keyframe',
      'Remove the keyframe at the current frame',
      () => editor.removeKeyframeHere()
    )
    this.tweenButton = this.button(
      'Tween',
      'Toggle a classic tween from the current keyframe',
      () => editor.toggleTweenHere()
    )
    this.tweenButton.classList.add('tl-toggle')
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
    this.addLayerButton = this.button('+ Layer', 'Add a layer on top', () => editor.addLayerOnTop())
    this.removeLayerButton = this.button('− Layer', 'Remove the current layer', () =>
      editor.removeCurrentLayer()
    )
    layerButtons.append(
      this.keyframeButton,
      this.blankKeyframeButton,
      this.frameButton,
      this.removeKeyframeButton
    )
    const tweenRow = el('div', 'panel-buttons')
    tweenRow.append(this.tweenButton, this.easingSelect)
    const layerRow = el('div', 'panel-buttons')
    layerRow.append(this.addLayerButton, this.removeLayerButton)
    layer.content.append(layerButtons, tweenRow, layerRow)

    // Playback controls.
    const playback = this.createSection('playback', 'Playback')
    const playbackButtons = el('div', 'panel-buttons')
    this.playButton = this.button('Play', 'Play or pause playback (Space)', () => editor.togglePlay())
    const stopButton = this.button('Stop', 'Stop playback and return to frame 1 (Escape)', () =>
      editor.stopPlayback()
    )
    this.loopButton = this.button('Loop', 'Toggle looped playback', () => editor.toggleLoop())
    this.loopButton.classList.add('tl-toggle')
    playbackButtons.append(this.playButton, stopButton, this.loopButton)
    const fpsRow = el('div', 'panel-buttons')
    const fpsLabel = el('span', 'panel-suffix', 'fps')
    this.fpsInput = el('input', 'tl-number') as HTMLInputElement
    this.fpsInput.type = 'number'
    this.fpsInput.min = '1'
    this.fpsInput.max = '120'
    this.fpsInput.title = 'Frames per second'
    this.fpsInput.addEventListener('change', () => editor.setFps(Number(this.fpsInput.value)))
    fpsRow.append(fpsLabel, this.fpsInput)
    playback.content.append(playbackButtons, fpsRow)

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
      editor.updateSelectedShape((current) => {
        current.fill = this.fillColor.value
      })
    })
    this.fillHex.addEventListener('change', () => {
      if (parseHexColor(this.fillHex.value)) {
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
      editor.updateSelectedShape((current) => {
        current.strokeWidth = Math.max(0, value)
      })
    })
    outlineRow.append(this.strokeToggle, this.strokeColor, this.strokeWidth)
    shape.content.appendChild(rows)

    scroll.append(explorer.root, layer.root, playback.root, shape.root)
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
    this.renderExplorer()
    this.renderLayerSection()
    this.renderPlaybackSection()
    this.renderShapeSection()
  }

  private renderExplorer(): void {
    const editor = this.editor
    this.explorerBody.textContent = ''
    for (const layer of editor.document.layers) {
      this.explorerBody.appendChild(this.buildLayerNode(layer))
    }
  }

  private buildLayerNode(layer: Layer): HTMLElement {
    const editor = this.editor
    const node = el('div', 'explorer-layer')
    if (layer.id === editor.currentLayerId) node.classList.add('current')

    const row = el('div', 'explorer-row')
    row.dataset.layerId = layer.id
    row.title = layer.locked ? `${layer.name} (locked)` : layer.name
    const visibilityButton = el('button', 'tl-icon', layer.visible ? '◉' : '○')
    visibilityButton.title = layer.visible ? 'Hide layer' : 'Show layer'
    visibilityButton.addEventListener('click', (event) => {
      event.stopPropagation()
      editor.toggleLayerVisibility(layer.id)
    })
    const lockButton = el('button', 'tl-icon', layer.locked ? 'L' : '·')
    lockButton.title = layer.locked ? 'Unlock layer' : 'Lock layer'
    lockButton.classList.toggle('active', layer.locked)
    lockButton.addEventListener('click', (event) => {
      event.stopPropagation()
      editor.toggleLayerLock(layer.id)
    })
    const name = el('span', 'explorer-name', layer.name)
    const count = el(
      'span',
      'explorer-meta',
      `${layer.keyframes.length} key${layer.keyframes.length === 1 ? '' : 's'}`
    )
    row.append(visibilityButton, lockButton, name, count)
    row.addEventListener('click', () => editor.setCurrentLayer(layer.id))
    node.appendChild(row)

    const shapes = evaluateLayerAtFrame(layer, editor.currentFrame)
    if (shapes.length === 0) {
      const hint = el('div', 'explorer-row explorer-child explorer-empty', 'no shapes')
      node.appendChild(hint)
      return node
    }
    for (const shape of shapes) {
      const child = el('div', 'explorer-row explorer-child')
      child.dataset.layerId = layer.id
      child.dataset.shapeId = shape.id
      if (editor.selectedShapeId === shape.id) child.classList.add('selected')
      const swatch = el('span', 'explorer-swatch')
      swatch.style.background = shape.fill
      const label = el('span', 'explorer-name', SHAPE_KIND_LABELS[shape.kind])
      child.append(swatch, label)
      child.addEventListener('click', () => {
        editor.setCurrentLayer(layer.id)
        editor.selectShape(shape.id)
      })
      node.appendChild(child)
    }
    return node
  }

  private renderLayerSection(): void {
    const editor = this.editor
    const layer = editor.currentLayer
    const editable = layer !== undefined && !layer.locked
    const keyframe = layer ? findKeyframeAtFrame(layer, editor.currentFrame) : undefined
    this.keyframeButton.disabled = !editable || keyframe !== undefined
    this.blankKeyframeButton.disabled = !editable || keyframe !== undefined
    this.frameButton.disabled = !editable
    this.removeKeyframeButton.disabled = !editable || keyframe === undefined
    this.tweenButton.disabled = !editable || keyframe === undefined
    this.tweenButton.classList.toggle('active', keyframe?.tween !== undefined)
    this.easingSelect.disabled = keyframe?.tween === undefined
    if (keyframe?.tween) this.easingSelect.value = keyframe.tween.easing
    this.removeLayerButton.disabled = editor.document.layers.length <= 1
  }

  private renderPlaybackSection(): void {
    const editor = this.editor
    this.playButton.textContent = editor.playing ? 'Pause' : 'Play'
    this.loopButton.classList.toggle('active', editor.loop)
    if (document.activeElement !== this.fpsInput) this.fpsInput.value = String(editor.document.fps)
  }

  private renderShapeSection(): void {
    const editor = this.editor
    const shape = this.selectedKeyframeShape()
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
