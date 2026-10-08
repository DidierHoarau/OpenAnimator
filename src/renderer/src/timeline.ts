import { findKeyframeIndexForFrame } from '@shared/document'
import type { EasingName } from '@shared/easing'
import type { Layer } from '@shared/model'
import type { Editor } from './editor'
import { el } from './dom'

const FRAME_WIDTH = 14
const HEAD_WIDTH = 150
const MIN_FRAMES = 40
const EASINGS: EasingName[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out']

/** Timeline panel: layer rows, keyframe markers, tween spans and playback controls. */
export class TimelineView {
  private readonly content: HTMLDivElement
  private readonly rowsHost: HTMLDivElement
  private readonly playhead: HTMLDivElement
  private readonly frameLabel: HTMLSpanElement
  private readonly playButton: HTMLButtonElement
  private readonly loopButton: HTMLButtonElement
  private readonly tweenButton: HTMLButtonElement
  private readonly easingSelect: HTMLSelectElement
  private readonly fpsInput: HTMLInputElement

  constructor(
    private readonly editor: Editor,
    container: HTMLElement
  ) {
    const controls = el('div', 'tl-controls')

    const keyframeGroup = el('div', 'tl-group')
    keyframeGroup.append(
      this.button('+ Keyframe', 'Insert keyframe at the current frame (F6)', () => editor.insertKeyframeHere()),
      this.button('+ Blank', 'Insert blank keyframe at the current frame (F7)', () => editor.insertBlankKeyframeHere()),
      this.button('+ Frame', 'Insert frame to extend the hold (F5)', () => editor.insertFrameHere()),
      this.button('− Keyframe', 'Remove the keyframe at the current frame', () => editor.removeKeyframeHere())
    )

    this.tweenButton = this.button('Tween', 'Toggle a classic tween from the current keyframe', () =>
      editor.toggleTweenHere()
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

    const tweenGroup = el('div', 'tl-group')
    tweenGroup.append(this.tweenButton, this.easingSelect)

    this.playButton = this.button('Play', 'Play or pause playback (Space)', () => editor.togglePlay())
    this.loopButton = this.button('Loop', 'Toggle looped playback', () => editor.toggleLoop())
    this.loopButton.classList.add('tl-toggle')
    const stopButton = this.button('Stop', 'Stop playback and return to frame 1 (Escape)', () =>
      editor.stopPlayback()
    )
    const playbackGroup = el('div', 'tl-group')
    playbackGroup.append(this.playButton, stopButton, this.loopButton)

    const fpsGroup = el('div', 'tl-group')
    const fpsLabel = el('span', 'tl-label', 'fps')
    this.fpsInput = el('input', 'tl-number') as HTMLInputElement
    this.fpsInput.type = 'number'
    this.fpsInput.min = '1'
    this.fpsInput.max = '120'
    this.fpsInput.title = 'Frames per second'
    this.fpsInput.addEventListener('change', () => editor.setFps(Number(this.fpsInput.value)))
    fpsGroup.append(fpsLabel, this.fpsInput)

    const layerGroup = el('div', 'tl-group')
    layerGroup.append(
      this.button('+ Layer', 'Add a layer on top', () => editor.addLayerOnTop()),
      this.button('− Layer', 'Remove the current layer', () => editor.removeCurrentLayer())
    )

    this.frameLabel = el('span', 'tl-frame-label')
    controls.append(keyframeGroup, tweenGroup, playbackGroup, fpsGroup, layerGroup, this.frameLabel)

    const ruler = el('div', 'tl-ruler')
    this.rowsHost = el('div', 'tl-rows')
    this.playhead = el('div', 'tl-playhead')
    this.content = el('div', 'tl-content')
    this.content.append(ruler, this.rowsHost, this.playhead)

    const scroll = el('div', 'tl-scroll')
    scroll.appendChild(this.content)
    scroll.addEventListener('pointerdown', (event) => this.onTrackPointerDown(event))

    container.append(controls, scroll)

    editor.onDocChange(() => this.render())
    editor.onFrameChange(() => this.updatePlayhead())
    editor.onUiChange(() => this.render())
    this.render()
  }

  private button(title: string, tooltip: string, onClick: () => void): HTMLButtonElement {
    const button = el('button', undefined, title)
    button.title = tooltip
    button.addEventListener('click', onClick)
    return button
  }

  private onTrackPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement
    const frameAttr = target.dataset?.frame
    if (frameAttr !== undefined) {
      this.editor.setFrame(Number(frameAttr))
      return
    }
    const row = target.closest<HTMLElement>('.tl-row')
    if (row?.dataset.layerId) {
      this.editor.setCurrentLayer(row.dataset.layerId)
    }
  }

  private activeKeyframeEasing(): EasingName | null {
    const layer = this.editor.currentLayer
    if (!layer) return null
    const index = findKeyframeIndexForFrame(layer, this.editor.currentFrame)
    if (index === -1) return null
    return layer.keyframes[index].tween?.easing ?? null
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

    this.rowsHost.textContent = ''
    for (const layer of doc.layers) {
      this.rowsHost.appendChild(this.buildRow(layer, frames))
    }

    // Control states.
    this.playButton.textContent = editor.playing ? 'Pause' : 'Play'
    this.loopButton.classList.toggle('active', editor.loop)
    this.fpsInput.value = String(doc.fps)
    const easing = this.activeKeyframeEasing()
    this.tweenButton.classList.toggle('active', easing !== null)
    if (easing !== null) this.easingSelect.value = easing
    this.updatePlayhead()
  }

  private buildRow(layer: Layer, frames: number): HTMLDivElement {
    const editor = this.editor
    const row = el('div', 'tl-row')
    row.dataset.layerId = layer.id
    if (layer.id === editor.currentLayerId) row.classList.add('current')

    const head = el('div', 'tl-head')
    const visibilityButton = el('button', 'tl-icon', layer.visible ? '◉' : '○')
    visibilityButton.title = layer.visible ? 'Hide layer' : 'Show layer'
    visibilityButton.addEventListener('click', (event) => {
      event.stopPropagation()
      editor.toggleLayerVisibility(layer.id)
    })
    const lockButton = el('button', 'tl-icon', layer.locked ? 'L' : '·')
    lockButton.title = layer.locked ? 'Unlock layer' : 'Lock layer'
    lockButton.addEventListener('click', (event) => {
      event.stopPropagation()
      editor.toggleLayerLock(layer.id)
    })
    lockButton.classList.toggle('active', layer.locked)
    const name = el('span', 'name', layer.name)
    name.title = layer.name
    head.append(visibilityButton, name, lockButton)
    head.addEventListener('click', () => editor.setCurrentLayer(layer.id))
    row.appendChild(head)

    const track = el('div', 'tl-track')
    track.style.width = `${frames * FRAME_WIDTH}px`
    const sorted = [...layer.keyframes].sort((a, b) => a.frame - b.frame)
    for (let i = 0; i < sorted.length; i++) {
      const keyframe = sorted[i]
      const next = sorted[i + 1]
      if (keyframe.tween && next) {
        const span = el('div', 'tl-tween')
        span.style.left = `${keyframe.frame * FRAME_WIDTH}px`
        span.style.width = `${(next.frame - keyframe.frame) * FRAME_WIDTH}px`
        track.appendChild(span)
      }
      const marker = el('div', keyframe.shapes.length > 0 ? 'tl-key' : 'tl-key blank')
      marker.style.left = `${keyframe.frame * FRAME_WIDTH + FRAME_WIDTH / 2}px`
      marker.dataset.frame = String(keyframe.frame)
      marker.title = `Keyframe ${keyframe.frame + 1}${keyframe.tween ? ' · tween' : ''}`
      track.appendChild(marker)
    }
    for (let frame = 0; frame < frames; frame++) {
      const cell = el('div', 'tl-cell')
      cell.dataset.frame = String(frame)
      cell.style.left = `${frame * FRAME_WIDTH}px`
      track.appendChild(cell)
    }
    row.appendChild(track)
    return row
  }

  private updatePlayhead(): void {
    this.playhead.style.left = `${HEAD_WIDTH + this.editor.currentFrame * FRAME_WIDTH + FRAME_WIDTH / 2}px`
    this.frameLabel.textContent = `frame ${this.editor.currentFrame + 1} / ${this.editor.duration}`
  }
}
