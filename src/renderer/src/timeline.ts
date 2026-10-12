import {
  audioClipEndFrame,
  cellRangeAtFrame,
  extractKeyframeChunk,
  findKeyframeAtFrame,
  findNearestNodeKeyframeIndex,
  getLayer,
  resolveCellAtFrame
} from '@shared/document'
import type { KeyframeChunkEntry } from '@shared/document'
import { isAudioLayer, isCameraLayer, isDrawingLayer, isObjectLayer } from '@shared/model'
import type {
  AudioLayer,
  CameraLayer,
  DrawingLayer,
  Layer,
  ObjectLayer,
  SceneNode
} from '@shared/model'
import { paintPrimaryColor } from '@shared/paint'

import { importAudioViaDialog } from './audioImport'
import { setActiveSurface } from './activeSurface'
import type { Editor } from './editor'
import { el } from './dom'

const FRAME_WIDTH = 14
const HEAD_WIDTH = 180
const MIN_FRAMES = 40
const ROW_HEIGHT = 28
/** Pointer travel (px) before a keyframe-marker press becomes a drag. */
const DRAG_THRESHOLD = 3
const HOLD_STEPS = [1, 2, 3, 4, 5, 6, 8, 12] as const
const NODE_KIND_LABELS: Record<string, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  group: 'Group',
  image: 'Image',
  symbol: 'Symbol',
  path: 'Path',
  text: 'Text'
}
/** Swatch/span color for node kinds without a fill of their own. */
const NEUTRAL_COLOR = '#64748b'
/** Marker identity of a camera keyframe in the timeline selection. */
const CAMERA_MARKER_NODE = '\u0000camera'
/** Waveform fill of audio clips (mirrors the accent blue). */
const WAVEFORM_COLOR = '#6aa9e9'

function nodeLabel(node: SceneNode): string {
  const kind = node.type === 'primitive' ? node.primitive : node.type
  return node.name || NODE_KIND_LABELS[kind] || 'Object'
}

/** Timeline swatch/span color: a node's own paint where it has one
 * (gradient paints show their first stop's color). */
function nodeColor(node: SceneNode): string {
  if (node.type === 'primitive') return paintPrimaryColor(node.fill)
  if (node.type === 'path') {
    if (node.stroke !== undefined) return paintPrimaryColor(node.stroke)
    return node.fill !== undefined ? paintPrimaryColor(node.fill) : NEUTRAL_COLOR
  }
  if (node.type === 'text') return paintPrimaryColor(node.fill)
  return NEUTRAL_COLOR
}

/**
 * Maximal frame runs resolving to the same cell: [start, end) with the held
 * resource id, or null for blank frames. Consistent with resolveCellAtFrame,
 * so leading frames are blank and the last cell holds to the end.
 */
function filmstripSpans(
  layer: DrawingLayer,
  frames: number
): Array<{ start: number; end: number; resourceId: string | null }> {
  const spans: Array<{ start: number; end: number; resourceId: string | null }> = []
  if (frames <= 0) return spans
  let start = 0
  let current = resolveCellAtFrame(layer, 0)
  for (let frame = 1; frame < frames; frame++) {
    const value = resolveCellAtFrame(layer, frame)
    if (value !== current) {
      spans.push({ start, end: frame, resourceId: current })
      start = frame
      current = value
    }
  }
  spans.push({ start, end: frames, resourceId: current })
  return spans
}

/** Row targeted by the context menu: a layer row or one of its object rows. */
interface MenuTarget {
  layerId: string
  nodeId: string | null
  /** Set when the menu was opened on a keyframe marker at that frame. */
  keyframeFrame?: number
}

/** Identity of one keyframe marker in the timeline selection. */
interface MarkerRef {
  layerId: string
  nodeId: string
  frame: number
}

function markerKey(layerId: string, nodeId: string, frame: number): string {
  return `${layerId}\u0000${nodeId}\u0000${frame}`
}

function parseMarkerKey(key: string): MarkerRef {
  // Node ids are opaque strings — the camera sentinel itself contains the
  // separator — so only the layer id and the frame sit at the ends.
  const first = key.indexOf('\u0000')
  const last = key.lastIndexOf('\u0000')
  return {
    layerId: key.slice(0, first),
    nodeId: key.slice(first + 1, last),
    frame: Number(key.slice(last + 1))
  }
}

/**
 * Bottom panel: a unified timeline with an integrated layer tree on the left
 * and the frame tracks on the right.
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
  private readonly rangeBand: HTMLDivElement
  private readonly frameLabel: HTMLSpanElement
  private readonly playButton: HTMLButtonElement
  private readonly loopButton: HTMLButtonElement
  private readonly scrubAudioCheckbox: HTMLInputElement
  private readonly fpsInput: HTMLInputElement
  private readonly holdSelect: HTMLSelectElement
  private readonly onionCheckbox: HTMLInputElement
  private readonly onionBeforeInput: HTMLInputElement
  private readonly onionAfterInput: HTMLInputElement
  private readonly onionTintCheckbox: HTMLInputElement
  private readonly onionTintBeforeInput: HTMLInputElement
  private readonly onionTintAfterInput: HTMLInputElement
  private readonly onionOutlineCheckbox: HTMLInputElement
  private readonly menu: HTMLDivElement
  private readonly menuRenameButton: HTMLButtonElement
  private readonly menuDeleteButton: HTMLButtonElement
  private readonly menuCellButtons: HTMLButtonElement[]
  private readonly menuKeyframeButtons: HTMLButtonElement[]
  private readonly menuPasteKeyframeButton: HTMLButtonElement
  private readonly menuCameraButtons: HTMLButtonElement[]
  private readonly menuAudioButtons: HTMLButtonElement[]
  private readonly menuAudioVolumeRow: HTMLDivElement
  private readonly menuAudioVolumeInput: HTMLInputElement
  private readonly menuResolutionRow: HTMLDivElement
  private readonly menuResolutionInput: HTMLInputElement
  private readonly menuMoveRow: HTMLDivElement
  private readonly menuMoveInput: HTMLInputElement
  private readonly expandedLayers = new Set<string>()
  /** Selected keyframe markers, keyed by `markerKey` (layer, node, frame). */
  private selectedMarkers = new Set<string>()
  /** Last marker press: the copy fallback and the keyboard-focus anchor. */
  private focusedMarker: MarkerRef | null = null
  /** Frame range dragged on the ruler, inclusive; wins over markers on copy. */
  private rangeSelection: { start: number; end: number } | null = null
  /** Copied keyframe chunk (session clipboard for Ctrl+C / Ctrl+V). */
  private clipboard: { entries: KeyframeChunkEntry[] } | null = null
  private markerDrag: { layerId: string; startX: number; startY: number; pointerId: number; dragging: boolean } | null = null
  private rulerDrag: { startFrame: number; pointerId: number; active: boolean } | null = null
  private nodeKeyframeButtons: HTMLButtonElement[] = []
  private nodeTweenButtons: HTMLButtonElement[] = []
  private menuTarget: MenuTarget | null = null
  private draggedLayerId: string | null = null
  private draggedCell: { layerId: string; frame: number } | null = null
  private draggedNode: { layerId: string; nodeId: string } | null = null
  private draggedAudio: { layerId: string } | null = null

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
    this.scrubAudioCheckbox = el('input', 'tl-check') as HTMLInputElement
    this.scrubAudioCheckbox.type = 'checkbox'
    this.scrubAudioCheckbox.title =
      'Play a short blip of the audio under the playhead while scrubbing paused (off by default)'
    this.scrubAudioCheckbox.addEventListener('change', () =>
      editor.setScrubAudio(this.scrubAudioCheckbox.checked)
    )
    const scrubLabel = el('span', 'tl-label', 'Scrub audio')
    scrubLabel.addEventListener('click', () => this.scrubAudioCheckbox.click())
    playbackGroup.append(this.playButton, stopButton, this.loopButton, this.scrubAudioCheckbox, scrubLabel)

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

    // Options row: hold step (play on n's) and the onion-skin display options.
    const options = el('div', 'tl-options')
    const holdGroup = el('div', 'tl-group')
    holdGroup.appendChild(el('span', 'tl-label', 'Hold'))
    this.holdSelect = el('select', 'tl-select') as HTMLSelectElement
    this.holdSelect.title =
      'Hold step: play every frame, or animate on n\u2019s (non-destructive — playback, onion skin and export all step)'
    for (const step of HOLD_STEPS) {
      const option = document.createElement('option')
      option.value = String(step)
      option.textContent = step === 1 ? '1 (off)' : String(step)
      this.holdSelect.appendChild(option)
    }
    this.holdSelect.addEventListener('change', () => editor.setHoldStep(Number(this.holdSelect.value)))
    holdGroup.appendChild(this.holdSelect)

    const onionGroup = el('div', 'tl-group')
    this.onionCheckbox = el('input', 'tl-check') as HTMLInputElement
    this.onionCheckbox.type = 'checkbox'
    this.onionCheckbox.title = 'Toggle onion skinning (ghosted neighbouring frames)'
    this.onionCheckbox.addEventListener('change', () => {
      if (this.onionCheckbox.checked !== editor.onionSkin) editor.toggleOnionSkin()
    })
    const onionLabel = el('span', 'tl-label', 'Onion')
    onionLabel.addEventListener('click', () => this.onionCheckbox.click())
    onionGroup.append(this.onionCheckbox, onionLabel)
    const onionCount = (title: string, apply: (value: number) => void): HTMLInputElement => {
      const input = el('input', 'tl-number') as HTMLInputElement
      input.type = 'number'
      input.min = '0'
      input.max = '5'
      input.step = '1'
      input.title = title
      input.addEventListener('change', () => apply(Number(input.value)))
      return input
    }
    this.onionBeforeInput = onionCount('Ghosts shown before the playhead (0\u20135)', (value) =>
      editor.setOnionOptions({ onionBefore: value })
    )
    this.onionAfterInput = onionCount('Ghosts shown after the playhead (0\u20135)', (value) =>
      editor.setOnionOptions({ onionAfter: value })
    )
    onionGroup.append(this.onionBeforeInput, this.onionAfterInput)
    this.onionTintCheckbox = el('input', 'tl-check') as HTMLInputElement
    this.onionTintCheckbox.type = 'checkbox'
    this.onionTintCheckbox.title = 'Tint ghosts with the before/after colors'
    this.onionTintCheckbox.addEventListener('change', () =>
      editor.setOnionOptions({ onionTint: this.onionTintCheckbox.checked })
    )
    const tintLabel = el('span', 'tl-label', 'Tint')
    tintLabel.addEventListener('click', () => this.onionTintCheckbox.click())
    this.onionTintBeforeInput = el('input', 'tl-color') as HTMLInputElement
    this.onionTintBeforeInput.type = 'color'
    this.onionTintBeforeInput.title = 'Tint of the ghosts before the playhead'
    this.onionTintBeforeInput.addEventListener('input', () =>
      editor.setOnionOptions({ onionTintBefore: this.onionTintBeforeInput.value })
    )
    this.onionTintAfterInput = el('input', 'tl-color') as HTMLInputElement
    this.onionTintAfterInput.type = 'color'
    this.onionTintAfterInput.title = 'Tint of the ghosts after the playhead'
    this.onionTintAfterInput.addEventListener('input', () =>
      editor.setOnionOptions({ onionTintAfter: this.onionTintAfterInput.value })
    )
    this.onionOutlineCheckbox = el('input', 'tl-check') as HTMLInputElement
    this.onionOutlineCheckbox.type = 'checkbox'
    this.onionOutlineCheckbox.title = 'Draw ghosts as outlines only'
    this.onionOutlineCheckbox.addEventListener('change', () =>
      editor.setOnionOptions({ onionOutline: this.onionOutlineCheckbox.checked })
    )
    const outlineLabel = el('span', 'tl-label', 'Outline')
    outlineLabel.addEventListener('click', () => this.onionOutlineCheckbox.click())
    onionGroup.append(
      this.onionTintCheckbox,
      tintLabel,
      this.onionTintBeforeInput,
      this.onionTintAfterInput,
      this.onionOutlineCheckbox,
      outlineLabel
    )
    options.append(holdGroup, onionGroup)

    // Context menu shared by every layer and object row. Drawing layers get
    // the cell operations; object layers keep rename/delete only.
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
    const cellOp = (label: string, action: () => void): HTMLButtonElement => {
      const button = el('button', 'tl-context-item', label)
      button.addEventListener('click', () => {
        const target = this.menuTarget
        this.closeContextMenu()
        if (target) action()
      })
      return button
    }
    this.menuCellButtons = [
      cellOp('Insert Cell (F6)', () => void this.editor.insertCellHere()),
      cellOp('Insert Blank Cell (F7)', () => void this.editor.insertBlankCellHere()),
      cellOp('Clear Cell', () => void this.editor.clearCellHere()),
      cellOp('Remove Cell', () => this.editor.removeCellHere())
    ]
    // Keyframe actions, shown when the menu was opened on a marker.
    const keyframeOp = (label: string, action: (target: MenuTarget, frame: number) => void): HTMLButtonElement => {
      const button = el('button', 'tl-context-item', label)
      button.addEventListener('click', () => {
        const target = this.menuTarget
        this.closeContextMenu()
        if (target && target.nodeId && target.keyframeFrame !== undefined) {
          action(target, target.keyframeFrame)
        }
      })
      return button
    }
    const seekToMarker = (target: MenuTarget, frame: number): void => {
      this.editor.setCurrentLayer(target.layerId)
      this.editor.seekToFrame(frame)
      if (target.nodeId) this.editor.selectNodes([target.nodeId], 'replace')
    }
    this.menuKeyframeButtons = [
      keyframeOp('Insert Keyframe (F6)', (target, frame) => {
        seekToMarker(target, frame)
        this.editor.insertKeyframeHere()
      }),
      keyframeOp('Remove Keyframe', (target, frame) => {
        seekToMarker(target, frame)
        this.editor.removeKeyframeHere()
      }),
      keyframeOp('Copy Keyframe / Frame Range', (target, frame) => {
        if (target.nodeId) {
          this.selectedMarkers = new Set([markerKey(target.layerId, target.nodeId, frame)])
          this.focusedMarker = { layerId: target.layerId, nodeId: target.nodeId, frame }
          this.render()
        }
        this.copyKeyframes()
      })
    ]
    this.menuPasteKeyframeButton = keyframeOp('Paste Keyframe here', (target, frame) => {
      seekToMarker(target, frame)
      this.pasteKeyframes()
    })
    // Camera actions, shown for camera-layer context menus (row or marker).
    const cameraOp = (label: string, action: (target: MenuTarget) => void): HTMLButtonElement => {
      const button = el('button', 'tl-context-item', label)
      button.addEventListener('click', () => {
        const target = this.menuTarget
        this.closeContextMenu()
        if (target) action(target)
      })
      return button
    }
    const seekIntoTargetMarker = (target: MenuTarget): void => {
      this.editor.setCurrentLayer(target.layerId)
      if (target.keyframeFrame !== undefined) this.editor.seekToFrame(target.keyframeFrame)
    }
    this.menuCameraButtons = [
      cameraOp('Add Camera Keyframe', (target) => {
        seekIntoTargetMarker(target)
        this.editor.ensureCameraKeyframe()
      }),
      cameraOp('Remove Camera Keyframe', (target) => {
        seekIntoTargetMarker(target)
        this.editor.removeCameraKeyframeHere()
      }),
      cameraOp('Toggle Tween', (target) => {
        seekIntoTargetMarker(target)
        this.editor.toggleCameraTweenHere()
      })
    ]
    // Audio actions, shown for audio-layer context menus.
    this.menuAudioButtons = [
      cameraOp('Mute / Unmute', (target) => this.editor.toggleAudioMute(target.layerId))
    ]
    this.menuAudioVolumeRow = el('div', 'tl-context-item tl-context-volume')
    this.menuAudioVolumeRow.appendChild(el('span', undefined, 'Volume'))
    this.menuAudioVolumeInput = el('input', 'tl-number') as HTMLInputElement
    this.menuAudioVolumeInput.type = 'number'
    this.menuAudioVolumeInput.min = '0'
    this.menuAudioVolumeInput.max = '100'
    this.menuAudioVolumeInput.step = '5'
    this.menuAudioVolumeInput.title = 'Clip volume in percent (0–100)'
    this.menuAudioVolumeInput.addEventListener('change', () => {
      const target = this.menuTarget
      if (target) {
        this.editor.setAudioLayerVolume(target.layerId, Number(this.menuAudioVolumeInput.value) / 100)
      }
    })
    this.menuAudioVolumeRow.appendChild(this.menuAudioVolumeInput)
    this.menuResolutionRow = el('div', 'tl-context-item tl-context-resolution')
    this.menuResolutionRow.appendChild(el('span', undefined, 'Cell resolution'))
    this.menuResolutionInput = el('input', 'tl-number') as HTMLInputElement
    this.menuResolutionInput.type = 'number'
    this.menuResolutionInput.min = '1'
    this.menuResolutionInput.max = '4'
    this.menuResolutionInput.step = '1'
    this.menuResolutionInput.title =
      'Cell buffer size in multiples of the stage size; affects new cells only'
    this.menuResolutionInput.addEventListener('change', () => {
      const target = this.menuTarget
      if (target) {
        this.editor.setDrawingResolution(target.layerId, Number(this.menuResolutionInput.value))
      }
    })
    this.menuResolutionRow.appendChild(this.menuResolutionInput)
    // "Move to frame": objects move their whole span, drawing layers move the
    // cell at the playhead.
    this.menuMoveRow = el('div', 'tl-context-item tl-context-move')
    this.menuMoveRow.appendChild(el('span', undefined, 'Move to frame'))
    this.menuMoveInput = el('input', 'tl-number') as HTMLInputElement
    this.menuMoveInput.type = 'number'
    this.menuMoveInput.min = '1'
    this.menuMoveInput.title = 'Frame (1-based) to move the target to'
    this.menuMoveInput.addEventListener('change', () => {
      const target = this.menuTarget
      const value = Number(this.menuMoveInput.value)
      if (!target || !Number.isFinite(value)) return
      const frame = Math.floor(value) - 1
      this.editor.setCurrentLayer(target.layerId)
      const layer = getLayer(this.editor.document, target.layerId)
      let moved = false
      if (target.nodeId) {
        moved = this.editor.moveNodeToFrame(target.nodeId, frame)
        if (moved) this.editor.selectNodes([target.nodeId], 'replace')
      } else if (layer && isCameraLayer(layer)) {
        if (target.keyframeFrame !== undefined) {
          moved = this.editor.moveCameraKeyframeEntry(target.keyframeFrame, frame, target.layerId)
        }
      } else if (layer && isAudioLayer(layer)) {
        moved = this.editor.setAudioClipStart(target.layerId, frame)
      } else {
        const range = layer && isDrawingLayer(layer)
          ? cellRangeAtFrame(layer, this.editor.currentFrame, this.editor.duration)
          : null
        if (range) moved = this.editor.moveCellToFrame(range.cellFrame, frame)
      }
      if (moved) this.closeContextMenu()
    })
    this.menuMoveRow.appendChild(this.menuMoveInput)
    this.menu.append(
      this.menuRenameButton,
      this.menuMoveRow,
      ...this.menuKeyframeButtons,
      this.menuPasteKeyframeButton,
      ...this.menuCameraButtons,
      ...this.menuAudioButtons,
      this.menuAudioVolumeRow,
      ...this.menuCellButtons,
      this.menuResolutionRow,
      this.menuDeleteButton
    )
    window.addEventListener('pointerdown', (event) => {
      if (this.menu.classList.contains('hidden')) return
      if (event.target instanceof Node && this.menu.contains(event.target)) return
      this.closeContextMenu()
    })
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeContextMenu()
    })

    const ruler = el('div', 'tl-ruler')
    ruler.addEventListener('pointerdown', (event) => this.onRulerPointerDown(event))
    this.rowsHost = el('div', 'tl-rows')
    this.playhead = el('div', 'tl-playhead')
    this.rangeBand = el('div', 'tl-range hidden')
    this.content = el('div', 'tl-content')
    this.content.append(ruler, this.rowsHost, this.playhead, this.rangeBand)

    const scroll = el('div', 'tl-scroll')
    scroll.appendChild(this.content)
    scroll.addEventListener('pointerdown', (event) => {
      // Ctrl+C/V act on the keyframe clipboard while the timeline is the
      // surface the user touched last.
      setActiveSurface('timeline')
      this.onTrackPointerDown(event)
    })

    container.append(controls, options, scroll, this.menu)

    editor.onDocChange(() => this.render())
    editor.onFrameChange(() => {
      this.updatePlayhead()
      this.refreshNodeKeyframeButtons()
      this.refreshNodeTweenButtons()
    })
    editor.onUiChange(() => this.render())
    // A freshly decoded audio resource unlocks its clip length and waveform.
    editor.audio.onDecoded?.(() => this.render())
    this.render()
  }

  private onTrackPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement
    // An inline rename field must survive selection changes.
    if (target instanceof HTMLInputElement) return
    const frameTarget = target.closest<HTMLElement>('[data-frame]')
    if (frameTarget?.dataset.frame !== undefined) {
      this.editor.seekToFrame(Number(frameTarget.dataset.frame))
      return
    }
    const track = target.closest<HTMLElement>('.tl-track')
    if (track?.dataset.frames !== undefined) {
      this.seekIntoTrack(event, track)
      return
    }
    const shapeRow = target.closest<HTMLElement>('.tl-shape-row')
    if (shapeRow?.dataset.shapeId) {
      this.editor.setCurrentLayer(shapeRow.dataset.layerId!)
      this.editor.selectNodes([shapeRow.dataset.shapeId], event.shiftKey ? 'toggle' : 'replace')
      return
    }
    const row = target.closest<HTMLElement>('.tl-row')
    if (row?.dataset.layerId) {
      this.editor.setCurrentLayer(row.dataset.layerId)
    }
  }

  /**
   * Track clicks seek by geometry: the frame is derived from the pointer
   * position instead of one element per frame, keeping the DOM tiny on long
   * timelines. Clicking an object's track also selects the object and its
   * layer; clicking a layer track makes that layer current.
   */
  private seekIntoTrack(event: PointerEvent, track: HTMLElement): void {
    const rect = track.getBoundingClientRect()
    const frames = Number(track.dataset.frames)
    const offset = event.clientX - rect.left
    const frame = Math.max(0, Math.min(frames - 1, Math.floor(offset / FRAME_WIDTH)))
    const row = track.closest<HTMLElement>('.tl-row')
    if (row?.dataset.layerId) this.editor.setCurrentLayer(row.dataset.layerId)
    if (row?.classList.contains('tl-shape-row') && row.dataset.shapeId) {
      this.editor.selectNodes([row.dataset.shapeId], event.shiftKey ? 'toggle' : 'replace')
    }
    this.editor.seekToFrame(frame)
  }

  /**
   * Marker press: plain click (re)selects and seeks, shift+click toggles the
   * marker in the selection. Past a small pointer threshold the press becomes
   * a drag that previews a uniform frame delta and, on release, moves every
   * selected entry of this layer in one undo step (clamped to the timeline).
   */
  private onMarkerPointerDown(event: PointerEvent, layerId: string, nodeId: string, frame: number): void {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    const key = markerKey(layerId, nodeId, frame)
    if (event.shiftKey) {
      if (this.selectedMarkers.has(key)) this.selectedMarkers.delete(key)
      else this.selectedMarkers.add(key)
    } else if (!this.selectedMarkers.has(key)) {
      this.selectedMarkers.clear()
      this.selectedMarkers.add(key)
    }
    this.focusedMarker = { layerId, nodeId, frame }
    this.editor.setCurrentLayer(layerId)
    // Camera markers hold no node: only the layer becomes current.
    if (nodeId !== CAMERA_MARKER_NODE) this.editor.selectNodes([nodeId], 'replace')
    this.editor.seekToFrame(frame)

    const drag = { layerId, startX: event.clientX, startY: event.clientY, pointerId: event.pointerId, dragging: false }
    this.markerDrag = drag
    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== event.pointerId || this.markerDrag !== drag) return
      const dx = moveEvent.clientX - drag.startX
      const dy = moveEvent.clientY - drag.startY
      if (!drag.dragging && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
      drag.dragging = true
      this.previewMarkerDrag(drag.layerId, this.clampMarkerDelta(drag.layerId, Math.round(dx / FRAME_WIDTH)))
    }
    const onUp = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== event.pointerId) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (this.markerDrag !== drag) return
      this.markerDrag = null
      const delta = this.clampMarkerDelta(drag.layerId, Math.round((upEvent.clientX - drag.startX) / FRAME_WIDTH))
      if (drag.dragging && delta !== 0) this.applyMarkerDrag(drag.layerId, delta)
      this.render()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    this.render()
  }

  /** Uniformly clamped frame delta for the selected markers of one layer. */
  private clampMarkerDelta(layerId: string, delta: number): number {
    let min = Infinity
    let max = -Infinity
    for (const key of this.selectedMarkers) {
      const marker = parseMarkerKey(key)
      if (marker.layerId !== layerId) continue
      min = Math.min(min, marker.frame)
      max = Math.max(max, marker.frame)
    }
    if (min === Infinity) return 0
    return Math.min(this.editor.duration - 1 - max, Math.max(-min, delta))
  }

  /** Live drag feedback: slides the selected markers of one layer by `delta`. */
  private previewMarkerDrag(layerId: string, delta: number): void {
    for (const element of this.rowsHost.querySelectorAll<HTMLElement>('.tl-key')) {
      const elementLayer = element.dataset.layerId
      const elementNode = element.dataset.shapeId
      const elementFrame = Number(element.dataset.frame)
      if (!elementLayer || !elementNode || !Number.isFinite(elementFrame)) continue
      const selected = this.selectedMarkers.has(markerKey(elementLayer, elementNode, elementFrame))
      element.style.transform =
        selected && elementLayer === layerId ? `translateX(${delta * FRAME_WIDTH}px)` : ''
    }
  }

  /** Moves every selected entry of one layer by the uniform delta, one undo step. */
  private applyMarkerDrag(layerId: string, delta: number): void {
    const layer = getLayer(this.editor.document, layerId)
    const refs = [...this.selectedMarkers]
      .map(parseMarkerKey)
      .filter((marker) => marker.layerId === layerId)
    if (!layer || refs.length === 0) return
    if (isCameraLayer(layer)) {
      const cameraMoves = refs.map((marker) => ({
        fromFrame: marker.frame,
        toFrame: marker.frame + delta
      }))
      if (this.editor.moveCameraKeyframes(cameraMoves, layerId)) {
        this.selectedMarkers = new Set(
          cameraMoves.map((move) => markerKey(layerId, CAMERA_MARKER_NODE, move.toFrame))
        )
        if (this.focusedMarker?.layerId === layerId) {
          this.focusedMarker = { ...this.focusedMarker, frame: this.focusedMarker.frame + delta }
        }
      }
      return
    }
    const moves: Array<{ nodeId: string; fromFrame: number; toFrame: number }> = []
    for (const marker of refs) {
      moves.push({ nodeId: marker.nodeId, fromFrame: marker.frame, toFrame: marker.frame + delta })
    }
    if (this.editor.moveNodeKeyframeEntries(moves, layerId)) {
      this.selectedMarkers = new Set(moves.map((move) => markerKey(layerId, move.nodeId, move.toFrame)))
      if (this.focusedMarker?.layerId === layerId) {
        this.focusedMarker = { ...this.focusedMarker, frame: this.focusedMarker.frame + delta }
      }
    }
  }

  /**
   * Ruler press-drag defines the copy range (an inclusive frame band shown as
   * `.tl-range`); a plain click clears the band.
   */
  private onRulerPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    event.preventDefault()
    const ruler = event.currentTarget as HTMLElement
    const bounds = ruler.getBoundingClientRect()
    const frames = Math.max(this.editor.duration, MIN_FRAMES)
    const frameAt = (clientX: number): number =>
      Math.max(0, Math.min(frames - 1, Math.floor((clientX - bounds.left - HEAD_WIDTH) / FRAME_WIDTH)))
    const drag = { startFrame: frameAt(event.clientX), pointerId: event.pointerId, active: false }
    this.rulerDrag = drag
    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== event.pointerId || this.rulerDrag !== drag) return
      const end = frameAt(moveEvent.clientX)
      if (!drag.active && end === drag.startFrame) return
      drag.active = true
      this.rangeSelection = {
        start: Math.min(drag.startFrame, end),
        end: Math.max(drag.startFrame, end)
      }
      this.updateRangeBand()
    }
    const onUp = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== event.pointerId) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (this.rulerDrag !== drag) return
      this.rulerDrag = null
      if (!drag.active) this.rangeSelection = null
      this.updateRangeBand()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  private updateRangeBand(): void {
    const range = this.rangeSelection
    if (!range) {
      this.rangeBand.classList.add('hidden')
      return
    }
    this.rangeBand.classList.remove('hidden')
    this.rangeBand.style.left = `${HEAD_WIDTH + range.start * FRAME_WIDTH}px`
    this.rangeBand.style.width = `${(range.end - range.start + 1) * FRAME_WIDTH}px`
  }

  /**
   * Copies keyframes of the current layer to the session clipboard (Ctrl+C):
   * the range is the ruler band when one is dragged, otherwise the bounding
   * range of the selected markers (of the selected nodes), otherwise the
   * focused marker. The chunk keeps each pose's relative timing and the tween
   * of its first keyframe.
   */
  copyKeyframes(): void {
    const editor = this.editor
    const layer = editor.currentLayer
    if (!layer || !isObjectLayer(layer)) {
      editor.showMessage('Copy keyframes: select an object layer first')
      return
    }
    let start: number
    let end: number
    let nodeIds: string[] | undefined
    if (this.rangeSelection) {
      start = this.rangeSelection.start
      end = this.rangeSelection.end
    } else {
      const ownedMarkers = [...this.selectedMarkers]
        .map(parseMarkerKey)
        .filter(
          (marker) =>
            marker.layerId === layer.id &&
            layer.keyframes.some(
              (keyframe) =>
                keyframe.frame === marker.frame &&
                keyframe.nodes.some((node) => node.id === marker.nodeId)
            )
        )
      if (ownedMarkers.length > 0) {
        start = Math.min(...ownedMarkers.map((marker) => marker.frame))
        end = Math.max(...ownedMarkers.map((marker) => marker.frame))
        nodeIds = [...new Set(ownedMarkers.map((marker) => marker.nodeId))]
      } else if (this.focusedMarker?.layerId === layer.id) {
        start = this.focusedMarker.frame
        end = this.focusedMarker.frame
        nodeIds = [this.focusedMarker.nodeId]
      } else {
        editor.showMessage('Copy keyframes: select keyframe markers or drag a range on the ruler')
        return
      }
    }
    const entries = extractKeyframeChunk(layer, start, end, nodeIds)
    if (entries.length === 0) {
      editor.showMessage(`Copy keyframes: nothing in frames ${start + 1}\u2013${end + 1} on "${layer.name}"`)
      return
    }
    this.clipboard = { entries }
    editor.showMessage(`Copied ${entries.length} keyframe ${entries.length === 1 ? 'entry' : 'entries'}`)
  }

  /**
   * Pastes the copied chunk at the playhead on the current layer (Ctrl+V):
   * poses keep their offsets, merge into existing keyframes and restore a
   * carried tween only where none exists. One undo step.
   */
  pasteKeyframes(): void {
    const editor = this.editor
    if (!this.clipboard) {
      editor.showMessage('Paste keyframes: the clipboard is empty')
      return
    }
    const count = this.clipboard.entries.length
    if (!editor.copyKeyframeChunk(editor.currentLayerId, this.clipboard.entries, editor.currentFrame)) {
      editor.showMessage('Paste keyframes: nothing lands at the playhead on this layer')
      return
    }
    editor.showMessage(`Pasted ${count} keyframe ${count === 1 ? 'entry' : 'entries'}`)
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

    this.nodeKeyframeButtons = []
    this.nodeTweenButtons = []
    this.rowsHost.textContent = ''
    for (const layer of doc.layers) {
      this.rowsHost.appendChild(this.buildLayerGroup(layer, frames))
    }
    // The layer list always ends with the lines to append a layer of either kind.
    for (const row of this.buildAddLayerRows()) {
      this.rowsHost.appendChild(row)
    }

    // Playback state lives on the top controls now.
    this.playButton.textContent = editor.playing ? 'Pause' : 'Play'
    this.loopButton.classList.toggle('active', editor.loop)
    if (document.activeElement !== this.fpsInput) this.fpsInput.value = String(doc.fps)
    this.refreshOptionsRow()

    this.refreshNodeKeyframeButtons()
    this.refreshNodeTweenButtons()
    this.updatePlayhead()
    this.updateRangeBand()
  }

  /** Mirrors the hold step and the onion-skin options onto the options row. */
  private refreshOptionsRow(): void {
    const editor = this.editor
    const step = String(editor.holdStep)
    if (!Array.from(this.holdSelect.options).some((option) => option.value === step)) {
      const option = document.createElement('option')
      option.value = step
      option.textContent = step
      this.holdSelect.appendChild(option)
    }
    this.holdSelect.value = step
    this.scrubAudioCheckbox.checked = editor.scrubAudio
    this.onionCheckbox.checked = editor.onionSkin
    if (document.activeElement !== this.onionBeforeInput) {
      this.onionBeforeInput.value = String(editor.onionBefore)
    }
    if (document.activeElement !== this.onionAfterInput) {
      this.onionAfterInput.value = String(editor.onionAfter)
    }
    this.onionTintCheckbox.checked = editor.onionTint
    this.onionTintBeforeInput.value = editor.onionTintBefore
    this.onionTintAfterInput.value = editor.onionTintAfter
    this.onionOutlineCheckbox.checked = editor.onionOutline
  }

  /** A layer row, followed by its child rows while expanded: per-object rows
   * for object layers, the cell filmstrip for drawing layers. */
  private buildLayerGroup(layer: Layer, frames: number): HTMLDivElement {
    const group = el('div', 'tl-layer-group')
    const expanded = this.expandedLayers.has(layer.id)

    group.appendChild(this.buildLayerRow(layer, expanded, frames))

    if (expanded) {
      if (isDrawingLayer(layer)) {
        group.appendChild(this.buildFilmstripRow(layer, frames))
      } else if (isObjectLayer(layer)) {
        const nodes = this.collectAllNodes(layer)
        if (nodes.length === 0) {
          group.appendChild(this.buildEmptyNodeRow(frames))
        } else {
          for (const node of nodes) {
            group.appendChild(this.buildNodeRow(layer, node, frames))
          }
        }
      }
      // Camera and audio layers have no child rows: their markers and clip
      // span live on the layer row itself.
    }

    return group
  }

  private buildLayerRow(layer: Layer, expanded: boolean, frames: number): HTMLDivElement {
    const editor = this.editor
    const row = el('div', 'tl-row')
    row.dataset.layerId = layer.id
    if (layer.id === editor.currentLayerId) row.classList.add('current')

    const head = el('div', 'tl-head')
    const expandable = isObjectLayer(layer) || isDrawingLayer(layer)
    const toggle = el('span', 'tl-toggle', expandable ? (expanded ? '▾' : '▸') : '')
    toggle.title = expanded ? 'Collapse layer' : 'Expand layer'
    if (expandable) {
      toggle.addEventListener('click', (event) => {
        event.stopPropagation()
        this.toggleExpand(layer.id)
      })
    }
    const visibilityButton = el('button', 'tl-icon', layer.visible ? '◉' : '○')
    visibilityButton.title = layer.visible
      ? isAudioLayer(layer)
        ? 'Mute this audio layer'
        : 'Hide layer'
      : isAudioLayer(layer)
        ? 'Unmute this audio layer'
        : 'Show layer'
    visibilityButton.addEventListener('click', (event) => {
      event.stopPropagation()
      editor.toggleLayerVisibility(layer.id)
    })
    const name = el('span', 'name', layer.name)
    name.title = layer.name
    // Kind badge: object (keyframes/tweens), drawing (frame-by-frame cells),
    // camera (keyframed framing) or audio (one clip).
    let badgeGlyph = '\u25a3'
    let badgeTitle = 'Object layer: keyframes and tweens'
    if (isDrawingLayer(layer)) {
      badgeGlyph = '\u270e'
      badgeTitle = 'Drawing layer: one raster cell per frame span, never tweened'
    } else if (isCameraLayer(layer)) {
      badgeGlyph = '\u25c9'
      badgeTitle = 'Camera layer: keyframed camera framing, applied in renders and exports'
    } else if (isAudioLayer(layer)) {
      badgeGlyph = '\u266a'
      badgeTitle = layer.visible
        ? 'Audio layer: one clip, mixed into WebM/MP4 exports'
        : 'Audio layer (muted): hidden from playback and exports'
    }
    const kindBadge = el('span', 'tl-kind', badgeGlyph)
    kindBadge.title = badgeTitle
    const lockButton = el('button', 'tl-icon', layer.locked ? 'L' : '·')
    lockButton.title = layer.locked ? 'Unlock layer' : 'Lock layer'
    lockButton.addEventListener('click', (event) => {
      event.stopPropagation()
      editor.toggleLayerLock(layer.id)
    })
    lockButton.classList.toggle('active', layer.locked)
    head.append(toggle, visibilityButton, name, kindBadge, lockButton)
    head.addEventListener('click', (event) => {
      if (event.target instanceof HTMLInputElement) return
      editor.setCurrentLayer(layer.id)
    })
    row.appendChild(head)

    // Right-click: rename or delete the layer.
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.openContextMenu({ layerId: layer.id, nodeId: null }, event)
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

    // Track: camera rows carry their keyframe markers directly; audio rows
    // carry the clip span with its waveform.
    let track: HTMLDivElement
    if (isCameraLayer(layer)) {
      track = this.buildCameraTrack(layer, frames)
    } else if (isAudioLayer(layer)) {
      track = this.buildAudioTrack(layer, frames)
      this.wireDropTarget(track, layer.id)
    } else {
      track = this.buildBarTrack(null, null, frames)
      this.wireDropTarget(track, layer.id)
    }
    row.appendChild(track)
    return row
  }

  /** Lines at the end of the layer list to append a layer of every kind. */
  private buildAddLayerRows(): HTMLDivElement[] {
    const objectRow = el('div', 'tl-add-layer', '+ Object Layer')
    objectRow.title = 'Add an object layer (keyframes and tweens) at the bottom of the stack'
    objectRow.addEventListener('click', () => this.editor.addLayerAtBottom('object'))
    const drawingRow = el('div', 'tl-add-layer', '+ Drawing Layer')
    drawingRow.title = 'Add a drawing layer (frame-by-frame cells) at the bottom of the stack'
    drawingRow.addEventListener('click', () => this.editor.addLayerAtBottom('drawing'))
    const cameraRow = el('div', 'tl-add-layer', '+ Camera Layer')
    cameraRow.title =
      'Add the document camera layer (at most one): keyframed framing applied to renders and exports'
    cameraRow.addEventListener('click', () => this.editor.addCameraLayer())
    const audioRow = el('div', 'tl-add-layer', '+ Audio Layer\u2026')
    audioRow.title = 'Import a WAV, MP3 or OGG file as a new audio layer'
    audioRow.addEventListener('click', () => void importAudioViaDialog(this.editor))
    return [objectRow, drawingRow, cameraRow, audioRow]
  }

  /**
   * Track of a camera layer: a marker on every camera keyframe (drag to
   * retime — the marker set is the document camera's own keyframes) and a
   * tween span running to the next keyframe.
   */
  private buildCameraTrack(layer: CameraLayer, frames: number): HTMLDivElement {
    const track = this.buildBarTrack(null, null, frames)
    const sorted = [...layer.keyframes].sort((a, b) => a.frame - b.frame)
    for (let i = 0; i < sorted.length; i++) {
      const keyframe = sorted[i]
      const next = sorted[i + 1]
      if (keyframe.tween && next) {
        const tweenSpan = el('div', 'tl-tween')
        tweenSpan.style.left = `${keyframe.frame * FRAME_WIDTH}px`
        tweenSpan.style.width = `${(next.frame - keyframe.frame) * FRAME_WIDTH}px`
        track.appendChild(tweenSpan)
      }
      const marker = el('div', 'tl-key tl-key-camera')
      marker.style.left = `${keyframe.frame * FRAME_WIDTH + FRAME_WIDTH / 2}px`
      marker.dataset.frame = String(keyframe.frame)
      marker.dataset.layerId = layer.id
      marker.dataset.shapeId = CAMERA_MARKER_NODE
      marker.title = `Camera keyframe ${keyframe.frame + 1}${keyframe.tween ? ' · tween' : ''} — drag to retime, shift-click to multi-select, right-click for actions`
      if (this.selectedMarkers.has(markerKey(layer.id, CAMERA_MARKER_NODE, keyframe.frame))) {
        marker.classList.add('selected')
      }
      marker.addEventListener('pointerdown', (event) =>
        this.onMarkerPointerDown(event, layer.id, CAMERA_MARKER_NODE, keyframe.frame)
      )
      marker.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.openContextMenu({ layerId: layer.id, nodeId: null, keyframeFrame: keyframe.frame }, event)
      })
      track.appendChild(marker)
    }
    return track
  }

  /**
   * Track of an audio layer: the clip span (start frame through the decoded
   * duration — one frame until the resource decodes) with its waveform, and
   * drag-to-move onto any frame.
   */
  private buildAudioTrack(layer: AudioLayer, frames: number): HTMLDivElement {
    const editor = this.editor
    const track = el('div', 'tl-track tl-audio-track')
    track.dataset.frames = String(frames)
    track.style.width = `${frames * FRAME_WIDTH}px`
    track.style.height = `${ROW_HEIGHT}px`
    if (layer.startFrame >= frames) return track
    const seconds = editor.audio.durationSeconds?.(layer.resourceId) ?? null
    const endFrame =
      seconds === null
        ? layer.startFrame + 1
        : Math.max(layer.startFrame + 1, audioClipEndFrame(editor.document, layer, seconds))
    const visibleEnd = Math.min(endFrame, frames)
    const width = (visibleEnd - layer.startFrame) * FRAME_WIDTH
    const clip = el('div', 'tl-clip')
    clip.style.left = `${layer.startFrame * FRAME_WIDTH}px`
    clip.style.width = `${width}px`
    clip.title = layer.visible
      ? `Audio "${layer.name}" — starts at frame ${layer.startFrame + 1}; drag onto a frame to move it`
      : `Audio "${layer.name}" is muted (hidden from playback and exports)`
    if (!layer.visible) clip.classList.add('tl-clip-muted')
    const peaks = editor.audio.peaks?.(layer.resourceId, Math.max(1, Math.round(width / 2))) ?? null
    if (peaks) {
      const canvas = el('canvas', 'tl-waveform') as HTMLCanvasElement
      const pixelWidth = Math.max(1, Math.round(width))
      const height = ROW_HEIGHT - 10
      canvas.width = pixelWidth
      canvas.height = height
      canvas.style.width = `${pixelWidth}px`
      canvas.style.height = `${height}px`
      const context = canvas.getContext('2d')
      if (context) {
        context.fillStyle = WAVEFORM_COLOR
        const mid = height / 2
        for (let i = 0; i < peaks.length; i++) {
          const x = ((i + 0.5) / peaks.length) * pixelWidth - 0.5
          const top = mid - Math.max(0, peaks[i].max) * mid
          const bottom = mid - Math.min(0, peaks[i].min) * mid
          context.fillRect(x, top, 1, Math.max(1, bottom - top))
        }
      }
      clip.appendChild(canvas)
    } else {
      clip.classList.add('tl-clip-pending')
    }
    // Dragging the clip body moves the whole clip: dropping on a frame makes
    // that frame the new start (frames snap, the clips never stretches).
    clip.setAttribute('draggable', 'true')
    clip.addEventListener('dragstart', (event) => {
      this.draggedAudio = { layerId: layer.id }
      if (event.dataTransfer) {
        event.dataTransfer.setData('text/plain', layer.id)
        event.dataTransfer.effectAllowed = 'move'
      }
      clip.classList.add('dragging')
    })
    clip.addEventListener('dragend', () => this.clearDragState())
    track.appendChild(clip)
    return track
  }

  /**
   * Filmstrip of a drawing layer: one element per maximal run of frames that
   * resolve to the same cell (a held cell repeats until the next one; frames
   * before the first cell render blank). Clicking a frame seeks the playhead.
   */
  private buildFilmstripRow(layer: DrawingLayer, frames: number): HTMLDivElement {
    const row = el('div', 'tl-row tl-filmstrip-row')
    row.dataset.layerId = layer.id
    const head = el('div', 'tl-head')
    const label = el('span', 'name', 'cells')
    label.style.color = 'var(--muted)'
    head.appendChild(label)
    row.appendChild(head)

    const track = el('div', 'tl-track tl-filmstrip')
    track.dataset.frames = String(frames)
    track.style.width = `${frames * FRAME_WIDTH}px`
    track.style.height = `${ROW_HEIGHT}px`
    for (const span of filmstripSpans(layer, frames)) {
      const cell = el('div', 'tl-cell tl-filmstrip-cell')
      cell.style.left = `${span.start * FRAME_WIDTH}px`
      cell.style.width = `${(span.end - span.start) * FRAME_WIDTH}px`
      const url = span.resourceId ? this.editor.resources.getUrl(span.resourceId) : null
      if (url) {
        const thumb = document.createElement('img')
        thumb.className = 'tl-filmstrip-thumb'
        thumb.src = url
        thumb.alt = ''
        thumb.draggable = false
        cell.appendChild(thumb)
      } else {
        cell.classList.add('tl-cell-blank')
      }
      // A held span starts exactly on its cell's frame: dragging it moves
      // that cell to the drop frame.
      if (span.resourceId) {
        cell.setAttribute('draggable', 'true')
        cell.title = `Cell starting at frame ${span.start + 1} — drag to a frame to move it`
        cell.addEventListener('dragstart', (event) => {
          this.draggedCell = { layerId: layer.id, frame: span.start }
          if (event.dataTransfer) {
            event.dataTransfer.setData('text/plain', `${layer.id}:${span.start}`)
            event.dataTransfer.effectAllowed = 'move'
          }
          cell.classList.add('dragging')
        })
        cell.addEventListener('dragend', () => this.clearDragState())
      }
      track.appendChild(cell)
    }
    this.wireDropTarget(track, layer.id)
    row.appendChild(track)
    return row
  }

  private buildEmptyNodeRow(frames: number): HTMLDivElement {
    const row = el('div', 'tl-row tl-shape-row')
    const head = el('div', 'tl-head')
    const label = el('span', 'name', 'no objects on this layer')
    label.style.fontStyle = 'italic'
    label.style.color = 'var(--muted)'
    head.appendChild(label)
    row.appendChild(head)
    row.appendChild(this.buildBarTrack(null, null, frames))
    return row
  }

  private buildNodeRow(layer: ObjectLayer, node: SceneNode, frames: number): HTMLDivElement {
    const editor = this.editor
    const row = el('div', 'tl-row tl-shape-row')
    row.dataset.layerId = layer.id
    row.dataset.shapeId = node.id
    if (editor.selectedNodeIds.includes(node.id)) row.classList.add('selected')

    const head = el('div', 'tl-head')
    const swatch = el('span', 'tl-swatch')
    swatch.style.background = nodeColor(node)
    const label = el('span', 'name', nodeLabel(node))
    label.title = label.textContent ?? ''
    const span = this.getNodeFrameSpan(layer, node.id)
    const kfLabel = el('span', 'tl-kf-label', span ? `${span.start + 1}\u2013${span.end}` : '')

    // Tween toggle: only meaningful when this object owns the keyframe at the
    // current frame and has an earlier keyframe to animate from.
    const tweenButton = el('button', 'tl-icon tl-shape-tween', '\u2248')
    tweenButton.dataset.layerId = layer.id
    tweenButton.dataset.shapeId = node.id
    this.nodeTweenButtons.push(tweenButton)
    tweenButton.addEventListener('click', (event) => {
      event.stopPropagation()
      editor.setCurrentLayer(layer.id)
      editor.toggleTweenHere()
    })

    // Per-object keyframe button: ◇ adds a keyframe, × deletes it.
    const kfButton = el('button', 'tl-icon tl-shape-kf', '\u25c7')
    kfButton.dataset.layerId = layer.id
    kfButton.dataset.shapeId = node.id
    this.nodeKeyframeButtons.push(kfButton)
    kfButton.addEventListener('click', (event) => {
      event.stopPropagation()
      editor.setCurrentLayer(layer.id)
      editor.selectNodes([node.id], 'replace')
      if (editor.hasNodeKeyframeAt(layer.id, node.id, editor.currentFrame)) {
        editor.removeNodeKeyframe(node.id)
      } else {
        editor.ensureNodeKeyframe(node.id)
      }
    })

    head.append(swatch, label, kfLabel, tweenButton, kfButton)
    head.addEventListener('click', (event) => {
      if (event.target instanceof HTMLInputElement) return
      editor.setCurrentLayer(layer.id)
      editor.selectNodes([node.id], event.shiftKey ? 'toggle' : 'replace')
    })
    row.appendChild(head)

    // Right-click: rename or delete the object.
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.openContextMenu({ layerId: layer.id, nodeId: node.id }, event)
    })

    row.appendChild(this.buildNodeTrack(layer, node, frames))
    return row
  }

  /**
   * Track of one object: its frame-span bar plus a marker on every keyframe
   * that holds the object and a tween span running to the object's next
   * keyframe. Layer rows intentionally carry no keyframe markers.
   */
  private buildNodeTrack(layer: ObjectLayer, node: SceneNode, frames: number): HTMLDivElement {
    const span = this.getNodeFrameSpan(layer, node.id)
    const track = this.buildBarTrack(
      span ? span.start : null,
      span ? span.end : null,
      frames,
      nodeColor(node)
    )
    this.wireDropTarget(track, layer.id)
    // The span bar drags the object: dropping on a frame moves every
    // keyframe of this object so its first keyframe lands there.
    const bar = track.querySelector<HTMLElement>('.tl-shape-span')
    if (bar) {
      bar.setAttribute('draggable', 'true')
      bar.addEventListener('dragstart', (event) => {
        this.draggedNode = { layerId: layer.id, nodeId: node.id }
        if (event.dataTransfer) {
          event.dataTransfer.setData('text/plain', `${layer.id}:${node.id}`)
          event.dataTransfer.effectAllowed = 'move'
        }
        bar.classList.add('dragging')
      })
      bar.addEventListener('dragend', () => this.clearDragState())
    }
    const sorted = [...layer.keyframes].sort((a, b) => a.frame - b.frame)
    for (let i = 0; i < sorted.length; i++) {
      const keyframe = sorted[i]
      if (!keyframe.nodes.some((candidate) => candidate.id === node.id)) continue
      const next = sorted
        .slice(i + 1)
        .find((candidate) => candidate.nodes.some((s) => s.id === node.id))
      if (keyframe.tween && next) {
        const tweenSpan = el('div', 'tl-tween')
        tweenSpan.style.left = `${keyframe.frame * FRAME_WIDTH}px`
        tweenSpan.style.width = `${(next.frame - keyframe.frame) * FRAME_WIDTH}px`
        track.appendChild(tweenSpan)
      }
      const marker = el('div', 'tl-key')
      marker.style.left = `${keyframe.frame * FRAME_WIDTH + FRAME_WIDTH / 2}px`
      marker.dataset.frame = String(keyframe.frame)
      marker.dataset.layerId = layer.id
      marker.dataset.shapeId = node.id
      marker.title = `Keyframe ${keyframe.frame + 1}${keyframe.tween ? ' · tween' : ''} — drag to retime, shift-click to multi-select, right-click for actions`
      if (this.selectedMarkers.has(markerKey(layer.id, node.id, keyframe.frame))) {
        marker.classList.add('selected')
      }
      marker.addEventListener('pointerdown', (event) =>
        this.onMarkerPointerDown(event, layer.id, node.id, keyframe.frame)
      )
      marker.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.openContextMenu({ layerId: layer.id, nodeId: node.id, keyframeFrame: keyframe.frame }, event)
      })
      track.appendChild(marker)
    }
    return track
  }

  /** Track with pointer-geometry seeking and an optional span bar for one row height. */
  private buildBarTrack(
    spanStart: number | null,
    spanEnd: number | null,
    frames: number,
    fill?: string
  ): HTMLDivElement {
    const track = el('div', 'tl-track')
    track.dataset.frames = String(frames)
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
    return track
  }

  /**
   * Refreshes the per-object keyframe buttons after a seek: each button shows
   * ◇ (add) or × (delete) depending on whether ITS shape owns a keyframe at
   * the current frame. Avoids a full re-render during playback.
   */
  private refreshNodeKeyframeButtons(): void {
    const editor = this.editor
    for (const button of this.nodeKeyframeButtons) {
      const layerId = button.dataset.layerId
      const nodeId = button.dataset.shapeId
      if (!layerId || !nodeId) continue
      const keyed = editor.hasNodeKeyframeAt(layerId, nodeId, editor.currentFrame)
      button.textContent = keyed ? '\u00d7' : '\u25c7'
      button.title = keyed
        ? `Remove the keyframe of this object at frame ${editor.currentFrame + 1}`
        : `Add a keyframe for this object at frame ${editor.currentFrame + 1}`
    }
  }

  /** Refreshes the per-object tween toggles after a seek. */
  private refreshNodeTweenButtons(): void {
    const editor = this.editor
    for (const button of this.nodeTweenButtons) {
      const layerId = button.dataset.layerId
      const nodeId = button.dataset.shapeId
      if (!layerId || !nodeId) continue
      const layer = getLayer(editor.document, layerId)
      if (!layer || !isObjectLayer(layer)) continue
      const keyframe = findKeyframeAtFrame(layer, editor.currentFrame)
      const keyed = keyframe?.nodes.some((node) => node.id === nodeId) ?? false
      const previousIndex = findNearestNodeKeyframeIndex(layer, nodeId, editor.currentFrame - 1)
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
    const drawing = isDrawingLayer(layer)
    const camera = isCameraLayer(layer)
    const audio = isAudioLayer(layer)
    for (const button of this.menuCellButtons) button.classList.toggle('hidden', !drawing)
    this.menuResolutionRow.classList.toggle('hidden', !drawing)
    if (drawing) this.menuResolutionInput.value = String(layer.resolutionScale)
    // Object keyframe actions only make sense when the menu was opened on a
    // node marker of an object layer.
    const onMarker = target.nodeId !== null && target.keyframeFrame !== undefined
    const objectMarker = onMarker && isObjectLayer(layer)
    for (const button of this.menuKeyframeButtons) button.classList.toggle('hidden', !objectMarker)
    this.menuPasteKeyframeButton.classList.toggle('hidden', !objectMarker)
    this.menuPasteKeyframeButton.disabled = this.clipboard === null
    // Camera and audio layers get their own actions instead.
    for (const button of this.menuCameraButtons) button.classList.toggle('hidden', !camera)
    for (const button of this.menuAudioButtons) button.classList.toggle('hidden', !audio)
    this.menuAudioVolumeRow.classList.toggle('hidden', !audio)
    if (audio) this.menuAudioVolumeInput.value = String(Math.round(layer.volume * 100))
    // "Move to frame" applies to object rows, drawing layers (their cell at
    // the playhead), camera keyframes and audio clips; plain object-layer,
    // camera and audio rows without a target have nothing to move.
    const movable =
      (target.nodeId !== null && isObjectLayer(layer)) ||
      drawing ||
      (camera && target.keyframeFrame !== undefined) ||
      audio
    this.menuMoveRow.classList.toggle('hidden', !movable)
    if (movable) {
      let position: number | null = null
      if (target.nodeId !== null && isObjectLayer(layer)) {
        const frames = layer.keyframes
          .filter((keyframe) => keyframe.nodes.some((node) => node.id === target.nodeId))
          .map((keyframe) => keyframe.frame)
        if (frames.length > 0) position = Math.min(...frames)
      } else if (isDrawingLayer(layer)) {
        const range = cellRangeAtFrame(layer, this.editor.currentFrame, this.editor.duration)
        if (range) position = range.cellFrame
      } else if (camera) {
        position = target.keyframeFrame ?? null
      } else if (audio) {
        position = layer.startFrame
      }
      this.menuMoveInput.value = position === null ? '' : String(position + 1)
      this.menuMoveInput.disabled = position === null
    }
    this.menuDeleteButton.disabled =
      target.nodeId === null && this.editor.document.layers.length <= 1
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
    if (target.nodeId) {
      if (!isObjectLayer(layer)) return
      const node = this.collectAllNodes(layer).find((candidate) => candidate.id === target.nodeId)
      if (!node) return
      currentName = nodeLabel(node)
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
        if (target.nodeId) this.editor.renameNode(target.layerId, target.nodeId, value)
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
      const nodeId = row.dataset.shapeId ?? null
      if (nodeId === target.nodeId) return row
    }
    return null
  }

  private deleteTarget(target: MenuTarget): void {
    if (target.nodeId) this.editor.deleteNode(target.layerId, target.nodeId)
    else this.editor.removeLayer(target.layerId)
  }

  private isPointerBelowRow(event: DragEvent, row: HTMLElement): boolean {
    const bounds = row.getBoundingClientRect()
    return event.clientY > bounds.top + bounds.height / 2
  }

  /**
   * Drop target for a track: while a cell or span bar of this layer is being
   * dragged over it, dropping moves the dragged item to the frame under the
   * pointer.
   */
  private wireDropTarget(track: HTMLDivElement, layerId: string): void {
    const active = (): boolean =>
      this.draggedCell?.layerId === layerId ||
      this.draggedNode?.layerId === layerId ||
      this.draggedAudio?.layerId === layerId
    track.addEventListener('dragover', (event) => {
      if (!active()) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    })
    track.addEventListener('drop', (event) => {
      const cell = this.draggedCell
      const node = this.draggedNode
      const audio = this.draggedAudio
      if (!active()) return
      event.preventDefault()
      this.clearDragState()
      const frame = this.frameFromDragEvent(event, track)
      if (frame === null) return
      this.editor.setCurrentLayer(layerId)
      if (cell && cell.layerId === layerId) {
        this.editor.moveCellToFrame(cell.frame, frame)
      } else if (node && node.layerId === layerId) {
        this.editor.moveNodeToFrame(node.nodeId, frame)
      } else if (audio && audio.layerId === layerId) {
        this.editor.setAudioClipStart(layerId, frame)
      }
    })
  }

  /** Frame under a drag event, derived from pointer geometry. */
  private frameFromDragEvent(event: DragEvent, track: HTMLElement): number | null {
    const frames = Number(track.dataset.frames)
    if (!Number.isFinite(frames) || frames <= 0) return null
    const rect = track.getBoundingClientRect()
    const offset = event.clientX - rect.left
    return Math.max(0, Math.min(frames - 1, Math.floor(offset / FRAME_WIDTH)))
  }

  private clearDragState(): void {
    this.draggedLayerId = null
    this.draggedCell = null
    this.draggedNode = null
    this.draggedAudio = null
    for (const row of this.rowsHost.querySelectorAll('.dragging, .drop-before, .drop-after')) {
      row.classList.remove('dragging', 'drop-before', 'drop-after')
    }
  }

  private toggleExpand(layerId: string): void {
    if (this.expandedLayers.has(layerId)) this.expandedLayers.delete(layerId)
    else this.expandedLayers.add(layerId)
    this.render()
  }

  /** Returns the frame range [start, end) where a node is continuously active. */
  private getNodeFrameSpan(
    layer: ObjectLayer,
    nodeId: string
  ): { start: number; end: number } | null {
    // Object-level span: the object is on stage exactly from its first
    // keyframe to its last keyframe (inclusive) and is invisible after.
    const containing = [...layer.keyframes]
      .sort((a, b) => a.frame - b.frame)
      .filter((keyframe) => keyframe.nodes.some((s) => s.id === nodeId))
    if (containing.length === 0) return null
    return {
      start: containing[0].frame,
      end: containing[containing.length - 1].frame + 1
    }
  }

  /** Collects all unique nodes across every keyframe of an object layer. */
  private collectAllNodes(layer: ObjectLayer): SceneNode[] {
    const seen = new Set<string>()
    const result: SceneNode[] = []
    for (const keyframe of layer.keyframes) {
      for (const node of keyframe.nodes) {
        if (!seen.has(node.id)) {
          seen.add(node.id)
          result.push(node)
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
