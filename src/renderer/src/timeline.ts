import type { Layer } from '@shared/model'

import type { Editor } from './editor'
import { el } from './dom'

const FRAME_WIDTH = 14
const HEAD_WIDTH = 150
const MIN_FRAMES = 40

/**
 * Timeline panel: frame ruler, layer rows with keyframe markers and tween
 * spans, and the playhead. Layer/keyframe operations and playback controls
 * live in the right properties panel.
 */
export class TimelineView {
  private readonly content: HTMLDivElement
  private readonly rowsHost: HTMLDivElement
  private readonly playhead: HTMLDivElement
  private readonly frameLabel: HTMLSpanElement

  constructor(
    private readonly editor: Editor,
    container: HTMLElement
  ) {
    const controls = el('div', 'tl-controls')
    this.frameLabel = el('span', 'tl-frame-label')
    controls.appendChild(this.frameLabel)

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
