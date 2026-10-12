// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument } from '@shared/document'
import type { PathNode, TextNode } from '@shared/model'
import { localToStagePoint, parseSubpaths, pathPlacement, stageAnchorPoints } from '@shared/pathEdit'
import { RenderScheduler } from '@shared/renderScheduler'

import { Editor } from './editor'
import { StageView } from './stage'

/**
 * Stage interaction tests for the v3 object tools: text placement, the line
 * tool and the pen tool (anchors, handles, close, commit, cancel), plus the
 * direct-selection anchor editor. The SVG screen transform is stubbed to an
 * identity mapping so client coordinates equal stage coordinates.
 */

/** Runs render tasks immediately: the tool-change assertions below depend on
 * the render-on-notification semantics. */
function syncScheduler(): RenderScheduler {
  return new RenderScheduler({
    request: (task) => {
      task()
      return 0
    },
    cancel: () => undefined
  })
}

function identityCTM(): { inverse(): { matrixTransform(point: DOMPoint): DOMPoint } } {
  return {
    inverse: () => ({
      matrixTransform: (point: DOMPoint) => point
    })
  }
}

function createStage(): { editor: Editor; stage: StageView; svg: SVGSVGElement } {
  const editor = new Editor(createDocument('tools', 320, 180, 12), {
    measureText: (line: string) => line.length * 10
  })
  const host = document.createElement('main')
  document.body.appendChild(host)
  const stage = new StageView(editor, host, { scheduler: syncScheduler() })
  const svg = stage.element
  svg.getScreenCTM = identityCTM as unknown as SVGSVGElement['getScreenCTM']
  svg.setPointerCapture = () => {}
  svg.releasePointerCapture = () => {}
  svg.hasPointerCapture = () => false
  return { editor, stage, svg }
}

function pointer(svg: SVGSVGElement, type: string, x: number, y: number): void {
  svg.dispatchEvent(
    new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true })
  )
}

/** The single object node of the first layer's active keyframe. */
function onlyNode(editor: Editor): PathNode | TextNode {
  const layer = editor.currentLayer
  if (!layer || layer.kind !== 'object') throw new Error('expected an object layer')
  const keyframe = layer.keyframes.find((entry) => entry.nodes.length > 0)
  if (!keyframe || keyframe.nodes.length !== 1) throw new Error('expected exactly one node')
  return keyframe.nodes[0] as PathNode | TextNode
}

describe('stage object tools', () => {
  let editor: Editor
  let stage: StageView
  let svg: SVGSVGElement

  beforeEach(() => {
    ;({ editor, stage, svg } = createStage())
  })

  it('places a measured text node and switches back to select', () => {
    editor.setTool('text')
    pointer(svg, 'pointerdown', 40, 50)

    const node = onlyNode(editor)
    expect(node.type).toBe('text')
    const text = node as TextNode
    expect(text.text).toBe('Text')
    expect(text.center).toEqual({ x: 40, y: 50 })
    // 'Text' is 4 characters × 10 units in the fake measurement.
    expect(text.width).toBe(40)
    expect(text.height).toBe(60)
    expect(editor.tool).toBe('select')
    expect(editor.selectedNodeIds).toEqual([node.id])
  })

  it('draws a default horizontal line for a click without a drag', () => {
    editor.setTool('line')
    pointer(svg, 'pointerdown', 100, 100)
    pointer(svg, 'pointerup', 100, 100)

    const node = onlyNode(editor)
    expect(node.type).toBe('path')
    const path = node as PathNode
    expect(path.d).toBe('M-60 0L60 0')
    expect(path.center).toEqual({ x: 100, y: 100 })
    expect(path.width).toBe(120)
    expect(path.height).toBe(2)
    expect(path.stroke).toBeDefined()
    expect(path.fill).toBeUndefined()
  })

  it('draws a line between the drag endpoints', () => {
    editor.setTool('line')
    pointer(svg, 'pointerdown', 10, 10)
    pointer(svg, 'pointermove', 50, 70)
    pointer(svg, 'pointerup', 50, 70)

    const path = onlyNode(editor) as PathNode
    expect(path.d).toBe('M-20 -30L20 30')
    expect(path.center).toEqual({ x: 30, y: 40 })
    expect(path.width).toBe(40)
    expect(path.height).toBe(60)
  })

  it('places pen anchors, records handles and commits on double-click', () => {
    editor.setTool('pen')
    pointer(svg, 'pointerdown', 0, 0)
    pointer(svg, 'pointerup', 0, 0)
    expect(svg.querySelector('.stage__pen')).not.toBeNull()

    pointer(svg, 'pointerdown', 60, 0)
    pointer(svg, 'pointermove', 80, 20)
    pointer(svg, 'pointerup', 80, 20)
    svg.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    const path = onlyNode(editor) as PathNode
    expect(path.type).toBe('path')
    // The dragged handle turns the second segment into a cubic curve.
    expect(path.d).toContain('C')
    expect(path.fill).toBeUndefined()
    expect(path.stroke).toBeDefined()
    // The committed path leaves the pen interaction and is selected.
    expect(svg.querySelector('.stage__pen')).toBeNull()
    expect(editor.selectedNodeIds).toEqual([path.id])
  })

  it('closes the pen path when the first anchor is clicked again', () => {
    editor.setTool('pen')
    pointer(svg, 'pointerdown', 0, 0)
    pointer(svg, 'pointerup', 0, 0)
    pointer(svg, 'pointerdown', 60, 0)
    pointer(svg, 'pointerup', 60, 0)
    pointer(svg, 'pointerdown', 60, 60)
    pointer(svg, 'pointerup', 60, 60)

    // Clicking back on the first anchor (within the close radius) closes.
    pointer(svg, 'pointerdown', 2, 2)
    pointer(svg, 'pointerup', 2, 2)

    const path = onlyNode(editor) as PathNode
    expect(path.d.endsWith('Z')).toBe(true)
    expect(path.fill).toBeDefined()
    expect(path.width).toBe(60)
    expect(path.height).toBe(60)
  })

  it('abandons the pen path when the tool changes and on cancel', () => {
    editor.setTool('pen')
    pointer(svg, 'pointerdown', 0, 0)
    pointer(svg, 'pointerup', 0, 0)
    expect(svg.querySelector('.stage__pen')).not.toBeNull()

    editor.setTool('select')
    expect(svg.querySelector('.stage__pen')).toBeNull()

    editor.setTool('pen')
    pointer(svg, 'pointerdown', 10, 10)
    pointer(svg, 'pointerup', 10, 10)
    stage.cancelPen()
    expect(svg.querySelector('.stage__pen')).toBeNull()
    for (const layer of editor.document.layers) {
      if (layer.kind === 'object') {
        expect(layer.keyframes.every((keyframe) => keyframe.nodes.length === 0)).toBe(true)
      }
    }
  })

  it('keeps pen anchors tool-local: switching layers does not commit them', () => {
    editor.setTool('pen')
    pointer(svg, 'pointerdown', 5, 5)
    pointer(svg, 'pointerup', 5, 5)
    editor.setTool('select')
    // No path was created — the anchors were simply dropped.
    const layer = editor.currentLayer
    if (layer?.kind !== 'object') throw new Error('expected an object layer')
    expect(layer.keyframes[0].nodes).toHaveLength(0)
  })
})

describe('stage vector brush', () => {
  let editor: Editor
  let stage: StageView
  let svg: SVGSVGElement

  beforeEach(() => {
    ;({ editor, stage, svg } = createStage())
  })

  it('commits the smoothed stroke as one editable PathNode with brush paint', () => {
    editor.setTool('vector')
    pointer(svg, 'pointerdown', 10, 20)
    pointer(svg, 'pointermove', 40, 10)
    pointer(svg, 'pointermove', 70, 30)
    pointer(svg, 'pointermove', 100, 60)
    // Live preview while drawing, removed on commit.
    expect(svg.querySelector('.stage__vector')).not.toBeNull()
    pointer(svg, 'pointerup', 100, 60)
    expect(svg.querySelector('.stage__vector')).toBeNull()

    const path = onlyNode(editor) as PathNode
    expect(path.type).toBe('path')
    // Smoothed centerline through the midpoints, re-centered so the bbox
    // center is the node center.
    expect(path.d).toBe('M-45 -15Q-15 -25 0 -15Q15 -5 45 25')
    expect(path.center).toEqual({ x: 55, y: 35 })
    expect(path.width).toBe(90)
    expect(path.height).toBe(50)
    expect(path.fill).toBe('none')
    expect(path.stroke).toBe('#e6edf3')
    expect(path.strokeWidth).toBe(6)
    expect(path.opacity).toBe(1)
    expect(path.rotation).toBe(0)
    expect(editor.selectedNodeIds).toEqual([path.id])
    // The vector tool stays active for the next stroke.
    expect(editor.tool).toBe('vector')

    // The whole stroke is one undo step.
    editor.undo()
    const layer = editor.currentLayer
    if (layer?.kind !== 'object') throw new Error('expected an object layer')
    expect(layer.keyframes[0].nodes).toHaveLength(0)
  })

  it('commits a click without drag as a tiny dot path', () => {
    editor.setTool('vector')
    pointer(svg, 'pointerdown', 50, 60)
    pointer(svg, 'pointerup', 50, 60)
    const path = onlyNode(editor) as PathNode
    expect(path.d).toBe('M0 0Q0 0 0 0')
    expect(path.center).toEqual({ x: 50, y: 60 })
    // Degenerate bounds fall back to the 2-unit minimum that keeps scale 1.
    expect(path.width).toBe(2)
    expect(path.height).toBe(2)
  })

  it('drops nearby duplicate samples from the committed centerline', () => {
    editor.setTool('vector')
    pointer(svg, 'pointerdown', 0, 0)
    pointer(svg, 'pointermove', 0.2, 0.2)
    pointer(svg, 'pointermove', 30, 0)
    pointer(svg, 'pointerup', 30, 0)
    const path = onlyNode(editor) as PathNode
    // The sub-half-pixel sample is filtered: two points, one segment.
    expect(path.d).toBe('M-15 0Q15 0 15 0')
  })

  it('cancels the in-progress stroke on Escape and on tool change', () => {
    editor.setTool('vector')
    pointer(svg, 'pointerdown', 0, 0)
    pointer(svg, 'pointermove', 40, 40)
    stage.cancelVectorStroke()
    pointer(svg, 'pointerup', 40, 40)
    expect(svg.querySelector('.stage__vector')).toBeNull()

    pointer(svg, 'pointerdown', 5, 5)
    pointer(svg, 'pointermove', 45, 45)
    editor.setTool('select')
    expect(svg.querySelector('.stage__vector')).toBeNull()

    const layer = editor.currentLayer
    if (layer?.kind !== 'object') throw new Error('expected an object layer')
    expect(layer.keyframes[0].nodes).toHaveLength(0)
  })

  it('refuses hidden, locked and drawing layers', () => {
    const vectorEditor = new Editor(createDocument('v', 320, 180, 12))
    vectorEditor.setTool('vector')
    const layer = vectorEditor.currentLayer
    if (layer?.kind !== 'object') throw new Error('expected an object layer')
    layer.locked = true
    const host = document.createElement('main')
    document.body.appendChild(host)
    const lockedStage = new StageView(vectorEditor, host, { scheduler: syncScheduler() })
    const lockedSvg = lockedStage.element
    lockedSvg.getScreenCTM = identityCTM as unknown as SVGSVGElement['getScreenCTM']
    lockedSvg.setPointerCapture = () => {}
    lockedSvg.releasePointerCapture = () => {}
    lockedSvg.hasPointerCapture = () => false
    pointer(lockedSvg, 'pointerdown', 10, 10)
    pointer(lockedSvg, 'pointerup', 10, 10)
    expect(layer.keyframes[0].nodes).toHaveLength(0)
  })
})

describe('stage direct selection', () => {
  let editor: Editor
  let stage: StageView
  let svg: SVGSVGElement

  beforeEach(() => {
    ;({ editor, stage, svg } = createStage())
  })

  /** Adds a path anchored at center (100,100) and arms the direct tool. */
  function addPath(d: string, width = 100, height = 100): void {
    editor.addNode({
      id: 'path-1',
      type: 'path',
      name: 'Path',
      d,
      width,
      height,
      center: { x: 100, y: 100 },
      rotation: 0,
      opacity: 1,
      stroke: '#e6edf3',
      strokeWidth: 2
    })
    editor.setTool('direct')
  }

  /** The live path node of the first keyframe. */
  function livePath(): PathNode {
    return onlyNode(editor) as PathNode
  }

  function dblclick(x: number, y: number): void {
    svg.dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true }))
  }

  it('drags an anchor in one undo step without renormalization drift', () => {
    addPath('M-50 -20L0 20L50 -20', 100, 40)
    // Anchors render at (50,80), (100,120), (150,80).
    pointer(svg, 'pointerdown', 100, 120)
    pointer(svg, 'pointermove', 105, 125)
    pointer(svg, 'pointermove', 110, 130)
    pointer(svg, 'pointerup', 110, 130)

    const path = livePath()
    // Every move resolves against the pointer-down snapshot, so the second
    // move lands exactly 10/10 away (no bbox-shift drift).
    expect(path.d).toBe('M-50 -25L10 25L50 -25')
    expect(path.center).toEqual({ x: 100, y: 105 })
    expect(path.width).toBe(100)
    expect(path.height).toBe(50)
    const placement = pathPlacement(path)
    expect(localToStagePoint(placement, { x: -50, y: -25 })).toEqual({ x: 50, y: 80 })
    expect(localToStagePoint(placement, { x: 10, y: 25 })).toEqual({ x: 110, y: 130 })

    // The whole drag is a single history entry.
    editor.undo()
    expect(livePath().d).toBe('M-50 -20L0 20L50 -20')
    expect(livePath().center).toEqual({ x: 100, y: 100 })
  })

  it('toggles an anchor corner/smooth on double-click', () => {
    addPath('M-50 0L50 0', 100, 2)
    // Smooth: symmetric ±(next−prev)/3 tangent along the chord.
    dblclick(50, 100)
    expect(livePath().d).toBe('M-50 0C-16.67 0 50 0 50 0')
    editor.undo()
    expect(livePath().d).toBe('M-50 0L50 0')
    editor.redo()
    expect(livePath().d).toBe('M-50 0C-16.67 0 50 0 50 0')
    // Corner again: the handles are dropped.
    dblclick(50, 100)
    expect(livePath().d).toBe('M-50 0L50 0')
  })

  it('inserts an anchor on a segment double-click', () => {
    addPath('M-50 -20L0 20L50 -20', 100, 40)
    // (75,100) is the midpoint of the first segment (t = 0.5 on a sample).
    dblclick(75, 100)

    const path = livePath()
    expect(path.d).toBe('M-50 -20L-25 0L0 20L50 -20')
    expect(path.center).toEqual({ x: 100, y: 100 })
    expect(path.width).toBe(100)
    expect(path.height).toBe(40)
    expect(parseSubpaths(path.d)![0].anchors).toHaveLength(4)

    editor.undo()
    expect(livePath().d).toBe('M-50 -20L0 20L50 -20')
  })

  it('drags a handle independently of its anchor', () => {
    addPath('M-50 0C-20 0 20 0 50 0', 100, 2)
    // Select anchor 0 first (its out tip renders at (80,100)).
    pointer(svg, 'pointerdown', 50, 100)
    pointer(svg, 'pointerup', 50, 100)
    pointer(svg, 'pointerdown', 80, 100)
    pointer(svg, 'pointermove', 80, 95)
    pointer(svg, 'pointermove', 80, 90)
    pointer(svg, 'pointerup', 80, 90)

    const path = livePath()
    const subpaths = parseSubpaths(path.d)!
    expect(subpaths[0].anchors[0].out).toEqual({ x: 30, y: -10 })
    // The other side of the curve is untouched.
    expect(subpaths[0].anchors[1].in).toEqual({ x: -30, y: 0 })
    const points = stageAnchorPoints(pathPlacement(path), subpaths)
    expect(points[0].point).toEqual({ x: 50, y: 100 })
    expect(points[0].out).toEqual({ x: 80, y: 90 })
    expect(points[1].in).toEqual({ x: 120, y: 100 })

    editor.undo()
    expect(livePath().d).toBe('M-50 0C-20 0 20 0 50 0')
  })

  it('collapses a handle pair by dragging its tip onto the anchor', () => {
    addPath('M-50 0C-20 0 20 0 50 0', 100, 2)
    pointer(svg, 'pointerdown', 50, 100)
    pointer(svg, 'pointerup', 50, 100)
    pointer(svg, 'pointerdown', 80, 100)
    pointer(svg, 'pointermove', 50, 100)
    pointer(svg, 'pointerup', 50, 100)

    const subpaths = parseSubpaths(livePath().d)!
    expect(subpaths[0].anchors[0].in).toBeUndefined()
    expect(subpaths[0].anchors[0].out).toBeUndefined()
    expect(subpaths[0].anchors[1].in).toEqual({ x: -30, y: 0 })
    expect(livePath().d).toBe('M-50 0C-50 0 20 0 50 0')
  })

  it('closes an open subpath by dropping one endpoint onto the other', () => {
    addPath('M-50 40L50 40L0 -40', 100, 80)
    // The apex (100,60) is dragged to (55,145), within the close radius of
    // the first anchor at (50,140): the same gesture moves and closes.
    pointer(svg, 'pointerdown', 100, 60)
    pointer(svg, 'pointermove', 55, 145)
    pointer(svg, 'pointerup', 55, 145)

    const path = livePath()
    expect(path.d).toBe('M-50 -2.5L50 -2.5L-45 2.5L-50 -2.5Z')
    expect(path.center).toEqual({ x: 100, y: 142.5 })
    expect(path.width).toBe(100)
    expect(path.height).toBe(5)
    const subpaths = parseSubpaths(path.d)!
    expect(subpaths).toHaveLength(1)
    expect(subpaths[0].closed).toBe(true)
    // The canonical duplicate closing anchor is merged back on parse.
    expect(subpaths[0].anchors).toHaveLength(3)

    // Undo opens it again and restores the pre-drag geometry in one step.
    editor.undo()
    expect(livePath().d).toBe('M-50 40L50 40L0 -40')
    expect(livePath().center).toEqual({ x: 100, y: 100 })
  })

  it('edits one subpath of a multi-subpath path without moving the others', () => {
    addPath('M-50 -50L-10 -50L-10 -10Z M10 10L50 10L50 50Z', 100, 100)
    // Drag the first anchor of the second square from (110,110) by 5/5.
    pointer(svg, 'pointerdown', 110, 110)
    pointer(svg, 'pointermove', 115, 115)
    pointer(svg, 'pointerup', 115, 115)

    const path = livePath()
    // Both subpaths serialize canonically (explicit closing segment + Z).
    expect(path.d).toBe('M-50 -50L-10 -50L-10 -10L-50 -50ZM15 15L50 10L50 50L15 15Z')
    expect(path.center).toEqual({ x: 100, y: 100 })
    expect(path.width).toBe(100)
    expect(path.height).toBe(100)

    editor.undo()
    expect(livePath().d).toBe('M-50 -50L-10 -50L-10 -10Z M10 10L50 10L50 50Z')
  })

  it('selects on locked layers but never mutates the geometry', () => {
    addPath('M-50 -20L0 20L50 -20', 100, 40)
    const layer = editor.currentLayer
    if (layer?.kind !== 'object') throw new Error('expected an object layer')
    layer.locked = true

    pointer(svg, 'pointerdown', 100, 120)
    pointer(svg, 'pointermove', 130, 120)
    pointer(svg, 'pointerup', 130, 120)

    // The anchor got selected (click-to-select still works) but the drag and
    // the delete are both refused.
    expect(livePath().d).toBe('M-50 -20L0 20L50 -20')
    expect(stage.deleteAnchorSelection()).toBe(false)
  })

  it('deletes the selected anchor with one undo step and refuses below two', () => {
    addPath('M-50 -20L0 20L50 -20', 100, 40)
    pointer(svg, 'pointerdown', 100, 120)
    pointer(svg, 'pointerup', 100, 120)

    expect(stage.deleteAnchorSelection()).toBe(true)
    const path = livePath()
    expect(path.d).toBe('M-50 0L50 0')
    expect(path.center).toEqual({ x: 100, y: 80 })
    expect(path.width).toBe(100)
    expect(path.height).toBe(40)
    editor.undo()
    expect(livePath().d).toBe('M-50 -20L0 20L50 -20')

    // Delete down to two anchors (this removes anchor 0)...
    pointer(svg, 'pointerdown', 50, 80)
    pointer(svg, 'pointerup', 50, 80)
    expect(stage.deleteAnchorSelection()).toBe(true)
    expect(livePath().d).toBe('M-25 20L25 -20')

    // ...and a two-anchor subpath refuses the next delete with a message.
    pointer(svg, 'pointerdown', 100, 120)
    pointer(svg, 'pointerup', 100, 120)
    expect(stage.deleteAnchorSelection()).toBe(true)
    expect(livePath().d).toBe('M-25 20L25 -20')
    expect(stage.clearAnchorSelection()).toBe(true)
    expect(stage.deleteAnchorSelection()).toBe(false)
  })

  it('marks anchors of the selected path and handles of the selected anchor', () => {
    addPath('M-50 -20L0 20L50 -20', 100, 40)
    // The selected path shows one marker per anchor; corners show no handles.
    expect(svg.querySelectorAll('.stage__anchor-marker')).toHaveLength(3)
    expect(svg.querySelectorAll('.stage__anchor-handle')).toHaveLength(0)

    pointer(svg, 'pointerdown', 100, 120)
    pointer(svg, 'pointerup', 100, 120)
    expect(svg.querySelectorAll('.stage__anchor-marker--selected')).toHaveLength(1)

    // Smoothing the middle anchor reveals its two handle dots.
    dblclick(100, 120)
    expect(svg.querySelectorAll('.stage__anchor-handle')).toHaveLength(2)
    expect(svg.querySelectorAll('.stage__anchor-handle-line')).toHaveLength(2)

    // Leaving the tool drops the selection and the overlay.
    editor.setTool('select')
    expect(svg.querySelectorAll('.stage__anchor-marker')).toHaveLength(0)
    expect(stage.clearAnchorSelection()).toBe(false)
  })
})
