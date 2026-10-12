import { formatHexColor, parseHexColor } from '@shared/color'
import {
  cellRangeAtFrame,
  findKeyframeAtFrame,
  findKeyframeIndexForFrame,
  findNearestNodeKeyframeIndex,
  findNextCellFrame,
  findPreviousCellFrame
} from '@shared/document'
import type { CellRange } from '@shared/document'
import { isDrawingLayer, isObjectLayer } from '@shared/model'
import type { ImageNode, SceneNode } from '@shared/model'
import { pathDataToAnchors } from '@shared/pathModel'
import { applyTextMetrics } from '@shared/textModel'

import type { Editor } from './editor'
import { el } from './dom'
import { EasingEditor } from './easingEditor'
import type { ImageImportDeps } from './imageImport'
import { pickImageFile, prepareImageResource } from './imageImport'
import { convertSelectedTextToOutlines } from './textOutlines'
import {
  loadSectionState,
  saveSectionState,
  type SectionId,
  type SectionState
} from './sectionState'

const DEFAULT_FILL = '#38bdf8'
const DEFAULT_STROKE = '#e6edf3'
const DEFAULT_STROKE_WIDTH = 2
const DEFAULT_TEXT_FILL = '#e2e8f0'

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
 * object (keyframe add/remove and tweening at the current frame), and the
 * node properties of the selection — the "Shape" section for primitives (fill
 * and outline rows), the "Image" section for images (source file, native-size
 * reset and replace-source) and the "Group" section for groups (ungroup and
 * the upcoming symbol action). All node sections share the same transform
 * inputs (position, size, rotation, opacity). Playback and frame controls
 * live at the top of the timeline; layers and per-object keyframes are
 * managed in the timeline tree. The node sections only appear while a
 * matching node is selected.
 */
export class PropertiesView {
  private readonly editor: Editor
  private readonly sections = new Map<SectionId, PanelSection>()
  private sectionState: SectionState

  private readonly keyframeButton: HTMLButtonElement
  private readonly removeKeyframeButton: HTMLButtonElement
  private readonly tweenButton: HTMLButtonElement
  private readonly easingEditor: EasingEditor
  private readonly tweenPathSelect: HTMLSelectElement
  private readonly moveNodeInput: HTMLInputElement

  /** Shared transform rows, parked in whichever node section is visible. */
  private readonly transformRows: HTMLDivElement
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
  private readonly ungroupButton: HTMLButtonElement
  private readonly imageFileLabel: HTMLElement
  private readonly nativeSizeButton: HTMLButtonElement
  private readonly replaceSourceButton: HTMLButtonElement
  private readonly symbolNameLabel: HTMLElement
  private readonly editSymbolButton: HTMLButtonElement
  private readonly breakApartButton: HTMLButtonElement
  private readonly brushColor: HTMLInputElement
  private readonly brushHex: HTMLInputElement
  private readonly brushSize: HTMLInputElement
  private readonly brushOpacity: HTMLInputElement
  private readonly onionToggle: HTMLInputElement
  private readonly prevCellButton: HTMLButtonElement
  private readonly duplicateCellButton: HTMLButtonElement
  private readonly clearCellButton: HTMLButtonElement
  private readonly nextCellButton: HTMLButtonElement
  private readonly cellRangeLabel: HTMLElement
  private readonly cellStartInput: HTMLInputElement
  private readonly cellEndInput: HTMLInputElement
  private readonly cellMoveInput: HTMLInputElement
  private readonly pathStrokeToggle: HTMLInputElement
  private readonly pathStrokeColor: HTMLInputElement
  private readonly pathStrokeWidth: HTMLInputElement
  private readonly pathFillToggle: HTMLInputElement
  private readonly pathFillColor: HTMLInputElement
  private readonly pathInfoLabel: HTMLElement
  private readonly textContent: HTMLTextAreaElement
  private readonly textFont: HTMLInputElement
  private readonly textSize: HTMLInputElement
  private readonly textWeight: HTMLSelectElement
  private readonly textAlign: HTMLSelectElement
  private readonly textColor: HTMLInputElement
  private readonly textHex: HTMLInputElement
  private readonly outlinesButton: HTMLButtonElement
  private readonly imageImportDeps: ImageImportDeps
  private lastNodeId: string | null = null

  constructor(
    editor: Editor,
    container: HTMLElement,
    options: { imageImportDeps?: ImageImportDeps } = {}
  ) {
    this.editor = editor
    this.imageImportDeps = options.imageImportDeps ?? {}
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
    this.easingEditor = new EasingEditor({
      onChange: (easing) => editor.setTweenEasingHere(easing),
      // A handle drag is one coalesced interaction: one undo entry.
      onDragStart: () => editor.beginInteraction(),
      onDragEnd: () => editor.endInteraction()
    })
    this.tweenPathSelect = el('select', 'tl-select') as HTMLSelectElement
    for (const [value, label] of [
      ['linear', 'Linear'],
      ['smooth', 'Smooth']
    ] as const) {
      const option = el('option', undefined, label)
      option.value = value
      this.tweenPathSelect.appendChild(option)
    }
    this.tweenPathSelect.title =
      'Spatial trajectory of the tween starting at the current keyframe (Smooth bends through the neighbouring poses)'
    this.tweenPathSelect.addEventListener('change', () => {
      editor.setTweenPathHere(this.tweenPathSelect.value as 'linear' | 'smooth')
    })
    layerButtons.append(this.keyframeButton, this.removeKeyframeButton)
    const tweenRow = el('div', 'panel-buttons')
    tweenRow.append(this.tweenButton)
    layer.content.append(layerButtons, tweenRow, this.easingEditor.root)
    const pathRow = this.row(layer.content, 'Motion path')
    pathRow.appendChild(this.tweenPathSelect)
    // Moves the whole selection so its first keyframe lands on this frame
    // (1-based), keeping each object's relative timing.
    this.moveNodeInput = this.numberInput(layer.content, 'Move to', 'f', () => {
      const value = Number(this.moveNodeInput.value)
      if (!Number.isFinite(value) || !editor.moveSelectedNodesToFrame(Math.floor(value) - 1)) {
        this.render()
      }
    })
    this.moveNodeInput.min = '1'
    this.moveNodeInput.title =
      'Move the selected objects so their first keyframes land on this frame (1-based), keeping their timing'

    // Shared transform inputs of the selected node (shape or group).
    this.transformRows = el('div', 'panel-rows')
    this.posX = this.numberInput(this.transformRows, 'Position', 'x', () => this.applyPosition('x'))
    this.posY = this.numberInput(this.transformRows, '', 'y', () => this.applyPosition('y'))
    this.width = this.numberInput(this.transformRows, 'Size', 'w', () => this.applySize('width'))
    this.height = this.numberInput(this.transformRows, '', 'h', () => this.applySize('height'))
    this.rotation = this.numberInput(this.transformRows, 'Rotation', '°', () => this.applyRotation())
    this.opacity = this.numberInput(this.transformRows, 'Opacity', '', () => this.applyOpacity())
    this.opacity.min = '0'
    this.opacity.max = '1'
    this.opacity.step = '0.1'

    // Shape properties, visible only while a primitive is selected.
    const shape = this.createSection('shape', 'Shape')
    const fillRows = el('div', 'panel-rows')
    const fillRow = this.row(fillRows, 'Fill')
    this.fillColor = el('input', 'color-swatch') as HTMLInputElement
    this.fillColor.type = 'color'
    this.fillColor.title = 'Fill color'
    this.fillHex = el('input', 'hex-input') as HTMLInputElement
    this.fillHex.type = 'text'
    this.fillHex.title = 'Fill color as hex'
    this.fillHex.placeholder = '#rrggbb'
    // A color-swatch drag fires many input events: coalesce them into one
    // undo entry, committed on change/cancel of the picker.
    this.fillColor.addEventListener('input', () => {
      editor.beginInteraction()
      editor.updateSelectedNode((current) => {
        if (current.type === 'primitive') current.fill = this.fillColor.value
      })
    })
    this.fillColor.addEventListener('change', () => editor.endInteraction())
    this.fillColor.addEventListener('cancel', () => editor.endInteraction())
    this.fillHex.addEventListener('change', () => {
      if (parseHexColor(this.fillHex.value)) {
        editor.updateSelectedNode((current) => {
          if (current.type === 'primitive') current.fill = normalizeHex(this.fillHex.value, DEFAULT_FILL)
        })
      } else {
        this.render()
      }
    })
    fillRow.append(this.fillColor, this.fillHex)

    const outlineRow = this.row(fillRows, 'Outline')
    this.strokeToggle = el('input', undefined) as HTMLInputElement
    this.strokeToggle.type = 'checkbox'
    this.strokeToggle.title = 'Enable the outline'
    this.strokeToggle.addEventListener('change', () => {
      const enabled = this.strokeToggle.checked
      editor.updateSelectedNode((current) => {
        if (current.type !== 'primitive') return
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
      editor.beginInteraction()
      editor.updateSelectedNode((current) => {
        if (current.type === 'primitive') current.stroke = this.strokeColor.value
      })
    })
    this.strokeColor.addEventListener('change', () => editor.endInteraction())
    this.strokeColor.addEventListener('cancel', () => editor.endInteraction())
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
      editor.updateSelectedNode((current) => {
        if (current.type === 'primitive') current.strokeWidth = Math.max(0, value)
      })
    })
    outlineRow.append(this.strokeToggle, this.strokeColor, this.strokeWidth)
    shape.content.append(this.transformRows, fillRows)

    // Path properties, visible only while a path node is selected.
    const path = this.createSection('path', 'Path')
    const pathStrokeRows = el('div', 'panel-rows')
    const pathStrokeRow = this.row(pathStrokeRows, 'Outline')
    this.pathStrokeToggle = el('input', undefined) as HTMLInputElement
    this.pathStrokeToggle.type = 'checkbox'
    this.pathStrokeToggle.title = 'Enable the path outline'
    this.pathStrokeToggle.addEventListener('change', () => {
      const enabled = this.pathStrokeToggle.checked
      editor.updateSelectedNode((current) => {
        if (current.type !== 'path') return
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
    this.pathStrokeColor = el('input', 'color-swatch') as HTMLInputElement
    this.pathStrokeColor.type = 'color'
    this.pathStrokeColor.title = 'Outline color'
    this.pathStrokeColor.addEventListener('input', () => {
      editor.beginInteraction()
      editor.updateSelectedNode((current) => {
        if (current.type === 'path') current.stroke = this.pathStrokeColor.value
      })
    })
    this.pathStrokeColor.addEventListener('change', () => editor.endInteraction())
    this.pathStrokeColor.addEventListener('cancel', () => editor.endInteraction())
    this.pathStrokeWidth = el('input', undefined) as HTMLInputElement
    this.pathStrokeWidth.type = 'number'
    this.pathStrokeWidth.min = '0'
    this.pathStrokeWidth.step = '1'
    this.pathStrokeWidth.title = 'Outline width'
    this.pathStrokeWidth.addEventListener('change', () => {
      const value = Number(this.pathStrokeWidth.value)
      if (!Number.isFinite(value)) {
        this.render()
        return
      }
      editor.updateSelectedNode((current) => {
        if (current.type === 'path') current.strokeWidth = Math.max(0, value)
      })
    })
    pathStrokeRow.append(this.pathStrokeToggle, this.pathStrokeColor, this.pathStrokeWidth)

    const pathFillRow = this.row(pathStrokeRows, 'Fill')
    this.pathFillToggle = el('input', undefined) as HTMLInputElement
    this.pathFillToggle.type = 'checkbox'
    this.pathFillToggle.title = 'Enable the path fill'
    this.pathFillToggle.addEventListener('change', () => {
      const enabled = this.pathFillToggle.checked
      editor.updateSelectedNode((current) => {
        if (current.type !== 'path') return
        if (enabled) current.fill = current.fill ?? DEFAULT_FILL
        else delete current.fill
      })
      this.render()
    })
    this.pathFillColor = el('input', 'color-swatch') as HTMLInputElement
    this.pathFillColor.type = 'color'
    this.pathFillColor.title = 'Fill color'
    this.pathFillColor.addEventListener('input', () => {
      editor.beginInteraction()
      editor.updateSelectedNode((current) => {
        if (current.type === 'path') current.fill = this.pathFillColor.value
      })
    })
    this.pathFillColor.addEventListener('change', () => editor.endInteraction())
    this.pathFillColor.addEventListener('cancel', () => editor.endInteraction())
    pathFillRow.append(this.pathFillToggle, this.pathFillColor)

    const pathInfoRow = this.row(path.content, 'Geometry')
    this.pathInfoLabel = el('span', 'panel-file-name')
    this.pathInfoLabel.title = 'Anchor count of the path (compound paths cannot be anchor-edited)'
    pathInfoRow.appendChild(this.pathInfoLabel)
    path.content.append(this.transformRows, pathStrokeRows)

    // Text properties, visible only while a text node is selected.
    const text = this.createSection('text', 'Text')
    const textContentRow = this.row(text.content, 'Content')
    this.textContent = el('textarea', 'panel-textarea') as HTMLTextAreaElement
    this.textContent.rows = 3
    this.textContent.title = 'Text content — use line breaks for multiple lines'
    this.textContent.addEventListener('change', () => {
      editor.updateSelectedNode((current) => {
        if (current.type !== 'text') return
        current.text = this.textContent.value
        applyTextMetrics(current, editor.measureText)
      })
    })
    textContentRow.appendChild(this.textContent)

    const fontRows = el('div', 'panel-rows')
    const fontRow = this.row(fontRows, 'Font')
    this.textFont = el('input') as HTMLInputElement
    this.textFont.type = 'text'
    this.textFont.title = 'Font family (renders with locally installed fonts)'
    this.textFont.addEventListener('change', () => {
      const family = this.textFont.value.trim()
      if (!family) {
        this.render()
        return
      }
      editor.updateSelectedNode((current) => {
        if (current.type !== 'text') return
        current.fontFamily = family
        applyTextMetrics(current, editor.measureText)
      })
    })
    fontRow.appendChild(this.textFont)

    const textSizeRow = this.row(fontRows, "Size")
    this.textSize = el('input') as HTMLInputElement
    this.textSize.type = 'number'
    this.textSize.min = '4'
    this.textSize.title = 'Font size in stage pixels'
    this.textSize.addEventListener('change', () => {
      const value = Number(this.textSize.value)
      if (!Number.isFinite(value)) {
        this.render()
        return
      }
      editor.updateSelectedNode((current) => {
        if (current.type !== 'text') return
        current.fontSize = Math.max(4, value)
        applyTextMetrics(current, editor.measureText)
      })
    })
    textSizeRow.appendChild(this.textSize)

    const weightRow = this.row(fontRows, 'Weight')
    this.textWeight = el('select', 'tl-select') as HTMLSelectElement
    for (const [value, label] of [
      ['400', 'Regular'],
      ['700', 'Bold']
    ] as const) {
      const option = el('option', undefined, label)
      option.value = value
      this.textWeight.appendChild(option)
    }
    this.textWeight.title = 'Font weight (outlines convert with the bundled Noto Sans weight)'
    this.textWeight.addEventListener('change', () => {
      editor.updateSelectedNode((current) => {
        if (current.type !== 'text') return
        current.fontWeight = Number(this.textWeight.value)
        applyTextMetrics(current, editor.measureText)
      })
    })
    weightRow.appendChild(this.textWeight)

    const alignRow = this.row(fontRows, 'Align')
    this.textAlign = el('select', 'tl-select') as HTMLSelectElement
    for (const align of ['left', 'center', 'right'] as const) {
      const option = el('option', undefined, align)
      option.value = align
      this.textAlign.appendChild(option)
    }
    this.textAlign.title = 'Text alignment within the text box'
    this.textAlign.addEventListener('change', () => {
      editor.updateSelectedNode((current) => {
        if (current.type === 'text') current.align = this.textAlign.value as typeof current.align
      })
    })
    alignRow.appendChild(this.textAlign)

    const textColorRow = this.row(fontRows, 'Fill')
    this.textColor = el('input', 'color-swatch') as HTMLInputElement
    this.textColor.type = 'color'
    this.textColor.title = 'Text color'
    this.textColor.addEventListener('input', () => {
      editor.beginInteraction()
      editor.updateSelectedNode((current) => {
        if (current.type === 'text') current.fill = this.textColor.value
      })
    })
    this.textColor.addEventListener('change', () => editor.endInteraction())
    this.textColor.addEventListener('cancel', () => editor.endInteraction())
    this.textHex = el('input', 'hex-input') as HTMLInputElement
    this.textHex.type = 'text'
    this.textHex.title = 'Text color as hex'
    this.textHex.placeholder = '#rrggbb'
    this.textHex.addEventListener('change', () => {
      if (parseHexColor(this.textHex.value)) {
        editor.updateSelectedNode((current) => {
          if (current.type === 'text') current.fill = normalizeHex(this.textHex.value, DEFAULT_TEXT_FILL)
        })
      } else {
        this.render()
      }
    })
    textColorRow.append(this.textColor, this.textHex)

    const textActions = el('div', 'panel-buttons')
    this.outlinesButton = this.button(
      'Convert to Outlines',
      'Replace the text with vector paths (bundled Noto Sans, regular or bold)',
      () => void convertSelectedTextToOutlines(editor).then(() => this.render())
    )
    textActions.appendChild(this.outlinesButton)
    text.content.append(this.transformRows, textContentRow, fontRows, textActions)

    // Group properties, visible only while a group is selected.
    const group = this.createSection('group', 'Group')
    const groupActions = el('div', 'panel-buttons')
    this.ungroupButton = this.button('Ungroup', 'Ungroup (Ctrl+Shift+G)', () =>
      editor.ungroupSelection()
    )
    const symbolButton = this.button(
      'Save as Symbol… (F8)',
      'Save the selection as a reusable symbol and replace it with an instance (F8)',
      () => editor.saveSelectionAsSymbol()
    )
    groupActions.append(this.ungroupButton, symbolButton)
    group.content.append(groupActions)

    // Symbol properties, visible only while a symbol instance is selected.
    const symbol = this.createSection('symbol', 'Symbol')
    const symbolNameRow = this.row(symbol.content, 'Asset')
    this.symbolNameLabel = el('span', 'panel-file-name')
    this.symbolNameLabel.title = 'Asset the instance references'
    symbolNameRow.appendChild(this.symbolNameLabel)
    const symbolActions = el('div', 'panel-buttons')
    this.editSymbolButton = this.button(
      'Edit Symbol',
      'Edit the symbol asset in isolation — every instance updates when finished',
      () => {
        const current = this.selectedNodePose()
        if (current?.type === 'symbol') editor.beginSymbolEdit(current.assetId)
      }
    )
    this.breakApartButton = this.button(
      'Break Apart',
      'Replace the instance with an editable, decoupled copy of the artwork',
      () => editor.breakApartSelection()
    )
    symbolActions.append(this.editSymbolButton, this.breakApartButton)
    symbol.content.append(symbolActions)

    // Image properties, visible only while an image node is selected.
    const image = this.createSection('image', 'Image')
    const imageFileRow = this.row(image.content, 'Source')
    this.imageFileLabel = el('span', 'panel-file-name')
    this.imageFileLabel.title = 'File the image was imported from'
    imageFileRow.appendChild(this.imageFileLabel)
    const imageActions = el('div', 'panel-buttons')
    this.nativeSizeButton = this.button(
      'Native size',
      'Reset the placed size to the image natural size',
      () => {
        this.editor.updateSelectedNode((current) => {
          if (current.type !== 'image') return
          current.width = current.naturalWidth
          current.height = current.naturalHeight
        })
      }
    )
    this.replaceSourceButton = this.button(
      'Replace source…',
      'Pick another image file and re-point the selected image at it (keeps the placed size)',
      () => void this.replaceImageSource()
    )
    imageActions.append(this.nativeSizeButton, this.replaceSourceButton)
    image.content.append(imageActions)

    // Draw properties, visible only while a drawing layer is active.
    const draw = this.createSection('draw', 'Draw')
    const colorRow = this.row(draw.content, 'Color')
    this.brushColor = el('input', 'color-swatch') as HTMLInputElement
    this.brushColor.type = 'color'
    this.brushColor.title = 'Brush color'
    this.brushHex = el('input', 'hex-input') as HTMLInputElement
    this.brushHex.type = 'text'
    this.brushHex.title = 'Brush color as hex'
    this.brushHex.placeholder = '#rrggbb'
    this.brushColor.addEventListener('input', () => {
      editor.setBrushColor(this.brushColor.value)
      this.brushHex.value = this.brushColor.value
    })
    this.brushHex.addEventListener('change', () => {
      const parsed = parseHexColor(this.brushHex.value)
      if (parsed) {
        const hex = formatHexColor(parsed)
        editor.setBrushColor(hex)
        this.brushColor.value = hex
      } else {
        this.render()
      }
    })
    colorRow.append(this.brushColor, this.brushHex)

    const sizeRow = this.row(draw.content, 'Size')
    sizeRow.appendChild(el('span', 'panel-suffix', 'px'))
    this.brushSize = el('input') as HTMLInputElement
    this.brushSize.type = 'number'
    this.brushSize.min = '1'
    this.brushSize.max = '100'
    this.brushSize.title = 'Brush and eraser size in stage pixels (1–100), [ and ] to adjust'
    this.brushSize.addEventListener('change', () => {
      const value = Number(this.brushSize.value)
      if (!Number.isFinite(value)) {
        this.render()
        return
      }
      editor.setBrushSize(value)
    })
    sizeRow.appendChild(this.brushSize)

    const opacityRow = this.row(draw.content, 'Opacity')
    this.brushOpacity = el('input') as HTMLInputElement
    this.brushOpacity.type = 'number'
    this.brushOpacity.min = '0'
    this.brushOpacity.max = '1'
    this.brushOpacity.step = '0.1'
    this.brushOpacity.title = 'Brush stroke opacity'
    this.brushOpacity.addEventListener('change', () => {
      const value = Number(this.brushOpacity.value)
      if (!Number.isFinite(value)) {
        this.render()
        return
      }
      editor.setBrushOpacity(value)
    })
    opacityRow.appendChild(this.brushOpacity)

    const onionRow = this.row(draw.content, 'Onion skin')
    this.onionToggle = el('input') as HTMLInputElement
    this.onionToggle.type = 'checkbox'
    this.onionToggle.title = 'Show the neighbouring frames of the drawing through the current cell'
    this.onionToggle.addEventListener('change', () => {
      if (this.onionToggle.checked !== editor.onionSkin) editor.toggleOnionSkin()
    })
    onionRow.appendChild(this.onionToggle)

    const cellActions = el('div', 'panel-buttons')
    this.prevCellButton = this.button('◀ Prev', 'Go to the previous cell', () =>
      editor.seekToPreviousCell()
    )
    this.duplicateCellButton = this.button(
      'Duplicate',
      'Insert a cell duplicating the previous buffer, for in-betweening (F6)',
      () => void editor.insertCellHere()
    )
    this.clearCellButton = this.button(
      'Clear',
      'Clear the cell at the playhead (the previous cell stops holding through)',
      () => void editor.clearCellHere()
    )
    this.nextCellButton = this.button('Next ▶', 'Go to the next cell', () =>
      editor.seekToNextCell()
    )
    cellActions.append(this.prevCellButton, this.duplicateCellButton, this.clearCellButton, this.nextCellButton)
    draw.content.append(cellActions)

    // Cell framing, visible while a drawing layer is active: the visible
    // span of the cell at the playhead, adjustable numerically.
    const cell = this.createSection('cell', 'Cell')
    const rangeRow = this.row(cell.content, 'Range')
    this.cellRangeLabel = el('span', 'panel-suffix', '')
    rangeRow.appendChild(this.cellRangeLabel)

    const cellStartRow = this.row(cell.content, 'Start')
    cellStartRow.appendChild(el('span', 'panel-suffix', 'f'))
    this.cellStartInput = el('input') as HTMLInputElement
    this.cellStartInput.type = 'number'
    this.cellStartInput.min = '1'
    this.cellStartInput.title =
      'Frame the cell at the playhead starts on (1-based); changing it moves the cell'
    this.cellStartInput.addEventListener('change', () => {
      const range = this.currentCellRange()
      const value = Number(this.cellStartInput.value)
      if (!range || !Number.isFinite(value)) {
        this.render()
        return
      }
      const target = this.clampFrame(Math.floor(value) - 1)
      if (editor.moveCellToFrame(range.cellFrame, target)) editor.setFrame(target)
      else this.render()
    })
    cellStartRow.appendChild(this.cellStartInput)

    const cellEndRow = this.row(cell.content, 'End')
    cellEndRow.appendChild(el('span', 'panel-suffix', 'f'))
    this.cellEndInput = el('input') as HTMLInputElement
    this.cellEndInput.type = 'number'
    this.cellEndInput.min = '1'
    this.cellEndInput.title =
      'Last frame the cell at the playhead stays visible on (1-based); the following cell shifts with it'
    this.cellEndInput.addEventListener('change', () => {
      const range = this.currentCellRange()
      const value = Number(this.cellEndInput.value)
      if (!range || !Number.isFinite(value)) {
        this.render()
        return
      }
      void editor.setCellEndFrame(range.cellFrame, Math.floor(value) - 1).then((changed) => {
        if (!changed) this.render()
      })
    })
    cellEndRow.appendChild(this.cellEndInput)

    const cellMoveRow = this.row(cell.content, 'Move to')
    cellMoveRow.appendChild(el('span', 'panel-suffix', 'f'))
    this.cellMoveInput = el('input') as HTMLInputElement
    this.cellMoveInput.type = 'number'
    this.cellMoveInput.min = '1'
    this.cellMoveInput.title =
      'Move the cell at the playhead so it starts on this frame (1-based)'
    this.cellMoveInput.addEventListener('change', () => {
      const range = this.currentCellRange()
      const value = Number(this.cellMoveInput.value)
      if (!range || !Number.isFinite(value)) {
        this.render()
        return
      }
      const target = this.clampFrame(Math.floor(value) - 1)
      if (editor.moveCellToFrame(range.cellFrame, target)) editor.setFrame(target)
      else this.render()
    })
    cellMoveRow.appendChild(this.cellMoveInput)

    scroll.append(
      layer.root,
      shape.root,
      path.root,
      text.root,
      image.root,
      group.root,
      symbol.root,
      draw.root,
      cell.root
    )
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

  private applyNumber(input: HTMLInputElement, apply: (node: SceneNode, value: number) => void): void {
    const value = Number(input.value)
    if (!Number.isFinite(value)) {
      this.render()
      return
    }
    this.editor.updateSelectedNode((node) => apply(node, value))
  }

  private applyPosition(axis: 'x' | 'y'): void {
    this.applyNumber(axis === 'x' ? this.posX : this.posY, (node, value) => {
      if (axis === 'x') node.center.x = value
      else node.center.y = value
    })
  }

  private applySize(field: 'width' | 'height'): void {
    this.applyNumber(field === 'width' ? this.width : this.height, (node, value) => {
      node[field] = Math.max(2, value)
    })
  }

  private applyRotation(): void {
    this.applyNumber(this.rotation, (node, value) => {
      node.rotation = value
    })
  }

  private applyOpacity(): void {
    this.applyNumber(this.opacity, (node, value) => {
      node.opacity = Math.min(1, Math.max(0, value))
    })
  }

  /**
   * Re-points the selected image at another file: the picked image is
   * prepared (decode, re-encode, store) and the node's resourceId, natural
   * size and name update in one undo step — the placed size is kept.
   */
  private async replaceImageSource(): Promise<void> {
    const picked = await pickImageFile()
    if (!picked) return
    const prepared = await prepareImageResource(this.editor, picked.fileName, picked.bytes, this.imageImportDeps)
    if (!prepared) return
    const updated = this.editor.updateSelectedNode((current) => {
      if (current.type !== 'image') return
      const image = current as ImageNode
      image.resourceId = prepared.resourceId
      image.naturalWidth = Math.max(1, prepared.natural.width)
      image.naturalHeight = Math.max(1, prepared.natural.height)
      image.name = prepared.name
    })
    if (updated) this.render()
  }

  render(): void {
    this.renderLayerSection()
    this.renderNodeSection()
    this.renderDrawSection()
    this.renderCellSection()
  }

  private renderLayerSection(): void {
    const editor = this.editor
    const layer = editor.currentLayer
    // Keyframe/tween operations only make sense on object layers.
    const editable = layer !== undefined && isObjectLayer(layer) && !layer.locked
    const selected = editor.primarySelectedNodeId
    // Object-level: the buttons act on the selected object's own keyframe.
    const ownsKeyframe =
      layer !== undefined &&
      isObjectLayer(layer) &&
      selected !== null &&
      editor.hasNodeKeyframeAt(layer.id, selected, editor.currentFrame)
    this.keyframeButton.disabled = !editable || selected === null || ownsKeyframe
    this.removeKeyframeButton.disabled = !editable || !ownsKeyframe
    this.tweenButton.disabled = !editable || !ownsKeyframe
    const keyframe =
      layer && isObjectLayer(layer) ? findKeyframeAtFrame(layer, editor.currentFrame) : undefined
    this.tweenButton.classList.toggle('active', ownsKeyframe && keyframe?.tween !== undefined)
    const tween = ownsKeyframe ? keyframe?.tween : undefined
    this.easingEditor.setDisabled(tween === undefined)
    this.tweenPathSelect.disabled = tween === undefined
    if (tween) {
      this.easingEditor.setValue(tween.easing)
      this.tweenPathSelect.value = tween.path ?? 'linear'
    }

    // "Move to" shows the primary object's first keyframe; a whole selection
    // moves relative to the target of its primary.
    let firstFrame: number | null = null
    if (selected !== null && layer !== undefined && isObjectLayer(layer)) {
      const frames = layer.keyframes
        .filter((keyframe) => keyframe.nodes.some((node) => node.id === selected))
        .map((keyframe) => keyframe.frame)
      if (frames.length > 0) firstFrame = Math.min(...frames)
    }
    if (document.activeElement !== this.moveNodeInput) {
      this.moveNodeInput.value = firstFrame === null ? '' : String(firstFrame + 1)
    }
    this.moveNodeInput.disabled = !editable || firstFrame === null
  }

  private renderNodeSection(): void {
    const editor = this.editor
    const node = this.selectedNodePose()
    const layer = editor.currentLayer
    const editable = node !== null && layer !== undefined && !layer.locked && layer.visible
    const isPrimitive = node?.type === 'primitive'
    const isImage = node?.type === 'image'
    const isGroup = node?.type === 'group'
    const isSymbol = node?.type === 'symbol'
    const isPath = node?.type === 'path'
    const isText = node?.type === 'text'
    // Mutually exclusive: the section matches the primary selected node kind.
    this.sections.get('shape')?.setVisible(isPrimitive)
    this.sections.get('path')?.setVisible(isPath)
    this.sections.get('text')?.setVisible(isText)
    this.sections.get('image')?.setVisible(isImage)
    this.sections.get('group')?.setVisible(isGroup)
    this.sections.get('symbol')?.setVisible(isSymbol)
    if (!node) {
      this.lastNodeId = null
      return
    }

    // The transform rows are shared by the node sections; park them in the
    // one that is currently visible.
    const host = isGroup
      ? this.sections.get('group')!.content
      : isSymbol
        ? this.sections.get('symbol')!.content
        : isImage
          ? this.sections.get('image')!.content
          : isPath
            ? this.sections.get('path')!.content
            : isText
              ? this.sections.get('text')!.content
              : this.sections.get('shape')!.content
    if (this.transformRows.parentElement !== host) {
      host.insertBefore(this.transformRows, host.firstChild)
    }

    for (const input of [this.posX, this.posY, this.width, this.height, this.rotation, this.opacity]) {
      input.disabled = !editable
    }

    const keepFocused = (input: HTMLElement): boolean =>
      document.activeElement === input && this.lastNodeId === node.id

    if (!keepFocused(this.posX)) this.posX.value = String(round(node.center.x))
    if (!keepFocused(this.posY)) this.posY.value = String(round(node.center.y))
    if (!keepFocused(this.width)) this.width.value = String(round(node.width))
    if (!keepFocused(this.height)) this.height.value = String(round(node.height))
    if (!keepFocused(this.rotation)) this.rotation.value = String(round(node.rotation))
    if (!keepFocused(this.opacity)) this.opacity.value = String(node.opacity)

    this.ungroupButton.disabled = !editable

    if (node.type === 'symbol') {
      const asset = this.editor.document.assets.find((entry) => entry.id === node.assetId)
      this.symbolNameLabel.textContent = asset?.name ?? '(missing asset)'
      this.editSymbolButton.disabled = !asset || asset.kind !== 'symbol' || !asset.content
      this.breakApartButton.disabled = !editable
    }
    if (node.type === 'image') {
      this.imageFileLabel.textContent = node.name ?? '(unnamed image)'
      this.nativeSizeButton.disabled = !editable
      this.replaceSourceButton.disabled = !editable
    }
    if (node.type === 'primitive') {
      const fill = normalizeHex(node.fill, DEFAULT_FILL)
      if (!keepFocused(this.fillColor)) this.fillColor.value = fill
      if (!keepFocused(this.fillHex)) this.fillHex.value = node.fill
      const outlined = node.stroke !== undefined
      if (!keepFocused(this.strokeToggle)) this.strokeToggle.checked = outlined
      if (!keepFocused(this.strokeColor)) {
        this.strokeColor.value = normalizeHex(node.stroke ?? DEFAULT_STROKE, DEFAULT_STROKE)
      }
      if (!keepFocused(this.strokeWidth)) {
        this.strokeWidth.value = String(node.strokeWidth ?? DEFAULT_STROKE_WIDTH)
      }
      this.strokeColor.disabled = !editable || !outlined
      this.strokeWidth.disabled = !editable || !outlined
    }
    if (node.type === 'path') {
      const outlined = node.stroke !== undefined
      const filled = node.fill !== undefined
      if (!keepFocused(this.pathStrokeToggle)) this.pathStrokeToggle.checked = outlined
      if (!keepFocused(this.pathStrokeColor)) {
        this.pathStrokeColor.value = normalizeHex(node.stroke ?? DEFAULT_STROKE, DEFAULT_STROKE)
      }
      if (!keepFocused(this.pathStrokeWidth)) {
        this.pathStrokeWidth.value = String(node.strokeWidth ?? DEFAULT_STROKE_WIDTH)
      }
      if (!keepFocused(this.pathFillToggle)) this.pathFillToggle.checked = filled
      if (!keepFocused(this.pathFillColor)) {
        this.pathFillColor.value = normalizeHex(node.fill ?? DEFAULT_FILL, DEFAULT_FILL)
      }
      this.pathStrokeColor.disabled = !editable || !outlined
      this.pathStrokeWidth.disabled = !editable || !outlined
      this.pathFillColor.disabled = !editable || !filled
      const parsed = pathDataToAnchors(node.d)
      this.pathInfoLabel.textContent = parsed
        ? `${parsed.anchors.length} anchors${parsed.closed ? ' · closed' : ''}`
        : 'compound path'
    }
    if (node.type === 'text') {
      if (!keepFocused(this.textContent)) this.textContent.value = node.text
      if (!keepFocused(this.textFont)) this.textFont.value = node.fontFamily
      if (!keepFocused(this.textSize)) this.textSize.value = String(node.fontSize)
      if (!keepFocused(this.textWeight)) this.textWeight.value = String(node.fontWeight)
      if (!keepFocused(this.textAlign)) this.textAlign.value = node.align
      if (!keepFocused(this.textColor)) this.textColor.value = normalizeHex(node.fill, DEFAULT_TEXT_FILL)
      if (!keepFocused(this.textHex)) this.textHex.value = node.fill
      this.outlinesButton.disabled = !editable
    }
    this.lastNodeId = node.id
  }

  /** Draw section: brush settings and cell ops while a drawing layer is active. */
  private renderDrawSection(): void {
    const editor = this.editor
    const layer = editor.currentLayer
    const isDrawing = layer !== undefined && isDrawingLayer(layer)
    this.sections.get('draw')?.setVisible(isDrawing)
    if (!layer || !isDrawingLayer(layer) || layer.locked) return

    const keep = (input: HTMLInputElement): boolean => document.activeElement === input
    const hex = normalizeHex(editor.brushColor, '#e6edf3')
    if (!keep(this.brushColor)) this.brushColor.value = hex
    if (!keep(this.brushHex)) this.brushHex.value = editor.brushColor
    if (!keep(this.brushSize)) this.brushSize.value = String(editor.brushSize)
    if (!keep(this.brushOpacity)) this.brushOpacity.value = String(editor.brushOpacity)
    this.onionToggle.checked = editor.onionSkin
    this.prevCellButton.disabled = findPreviousCellFrame(layer, editor.currentFrame) === null
    this.nextCellButton.disabled = findNextCellFrame(layer, editor.currentFrame) === null
  }

  /**
   * Cell section: the visible span of the cell at the playhead with numeric
   * start/end/move controls. The handlers resolve the current cell on every
   * change, so the inputs always act on the cell actually under the playhead.
   */
  private renderCellSection(): void {
    const editor = this.editor
    const layer = editor.currentLayer
    const isDrawing = layer !== undefined && isDrawingLayer(layer)
    this.sections.get('cell')?.setVisible(isDrawing)
    if (!layer || !isDrawingLayer(layer)) return

    const keep = (input: HTMLInputElement): boolean => document.activeElement === input
    const range = this.currentCellRange()
    const inputs = [this.cellStartInput, this.cellEndInput, this.cellMoveInput]
    if (!range) {
      this.cellRangeLabel.textContent = 'no cell here'
      for (const input of inputs) {
        if (!keep(input)) input.value = ''
        input.disabled = true
      }
      return
    }
    this.cellRangeLabel.textContent = range.lastHolds
      ? `frames ${range.cellFrame + 1}\u2013end`
      : `frames ${range.cellFrame + 1}\u2013${range.endFrame + 1}`
    if (!keep(this.cellStartInput)) this.cellStartInput.value = String(range.cellFrame + 1)
    if (!keep(this.cellEndInput)) this.cellEndInput.value = String(range.endFrame + 1)
    if (!keep(this.cellMoveInput)) this.cellMoveInput.value = String(range.cellFrame + 1)
    for (const input of inputs) input.disabled = layer.locked
  }

  /** Span of the cell covering the playhead of the active drawing layer. */
  private currentCellRange(): CellRange | null {
    const layer = this.editor.currentLayer
    if (!layer || !isDrawingLayer(layer)) return null
    return cellRangeAtFrame(layer, this.editor.currentFrame, this.editor.duration)
  }

  private clampFrame(frame: number): number {
    return Math.min(Math.max(0, frame), Math.max(0, this.editor.duration - 1))
  }

  /**
   * Pose shown for the selected node: the one in the keyframe active at the
   * current frame when present, otherwise its nearest existing pose (e.g. a
   * node picked from the timeline tree that only exists in another keyframe).
   * The first edit materialises the pose at the current frame via auto-key.
   */
  private selectedNodePose(): SceneNode | null {
    const editor = this.editor
    const nodeId = editor.primarySelectedNodeId
    if (!nodeId) return null
    const layer = editor.currentLayer
    if (!layer || !isObjectLayer(layer)) return null
    const activeIndex = findKeyframeIndexForFrame(layer, editor.currentFrame)
    if (activeIndex !== -1) {
      const node = layer.keyframes[activeIndex].nodes.find((node) => node.id === nodeId)
      if (node) return node
    }
    const nearestIndex = findNearestNodeKeyframeIndex(layer, nodeId, editor.currentFrame)
    if (nearestIndex === -1) return null
    return layer.keyframes[nearestIndex].nodes.find((node) => node.id === nodeId) ?? null
  }
}
