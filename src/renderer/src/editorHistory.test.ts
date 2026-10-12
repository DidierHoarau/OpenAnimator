import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument, evaluateLayerAtFrame, extractKeyframeChunk, getLayer } from '@shared/document'
import type { DrawingLayer, ObjectLayer, PrimitiveNode } from '@shared/model'

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

function nodeFrames(editor: Editor, id: string): number[] {
  const layer = getLayer(editor.document, editor.currentLayerId)!
  return layer.keyframes
    .filter((keyframe) => keyframe.nodes.some((node) => node.id === id))
    .map((keyframe) => keyframe.frame)
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
    // Extend the authored timeline explicitly so frame 5 is reachable.
    while (editor.duration <= 5) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
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
    // + Frame is its own undo step that grows the authored timeline.
    editor.insertFrameHere()
    editor.seekToFrame(1)
    expect(editor.duration).toBe(2)
    expect(editor.currentFrame).toBe(1)

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
    while (editor.duration <= 3) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
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

  const drawingEditor = (): Editor =>
    new Editor(createDocument('test', 960, 540, 24), {
      createTransparentPng: async () => new Uint8Array([0]),
      storeResource: async () => 'res-blank'
    })

  it('moving a cell is one undo step and redo restores the new position', () => {
    const editor = drawingEditor()
    editor.addLayerAtBottom('drawing')
    const layerId = editor.currentLayerId
    editor.commitStroke('res-a', 0)
    while (editor.duration <= 5) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    const frames = (): number[] =>
      (getLayer(editor.document, layerId) as DrawingLayer).cells.map((cell) => cell.frame)

    // A no-op target and a frame without a cell move nothing.
    expect(editor.moveCellToFrame(0, 0)).toBe(false)
    expect(editor.moveCellToFrame(2, 4)).toBe(false)

    expect(editor.setCellStartFrame(0, 3)).toBe(true)
    expect(frames()).toEqual([3])
    editor.undo()
    expect(frames()).toEqual([0])
    editor.redo()
    expect(frames()).toEqual([3])

    // Moving from the redone position is still a single entry per move.
    editor.undo()
    expect(editor.moveCellToFrame(0, 4)).toBe(true)
    expect(frames()).toEqual([4])
    editor.undo()
    expect(frames()).toEqual([0])
    expect(editor.canRedo).toBe(true)
  })

  it('retiming the last cell inserts a transparent cell in the same undo step', async () => {
    const editor = drawingEditor()
    editor.addLayerAtBottom('drawing')
    const layerId = editor.currentLayerId
    editor.commitStroke('res-a', 0)
    while (editor.duration <= 5) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    editor.seekToFrame(1)
    const layer = (): DrawingLayer => getLayer(editor.document, layerId) as DrawingLayer

    // The last cell holds to the timeline end: that end is a no-op.
    expect(await editor.setCellEndFrame(0, 5)).toBe(false)
    expect(await editor.setCellEndFrame(0, 2)).toBe(true)
    expect(layer().cells.map((cell) => cell.frame)).toEqual([0, 3])
    expect(layer().cells[1].resourceId).toBe('res-blank')

    editor.undo()
    expect(layer().cells.map((cell) => cell.frame)).toEqual([0])
    editor.redo()
    expect(layer().cells.map((cell) => cell.frame)).toEqual([0, 3])

    // With a following cell the retime shifts that cell instead.
    expect(await editor.setCellEndFrame(0, 1)).toBe(true)
    expect(layer().cells.map((cell) => cell.frame)).toEqual([0, 2])
    editor.undo()
    expect(layer().cells.map((cell) => cell.frame)).toEqual([0, 3])
  })

  it('moveNodeToFrame shifts the whole span and refuses collapsed moves', () => {
    editor.addNode(rect('a', 0))
    while (editor.duration <= 5) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    editor.seekToFrame(2)
    expect(editor.ensureNodeKeyframe('a')).toBe(true)

    expect(editor.moveNodeToFrame('nope', 1)).toBe(false)
    expect(editor.moveNodeToFrame('a', 3)).toBe(true)
    expect(nodeFrames(editor, 'a')).toEqual([3, 5])

    // The span ends on the last frame: pulling it right is impossible.
    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))
    expect(editor.moveNodeToFrame('a', 5)).toBe(false)
    expect(messages).toEqual(['The move would leave the timeline'])
    expect(nodeFrames(editor, 'a')).toEqual([3, 5])

    editor.undo()
    expect(nodeFrames(editor, 'a')).toEqual([0, 2])
    editor.redo()
    expect(nodeFrames(editor, 'a')).toEqual([3, 5])
  })

  it('moving a multi-selection is one undo step', () => {
    editor.addNode(rect('a', 0))
    editor.addNode(rect('b', 60))
    while (editor.duration <= 5) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
    editor.seekToFrame(2)
    expect(editor.ensureNodeKeyframe('b')).toBe(true)

    editor.selectNodes(['a', 'b'], 'replace')
    expect(editor.moveSelectedNodesToFrame(3)).toBe(true)
    expect(nodeFrames(editor, 'a')).toEqual([3])
    expect(nodeFrames(editor, 'b')).toEqual([3, 5])

    // One undo restores both spans.
    editor.undo()
    expect(nodeFrames(editor, 'a')).toEqual([0])
    expect(nodeFrames(editor, 'b')).toEqual([0, 2])
    editor.redo()
    expect(nodeFrames(editor, 'a')).toEqual([3])
    expect(nodeFrames(editor, 'b')).toEqual([3, 5])
  })
})

describe('Editor undo/redo — keyframe retiming, clipboard and hold step', () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor(createDocument('test', 960, 540, 24))
  })

  const extend = (toFrame: number): void => {
    while (editor.duration <= toFrame) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
  }

  const layerAt = (): ObjectLayer => getLayer(editor.document, editor.currentLayerId) as ObjectLayer
  const tweenAt = (frame: number) =>
    layerAt().keyframes.find((keyframe) => keyframe.frame === frame)?.tween

  it('moveNodeKeyframeEntry moves one entry as a single undo step', () => {
    editor.addNode(rect('a', 0))
    extend(6)
    editor.seekToFrame(4)
    expect(editor.ensureNodeKeyframe('a')).toBe(true)
    expect(nodeFrames(editor, 'a')).toEqual([0, 4])

    expect(editor.moveNodeKeyframeEntry('a', 4, 6)).toBe(true)
    expect(nodeFrames(editor, 'a')).toEqual([0, 6])
    editor.undo()
    expect(nodeFrames(editor, 'a')).toEqual([0, 4])
    editor.redo()
    expect(nodeFrames(editor, 'a')).toEqual([0, 6])
  })

  it('moveNodeKeyframeEntry leaves no history when nothing moves', () => {
    editor.addNode(rect('a', 0))
    extend(5)
    editor.seekToFrame(4)
    expect(editor.ensureNodeKeyframe('a')).toBe(true)
    expect(nodeFrames(editor, 'a')).toEqual([0, 4])

    // Unknown node, no-op delta, missing source and out-of-range target all
    // refuse without touching the history.
    expect(editor.moveNodeKeyframeEntry('ghost', 0, 1)).toBe(false)
    expect(editor.moveNodeKeyframeEntry('a', 0, 0)).toBe(false)
    expect(editor.moveNodeKeyframeEntry('a', 3, 5)).toBe(false)
    expect(editor.moveNodeKeyframeEntry('a', 4, 6)).toBe(false)

    // One undo kills the keyframe insert — no empty entries were stacked.
    editor.undo()
    expect(nodeFrames(editor, 'a')).toEqual([0])
  })

  it('an out-of-range marker move refuses with a message', () => {
    editor.addNode(rect('a', 0))
    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))
    // The timeline is a single frame: frame 1 does not exist yet.
    expect(editor.moveNodeKeyframeEntry('a', 0, 1)).toBe(false)
    expect(messages).toEqual(['Move keyframe: the target frame is outside the timeline'])
    // The refusal stacked no entry: one undo reverts the node insert itself.
    editor.undo()
    expect(editor.document.layers[0].keyframes[0].nodes).toHaveLength(0)
  })

  it('moveNodeKeyframeEntries moves a batch in one undo step', () => {
    editor.addNode(rect('a', 0))
    editor.addNode(rect('b', 0))
    extend(5)
    editor.seekToFrame(2)
    expect(editor.ensureNodeKeyframe('b')).toBe(true)
    editor.seekToFrame(4)
    expect(editor.ensureNodeKeyframe('a')).toBe(true)

    expect(
      editor.moveNodeKeyframeEntries(
        [
          { nodeId: 'a', fromFrame: 0, toFrame: 1 },
          { nodeId: 'b', fromFrame: 2, toFrame: 3 }
        ],
        editor.currentLayerId
      )
    ).toBe(true)
    expect(nodeFrames(editor, 'a')).toEqual([1, 4])
    expect(nodeFrames(editor, 'b')).toEqual([0, 3])

    editor.undo()
    expect(nodeFrames(editor, 'a')).toEqual([0, 4])
    expect(nodeFrames(editor, 'b')).toEqual([0, 2])
    editor.redo()
    expect(nodeFrames(editor, 'a')).toEqual([1, 4])
    expect(nodeFrames(editor, 'b')).toEqual([0, 3])
  })

  it('copyKeyframeChunk pastes with the carried tween in one undo step', () => {
    editor.addNode(rect('a', 0))
    extend(11)
    editor.seekToFrame(0)
    editor.toggleTweenHere()
    editor.seekToFrame(3)
    expect(editor.ensureNodeKeyframe('a')).toBe(true)
    expect(tweenAt(0)).toEqual({ easing: 'ease-in-out' })

    const entries = extractKeyframeChunk(layerAt(), 0, 3, ['a'])
    expect(editor.copyKeyframeChunk(editor.currentLayerId, entries, 6)).toBe(true)
    expect(nodeFrames(editor, 'a')).toEqual([0, 3, 6, 9])
    // The tween rode along to the first pasted keyframe only.
    expect(tweenAt(6)).toEqual({ easing: 'ease-in-out' })
    expect(tweenAt(9)).toBeUndefined()

    editor.undo()
    expect(nodeFrames(editor, 'a')).toEqual([0, 3])
    editor.redo()
    expect(nodeFrames(editor, 'a')).toEqual([0, 3, 6, 9])
  })

  it('copyKeyframeChunk skips out-of-range entries and refuses full misses', () => {
    editor.addNode(rect('a', 0))
    extend(11)
    editor.seekToFrame(3)
    expect(editor.ensureNodeKeyframe('a')).toBe(true)
    const entries = extractKeyframeChunk(layerAt(), 0, 3, ['a'])

    // Offset 0 lands at 10, offset 3 (frame 13) is past the end and skipped.
    expect(editor.copyKeyframeChunk(editor.currentLayerId, entries, 10)).toBe(true)
    expect(nodeFrames(editor, 'a')).toEqual([0, 3, 10])
    editor.undo()
    expect(nodeFrames(editor, 'a')).toEqual([0, 3])

    expect(editor.copyKeyframeChunk(editor.currentLayerId, entries, 12)).toBe(false)
    expect(nodeFrames(editor, 'a')).toEqual([0, 3])
  })

  it('setTweenPathHere toggles the motion-path mode as one undo step', () => {
    editor.addNode(rect('a', 0))
    extend(4)
    editor.seekToFrame(0)
    editor.toggleTweenHere()

    // 'linear' is the default: re-setting it is a no-op without history.
    editor.setTweenPathHere('linear')
    editor.undo()
    expect(tweenAt(0)).toBeUndefined()

    editor.redo()
    editor.setTweenPathHere('smooth')
    expect(tweenAt(0)).toEqual({ easing: 'ease-in-out', path: 'smooth' })
    editor.undo()
    expect(tweenAt(0)).toEqual({ easing: 'ease-in-out' })
    editor.redo()

    // Switching back to linear removes the field in one undoable step.
    editor.setTweenPathHere('linear')
    expect(tweenAt(0)).toEqual({ easing: 'ease-in-out' })
    editor.undo()
    expect(tweenAt(0)).toEqual({ easing: 'ease-in-out', path: 'smooth' })
  })

  it('setTweenEasingHere stores beziers, keeps the path and ignores repeats', () => {
    editor.addNode(rect('a', 0))
    extend(4)
    editor.seekToFrame(0)
    editor.toggleTweenHere()
    editor.setTweenPathHere('smooth')

    editor.setTweenEasingHere({ x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 })
    expect(tweenAt(0)).toEqual({ easing: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 }, path: 'smooth' })

    // The identical pick is a no-op: one undo goes back to the named easing.
    editor.setTweenEasingHere({ x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 })
    editor.undo()
    expect(tweenAt(0)).toEqual({ easing: 'ease-in-out', path: 'smooth' })
    editor.redo()
    expect(tweenAt(0)?.easing).toEqual({ x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 })
  })

  it('setHoldStep is one undo step, removes the field at 1 and clamps', () => {
    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))

    // Invalid values are ignored entirely (no history entry either).
    editor.setHoldStep(0)
    editor.setHoldStep(17)
    editor.setHoldStep(2.5)
    expect(editor.holdStep).toBe(1)

    editor.setHoldStep(2)
    expect(editor.document.holdStep).toBe(2)
    editor.undo()
    expect(editor.document.holdStep).toBeUndefined()
    expect(editor.holdStep).toBe(1)

    // 1 turns stepping off; repeating it stacks nothing.
    messages.length = 0
    editor.setHoldStep(1)
    editor.undo()
    expect(messages).toEqual(['Nothing to undo'])
  })

  it('setOnionOptions clamps counts and never touches the document history', () => {
    editor.setOnionOptions({ onionBefore: 99, onionAfter: -3, onionTint: true })
    expect(editor.onionBefore).toBe(5)
    expect(editor.onionAfter).toBe(0)
    expect(editor.onionTint).toBe(true)
    expect(editor.document.holdStep).toBeUndefined()

    const messages: string[] = []
    editor.onMessage((message) => messages.push(message))
    editor.undo()
    expect(messages).toEqual(['Nothing to undo'])
  })

  it('refuses retiming, clipping and easing edits on a locked layer', () => {
    editor.addNode(rect('a', 0))
    extend(4)
    editor.seekToFrame(0)
    editor.toggleTweenHere()
    layerAt().locked = true

    expect(editor.moveNodeKeyframeEntry('a', 0, 2)).toBe(false)
    expect(
      editor.copyKeyframeChunk(
        editor.currentLayerId,
        [{ nodeId: 'a', offset: 0, node: rect('a') }],
        2
      )
    ).toBe(false)
    editor.setTweenPathHere('smooth')
    editor.setTweenEasingHere({ x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 })
    expect(tweenAt(0)).toEqual({ easing: 'ease-in-out' })
    expect(nodeFrames(editor, 'a')).toEqual([0])
  })
})
