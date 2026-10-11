// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument } from '@shared/document'
import type { PathNode, TextNode } from '@shared/model'

import { Editor } from './editor'
import { StageView } from './stage'

/**
 * Stage interaction tests for the v3 object tools: text placement, the line
 * tool and the pen tool (anchors, handles, close, commit, cancel). The SVG
 * screen transform is stubbed to an identity mapping so client coordinates
 * equal stage coordinates.
 */

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
  const stage = new StageView(editor, host)
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
