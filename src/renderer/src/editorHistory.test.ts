import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument, evaluateLayerAtFrame, getLayer } from '@shared/document'
import type { Shape } from '@shared/model'

import { Editor } from './editor'

function rect(id: string, x = 0, y = 0): Shape {
  return {
    id,
    kind: 'rect',
    center: { x, y },
    width: 10,
    height: 10,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1
  }
}

function shapeAt(editor: Editor, id: string): Shape {
  const layer = getLayer(editor.document, editor.currentLayerId)!
  return layer.keyframes.flatMap((keyframe) => keyframe.shapes).find((s) => s.id === id)!
}

describe('Editor undo/redo history', () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor(createDocument('test', 960, 540, 24))
  })

  it('reports empty stacks with a status message', () => {
    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))
    expect(editor.canUndo).toBe(false)
    expect(editor.canRedo).toBe(false)
    editor.undo()
    editor.redo()
    expect(messages).toEqual(['Nothing to undo', 'Nothing to redo'])
  })

  it('undoes and redoes adding a shape and prunes the selection', () => {
    editor.addShape(rect('a', 10))
    expect(shapeAt(editor, 'a').center.x).toBe(10)
    expect(editor.selectedShapeIds).toEqual(['a'])

    editor.undo()
    expect(editor.document.layers[0].keyframes[0].shapes).toHaveLength(0)
    expect(editor.selectedShapeIds).toEqual([])

    editor.redo()
    expect(editor.document.layers[0].keyframes[0].shapes.map((s) => s.id)).toEqual(['a'])
    // Selection ids are revalidated, not resurrected: it stays empty.
    expect(editor.selectedShapeIds).toEqual([])
  })

  it('undoes a nudge of the selection', () => {
    editor.addShape(rect('a', 10))
    editor.nudgeSelected(5, 7)
    expect(shapeAt(editor, 'a').center).toEqual({ x: 15, y: 7 })
    editor.undo()
    expect(shapeAt(editor, 'a').center).toEqual({ x: 10, y: 0 })
  })

  it('coalesces an interaction into a single history entry', () => {
    editor.addShape(rect('a', 0))
    editor.beginInteraction()
    editor.updateSelectedShapes((shape) => {
      shape.center.x += 10
    })
    editor.updateSelectedShapes((shape) => {
      shape.center.x += 10
    })
    editor.endInteraction()
    expect(shapeAt(editor, 'a').center.x).toBe(20)

    // The intermediate +10 state is not a history entry: one undo reverts the
    // whole interaction.
    editor.undo()
    expect(shapeAt(editor, 'a').center.x).toBe(0)
    editor.undo()
    expect(editor.document.layers[0].keyframes[0].shapes).toHaveLength(0)
    expect(editor.canUndo).toBe(false)
  })

  it('pushes one entry for an auto-keyed properties-style edit', () => {
    editor.addShape(rect('a', 0))
    editor.seekToFrame(5)
    expect(editor.updateSelectedShape((shape) => (shape.fill = '#00ff00'))).toBe(true)
    const layerId = editor.currentLayerId
    expect(editor.hasShapeKeyframeAt(layerId, 'a', 5)).toBe(true)

    editor.undo()
    expect(editor.hasShapeKeyframeAt(layerId, 'a', 5)).toBe(false)
    expect(shapeAt(editor, 'a').fill).toBe('#ff0000')
  })

  it('caps the history at the limit, dropping the oldest entries', () => {
    editor.addShape(rect('a', 0))
    for (let i = 0; i < Editor.HISTORY_LIMIT + 20; i++) {
      editor.nudgeSelected(1, 0)
    }
    expect(shapeAt(editor, 'a').center.x).toBe(Editor.HISTORY_LIMIT + 20)

    let undos = 0
    while (editor.canUndo) {
      editor.undo()
      undos += 1
    }
    expect(undos).toBe(Editor.HISTORY_LIMIT)
    // Only the last 100 nudges are undoable: 20 early nudges became permanent.
    expect(shapeAt(editor, 'a').center.x).toBe(20)
  })

  it('clears the redo stack on a new mutation', () => {
    editor.addShape(rect('a', 0))
    editor.undo()
    expect(editor.canRedo).toBe(true)
    editor.addShape(rect('b', 50))
    expect(editor.canRedo).toBe(false)
    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))
    editor.redo()
    expect(messages).toEqual(['Nothing to redo'])
    expect(editor.document.layers[0].keyframes[0].shapes.map((s) => s.id)).toEqual(['b'])
  })

  it('undo restores a removed layer and keeps the state revalidated', () => {
    const firstId = editor.currentLayerId
    editor.addShape(rect('a', 0))
    editor.addLayerAtBottom()
    const secondId = editor.currentLayerId
    expect(editor.document.layers).toHaveLength(2)

    editor.removeLayer(firstId)
    expect(editor.document.layers).toHaveLength(1)
    expect(editor.currentLayerId).toBe(secondId)
    // The selection is pruned: 'a' lived on the removed layer.
    expect(editor.selectedShapeIds).toEqual([])

    editor.undo()
    expect(editor.document.layers).toHaveLength(2)
    expect(editor.currentLayerId).toBe(secondId)
    expect(editor.selectedShapeIds).toEqual([])
  })

  it('undo falls back to the first layer when the current layer no longer exists', () => {
    const firstId = editor.currentLayerId
    editor.addLayerAtBottom()
    const secondId = editor.currentLayerId
    editor.undo()
    expect(editor.document.layers).toHaveLength(1)
    expect(editor.currentLayerId).toBe(firstId)
    expect(secondId).not.toBe(firstId)
  })

  it('undo clamps the playhead when the timeline shrinks', () => {
    editor.addShape(rect('a', 0))
    editor.seekToFrame(5)
    expect(editor.duration).toBe(6)
    expect(editor.currentFrame).toBe(5)

    editor.undo()
    expect(editor.duration).toBe(1)
    expect(editor.currentFrame).toBe(0)
  })

  it('deleting the selection is one undo step and redo restores it', () => {
    editor.addShape(rect('a', 0))
    editor.addShape(rect('b', 50))
    editor.selectShapes(['a', 'b'], 'replace')
    editor.deleteSelected()
    // Both shapes lived in keyframe 0; emptied keyframes are dropped.
    expect(getLayer(editor.document, editor.currentLayerId)!.keyframes).toHaveLength(0)
    expect(editor.selectedShapeIds).toEqual([])

    editor.undo()
    const restored = getLayer(editor.document, editor.currentLayerId)!
    expect(evaluateLayerAtFrame(restored, 0).map((s) => s.id)).toEqual(['a', 'b'])
    editor.redo()
    expect(getLayer(editor.document, editor.currentLayerId)!.keyframes).toHaveLength(0)
  })

  it('setDocument resets the history and selection', () => {
    editor.addShape(rect('a', 0))
    editor.undo()
    editor.setDocument(createDocument('fresh', 800, 600, 12))
    expect(editor.canUndo).toBe(false)
    expect(editor.canRedo).toBe(false)
    expect(editor.selectedShapeIds).toEqual([])
    expect(editor.document.name).toBe('fresh')

    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))
    editor.undo()
    expect(messages).toEqual(['Nothing to undo'])
  })

  it('undo restores the pre-drag state as an independent copy', () => {
    editor.addShape(rect('a', 0))
    editor.nudgeSelected(3, 4)
    editor.undo()
    expect(shapeAt(editor, 'a').center).toEqual({ x: 0, y: 0 })
    // Mutating the restored document cannot corrupt the redo snapshot.
    shapeAt(editor, 'a').center.x = 55
    editor.redo()
    expect(shapeAt(editor, 'a').center.x).toBe(3)
    editor.undo()
    expect(shapeAt(editor, 'a').center.x).toBe(55)
  })
})
