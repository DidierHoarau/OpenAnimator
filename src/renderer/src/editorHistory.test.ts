import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument, evaluateLayerAtFrame, getLayer } from '@shared/document'
import type { PrimitiveNode } from '@shared/model'

import { Editor } from './editor'

function rect(id: string, x = 0, y = 0): PrimitiveNode {
  return {
    id,
    type: 'primitive',
    primitive: 'rect',
    center: { x, y },
    width: 10,
    height: 10,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1
  }
}

function nodeAt(editor: Editor, id: string): PrimitiveNode {
  const layer = getLayer(editor.document, editor.currentLayerId)!
  const node = layer.keyframes.flatMap((keyframe) => keyframe.nodes).find((n) => n.id === id)
  if (!node || node.type !== 'primitive') throw new Error(`missing primitive ${id}`)
  return node
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

  it('undoes and redoes adding a node and prunes the selection', () => {
    editor.addNode(rect('a', 10))
    expect(nodeAt(editor, 'a').center.x).toBe(10)
    expect(editor.selectedNodeIds).toEqual(['a'])

    editor.undo()
    expect(editor.document.layers[0].keyframes[0].nodes).toHaveLength(0)
    expect(editor.selectedNodeIds).toEqual([])

    editor.redo()
    expect(editor.document.layers[0].keyframes[0].nodes.map((n) => n.id)).toEqual(['a'])
    // Selection ids are revalidated, not resurrected: it stays empty.
    expect(editor.selectedNodeIds).toEqual([])
  })

  it('undoes a nudge of the selection', () => {
    editor.addNode(rect('a', 10))
    editor.nudgeSelected(5, 7)
    expect(nodeAt(editor, 'a').center).toEqual({ x: 15, y: 7 })
    editor.undo()
    expect(nodeAt(editor, 'a').center).toEqual({ x: 10, y: 0 })
  })

  it('coalesces an interaction into a single history entry', () => {
    editor.addNode(rect('a', 0))
    editor.beginInteraction()
    editor.updateSelectedNodes((node) => {
      node.center.x += 10
    })
    editor.updateSelectedNodes((node) => {
      node.center.x += 10
    })
    editor.endInteraction()
    expect(nodeAt(editor, 'a').center.x).toBe(20)

    // The intermediate +10 state is not a history entry: one undo reverts the
    // whole interaction.
    editor.undo()
    expect(nodeAt(editor, 'a').center.x).toBe(0)
    editor.undo()
    expect(editor.document.layers[0].keyframes[0].nodes).toHaveLength(0)
    expect(editor.canUndo).toBe(false)
  })

  it('pushes one entry for an auto-keyed properties-style edit', () => {
    editor.addNode(rect('a', 0))
    editor.seekToFrame(5)
    expect(
      editor.updateSelectedNode((node) => {
        if (node.type === 'primitive') node.fill = '#00ff00'
      })
    ).toBe(true)
    const layerId = editor.currentLayerId
    expect(editor.hasNodeKeyframeAt(layerId, 'a', 5)).toBe(true)

    editor.undo()
    expect(editor.hasNodeKeyframeAt(layerId, 'a', 5)).toBe(false)
    expect(nodeAt(editor, 'a').fill).toBe('#ff0000')
  })

  it('caps the history at the limit, dropping the oldest entries', () => {
    editor.addNode(rect('a', 0))
    for (let i = 0; i < Editor.HISTORY_LIMIT + 20; i++) {
      editor.nudgeSelected(1, 0)
    }
    expect(nodeAt(editor, 'a').center.x).toBe(Editor.HISTORY_LIMIT + 20)

    let undos = 0
    while (editor.canUndo) {
      editor.undo()
      undos += 1
    }
    expect(undos).toBe(Editor.HISTORY_LIMIT)
    // Only the last 100 nudges are undoable: 20 early nudges became permanent.
    expect(nodeAt(editor, 'a').center.x).toBe(20)
  })

  it('clears the redo stack on a new mutation', () => {
    editor.addNode(rect('a', 0))
    editor.undo()
    expect(editor.canRedo).toBe(true)
    editor.addNode(rect('b', 50))
    expect(editor.canRedo).toBe(false)
    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))
    editor.redo()
    expect(messages).toEqual(['Nothing to redo'])
    expect(editor.document.layers[0].keyframes[0].nodes.map((n) => n.id)).toEqual(['b'])
  })

  it('undo restores a removed layer and keeps the state revalidated', () => {
    const firstId = editor.currentLayerId
    editor.addNode(rect('a', 0))
    editor.addLayerAtBottom()
    const secondId = editor.currentLayerId
    expect(editor.document.layers).toHaveLength(2)

    editor.removeLayer(firstId)
    expect(editor.document.layers).toHaveLength(1)
    expect(editor.currentLayerId).toBe(secondId)
    // The selection is pruned: 'a' lived on the removed layer.
    expect(editor.selectedNodeIds).toEqual([])

    editor.undo()
    expect(editor.document.layers).toHaveLength(2)
    expect(editor.currentLayerId).toBe(secondId)
    expect(editor.selectedNodeIds).toEqual([])
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
    editor.addNode(rect('a', 0))
    editor.seekToFrame(5)
    expect(editor.duration).toBe(6)
    expect(editor.currentFrame).toBe(5)

    editor.undo()
    expect(editor.duration).toBe(1)
    expect(editor.currentFrame).toBe(0)
  })

  it('deleting the selection is one undo step and redo restores it', () => {
    editor.addNode(rect('a', 0))
    editor.addNode(rect('b', 50))
    editor.selectNodes(['a', 'b'], 'replace')
    editor.deleteSelected()
    // Both nodes lived in keyframe 0; emptied keyframes are dropped.
    expect(getLayer(editor.document, editor.currentLayerId)!.keyframes).toHaveLength(0)
    expect(editor.selectedNodeIds).toEqual([])

    editor.undo()
    const restored = getLayer(editor.document, editor.currentLayerId)!
    expect(evaluateLayerAtFrame(restored, 0).map((n) => n.id)).toEqual(['a', 'b'])
    editor.redo()
    expect(getLayer(editor.document, editor.currentLayerId)!.keyframes).toHaveLength(0)
  })

  it('grouping the selection is a single undo step', () => {
    editor.addNode(rect('a', 10, 0))
    editor.addNode(rect('b', 60, 0))
    editor.selectNodes(['a', 'b'], 'replace')
    expect(editor.groupSelection()).toBe(true)
    const layerId = editor.currentLayerId
    expect(getLayer(editor.document, layerId)!.keyframes[0].nodes).toHaveLength(1)
    expect(getLayer(editor.document, layerId)!.keyframes[0].nodes[0].type).toBe('group')

    // One undo dissolves the group back into the two primitives.
    editor.undo()
    const restored = getLayer(editor.document, layerId)!
    expect(restored.keyframes[0].nodes.map((node) => node.id)).toEqual(['a', 'b'])
    editor.redo()
    const regrouped = getLayer(editor.document, layerId)!
    expect(regrouped.keyframes[0].nodes).toHaveLength(1)
    expect(regrouped.keyframes[0].nodes[0].type).toBe('group')
  })

  it('ungrouping is a single undo step', () => {
    editor.addNode(rect('a', 10, 0))
    editor.addNode(rect('b', 60, 0))
    editor.selectNodes(['a', 'b'], 'replace')
    editor.groupSelection()
    expect(editor.ungroupSelection()).toBe(true)
    const layerId = editor.currentLayerId
    expect(getLayer(editor.document, layerId)!.keyframes[0].nodes.map((n) => n.id)).toEqual([
      'a',
      'b'
    ])

    editor.undo()
    const restored = getLayer(editor.document, layerId)!
    expect(restored.keyframes[0].nodes).toHaveLength(1)
    expect(restored.keyframes[0].nodes[0].type).toBe('group')
    editor.redo()
    expect(getLayer(editor.document, layerId)!.keyframes[0].nodes.map((n) => n.id)).toEqual([
      'a',
      'b'
    ])
  })

  it('grouping auto-keys the members inside the same undo step', () => {
    editor.addNode(rect('a', 10, 0))
    editor.addNode(rect('b', 60, 0))
    editor.seekToFrame(3)
    editor.selectNodes(['a', 'b'], 'replace')
    expect(editor.groupSelection()).toBe(true)
    const layerId = editor.currentLayerId
    // The members were auto-keyed at frame 3 and immediately folded into
    // the group.
    const layer = getLayer(editor.document, layerId)!
    const keyframe = layer.keyframes.find((candidate) => candidate.frame === 3)
    expect(keyframe?.nodes).toHaveLength(1)
    expect(keyframe?.nodes[0].type).toBe('group')

    // One undo removes the group and the auto-keyed keyframe together.
    editor.undo()
    const restored = getLayer(editor.document, layerId)!
    expect(restored.keyframes.some((candidate) => candidate.frame === 3)).toBe(false)
  })

  it('setDocument resets the history and selection', () => {
    editor.addNode(rect('a', 0))
    editor.undo()
    editor.setDocument(createDocument('fresh', 800, 600, 12))
    expect(editor.canUndo).toBe(false)
    expect(editor.canRedo).toBe(false)
    expect(editor.selectedNodeIds).toEqual([])
    expect(editor.document.name).toBe('fresh')

    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))
    editor.undo()
    expect(messages).toEqual(['Nothing to undo'])
  })

  it('undo restores the pre-drag state as an independent copy', () => {
    editor.addNode(rect('a', 0))
    editor.nudgeSelected(3, 4)
    editor.undo()
    expect(nodeAt(editor, 'a').center).toEqual({ x: 0, y: 0 })
    // Mutating the restored document cannot corrupt the redo snapshot.
    nodeAt(editor, 'a').center.x = 55
    editor.redo()
    expect(nodeAt(editor, 'a').center.x).toBe(3)
    editor.undo()
    expect(nodeAt(editor, 'a').center.x).toBe(55)
  })
})
