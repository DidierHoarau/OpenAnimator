// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument } from '@shared/document'
import type { PrimitiveNode } from '@shared/model'
import { RenderScheduler } from '@shared/renderScheduler'

import { Editor } from './editor'
import { StageView } from './stage'

/**
 * Stage onion-skin and motion-path overlays. The ghosts evaluate at
 * hold-step offsets and can be tinted and outlined; the motion path is a
 * read-only overlay for the selected tweened object.
 */

/** Runs render tasks immediately: renders stay synchronous in tests. */
function syncScheduler(): RenderScheduler {
  return new RenderScheduler({
    request: (task) => {
      task()
      return 0
    },
    cancel: () => undefined
  })
}

function rect(id: string, x = 0): PrimitiveNode {
  return {
    id,
    type: 'primitive',
    primitive: 'rect',
    center: { x, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1
  }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('StageView — onion skin', () => {
  let editor: Editor
  let stage: StageView
  let svg: SVGSVGElement

  beforeEach(() => {
    document.body.textContent = ''
    editor = new Editor(createDocument('onion', 320, 180, 12))
    const host = document.createElement('main')
    document.body.appendChild(host)
    stage = new StageView(editor, host, { scheduler: syncScheduler() })
    svg = stage.element
  })

  /** Poses of 'a': x=0 at frame 0, 30 at 3, 60 at 6 (held between poses). */
  const authorMove = (): void => {
    editor.addNode(rect('a', 0))
    while (editor.duration <= 6) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    editor.seekToFrame(3)
    editor.updateSelectedNode((node) => {
      if (node.type === 'primitive') node.center.x = 30
    })
    editor.seekToFrame(6)
    editor.updateSelectedNode((node) => {
      if (node.type === 'primitive') node.center.x = 60
    })
  }

  const onion = (): Element | null => svg.querySelector('.stage__onion')
  const onionMarkup = (): string => onion()?.innerHTML ?? ''

  it('offsets the ghosts by the hold step and keeps the opacity ramp', () => {
    authorMove()
    editor.setOnionOptions({ onionBefore: 2, onionAfter: 0 })
    editor.toggleOnionSkin()
    editor.seekToFrame(6)
    stage.render()

    // Hold step 1: both ghosts show the pose held over frames 4 and 5 (x=30).
    let markup = onionMarkup()
    expect(count(markup, 'opacity="0.24"')).toBe(1)
    expect(count(markup, 'opacity="0.12"')).toBe(1)
    expect(count(markup, 'translate(30 0)')).toBe(2)
    expect(markup).not.toContain('translate(0 0)')
    expect(markup).not.toContain('translate(60 0)')

    // Hold step 3: the ghosts jump to frames 3 (x=30) and 0 (x=0).
    editor.setHoldStep(3)
    stage.render()
    markup = onionMarkup()
    expect(count(markup, 'translate(30 0)')).toBe(1)
    expect(count(markup, 'translate(0 0)')).toBe(1)

    // Ghosts never leave the frame range: at frame 0 with a step of 3 the
    // "before" ghosts have nowhere to go and the group stays empty.
    editor.seekToFrame(0)
    stage.render()
    expect(onion()).not.toBeNull()
    expect(onionMarkup()).toBe('')

    // Without onion skinning the group is not rendered at all.
    editor.toggleOnionSkin()
    stage.render()
    expect(onion()).toBeNull()
  })

  it('floods the ghosts with the before/after tint filters when tinting', () => {
    authorMove()
    editor.seekToFrame(3)
    editor.setOnionOptions({
      onionBefore: 1,
      onionAfter: 1,
      onionTint: true,
      onionTintBefore: '#112233',
      onionTintAfter: '#445566'
    })
    editor.toggleOnionSkin()
    stage.render()

    const markup = onionMarkup()
    expect(markup).toContain('<defs>')
    expect(markup).toContain('id="stage-onion-before"')
    expect(markup).toContain('id="stage-onion-after"')
    expect(markup).toContain('flood-color="#112233"')
    expect(markup).toContain('flood-color="#445566"')
    expect(markup).toContain('operator="in"')
    expect(markup).toContain('filter="url(#stage-onion-before)"')
    expect(markup).toContain('filter="url(#stage-onion-after)"')
  })

  it('renders ghosts as outlines without touching the live content', () => {
    authorMove()
    editor.setOnionOptions({ onionBefore: 1, onionAfter: 0, onionOutline: true })
    editor.toggleOnionSkin()
    editor.seekToFrame(6)
    stage.render()

    const markup = onionMarkup()
    expect(markup).toContain('fill="none"')
    expect(markup).toContain('stroke="#94a3b8"')
    expect(markup).toContain('stroke-width="1"')
    expect(markup).toContain('vector-effect="non-scaling-stroke"')
    // The ghosts are outlines; the live pose keeps its fill.
    expect(markup).not.toContain('fill="#ff0000"')
    expect(svg.innerHTML).toContain('fill="#ff0000"')

    // Toggling the option off restores filled ghosts.
    editor.setOnionOptions({ onionOutline: false })
    stage.render()
    expect(onionMarkup()).toContain('fill="#ff0000"')
  })
})

describe('StageView — motion path overlay', () => {
  let editor: Editor
  let stage: StageView
  let svg: SVGSVGElement

  beforeEach(() => {
    document.body.textContent = ''
    editor = new Editor(createDocument('motion', 320, 180, 12))
    const host = document.createElement('main')
    document.body.appendChild(host)
    stage = new StageView(editor, host, { scheduler: syncScheduler() })
    svg = stage.element
  })

  /** 'a' moves 0 → 60 between tweened keyframes at 0 and 6, and is selected. */
  const authorTween = (): void => {
    editor.addNode(rect('a', 0))
    while (editor.duration <= 6) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    editor.seekToFrame(6)
    editor.updateSelectedNode((node) => {
      if (node.type === 'primitive') node.center.x = 60
    })
    editor.seekToFrame(0)
    editor.toggleTweenHere()
    editor.selectNodes(['a'], 'replace')
    stage.render()
  }

  it('draws the tweened trajectory and its waypoints for the selection', () => {
    authorTween()
    const path = svg.querySelector('.stage__motion-path')
    expect(path).not.toBeNull()
    expect(path!.getAttribute('d')).toBe('M 0 0 L 60 0')
    const dots = [...svg.querySelectorAll('.stage__motion-key')]
    expect(dots.map((dot) => dot.getAttribute('cx'))).toEqual(['0', '60'])
    expect(dots.every((dot) => dot.getAttribute('r') !== null)).toBe(true)

    // Smoothing samples a curved polyline between the same waypoints.
    editor.setTweenPathHere('smooth')
    stage.render()
    const smoothed = svg.querySelector('.stage__motion-path')!.getAttribute('d')!
    expect(count(smoothed, 'L')).toBe(24)
    expect(smoothed.startsWith('M 0 0')).toBe(true)
  })

  it('omits the overlay without a selection or without a tween', () => {
    authorTween()
    editor.selectNodes([], 'replace')
    stage.render()
    expect(svg.querySelector('.stage__motion-path')).toBeNull()

    // Selected but no tween on the keyframes: nothing to traverse.
    editor.selectNodes(['a'], 'replace')
    editor.toggleTweenHere()
    stage.render()
    expect(svg.querySelector('.stage__motion-path')).toBeNull()
    expect(svg.querySelectorAll('.stage__motion-key')).toHaveLength(0)
  })
})
