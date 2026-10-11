import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument, evaluateLayerAtFrame, getLayer } from '@shared/document'
import type { Shape } from '@shared/model'

import { Editor } from './editor'

function rect(id: string): Shape {
  return {
    id,
    kind: 'rect',
    center: { x: 0, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1
  }
}

describe('Editor timeline operations', () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor(createDocument('test', 960, 540, 24))
  })

  it('removeShapeKeyframe deletes the object keyframe and drops it when empty', () => {
    editor.addShape(rect('a'))
    const layerId = editor.currentLayerId
    editor.insertFrameHere()
    editor.setFrame(1)
    editor.ensureShapeKeyframe('a')
    expect(editor.hasShapeKeyframeAt(layerId, 'a', 1)).toBe(true)

    expect(editor.removeShapeKeyframe('a')).toBe(true)
    expect(editor.hasShapeKeyframeAt(layerId, 'a', 1)).toBe(false)
    const layer = getLayer(editor.document, layerId)!
    expect(layer.keyframes.some((keyframe) => keyframe.frame === 1)).toBe(false)
    // The earlier keyframe is untouched: the object still holds through frame 0.
    expect(editor.hasShapeKeyframeAt(layerId, 'a', 0)).toBe(true)
    // Without its own keyframe at the current frame, removal is a no-op.
    expect(editor.removeShapeKeyframe('a')).toBe(false)
    expect(editor.hasShapeKeyframeAt(layerId, 'a', 0)).toBe(true)
  })

  it('deleteShape removes the object from every keyframe and clears the selection', () => {
    editor.addShape(rect('a'))
    const layerId = editor.currentLayerId
    editor.insertFrameHere()
    editor.setFrame(1)
    editor.ensureShapeKeyframe('a')
    editor.selectShapes(['a'], 'replace')

    editor.deleteShape(layerId, 'a')
    const layer = getLayer(editor.document, layerId)!
    // Every keyframe was emptied by the removal and therefore dropped.
    expect(layer.keyframes).toHaveLength(0)
    expect(editor.selectedShapeIds).toEqual([])
  })

  it('renameShape stores the name in every keyframe', () => {
    editor.addShape(rect('a'))
    const layerId = editor.currentLayerId
    editor.renameShape(layerId, 'a', 'Hero')
    const layer = getLayer(editor.document, layerId)!
    expect(layer.keyframes[0].shapes[0].name).toBe('Hero')
  })

  it('removeFrameHere shrinks the timeline and clamps the playhead', () => {
    editor.insertFrameHere()
    editor.setFrame(1)
    expect(editor.duration).toBe(2)

    expect(editor.removeFrameHere()).toBe(true)
    expect(editor.duration).toBe(1)
    expect(editor.currentFrame).toBe(0)
    expect(editor.removeFrameHere()).toBe(true)
    expect(editor.duration).toBe(1)
  })

  it('layer operations: add at the bottom, move, rename, remove', () => {
    const firstId = editor.currentLayerId
    editor.addLayerAtBottom()
    expect(editor.document.layers).toHaveLength(2)
    const secondId = editor.currentLayerId
    expect(editor.document.layers[1].id).toBe(secondId)

    editor.moveLayer(secondId, 0)
    expect(editor.document.layers[0].id).toBe(secondId)

    editor.renameLayer(secondId, 'Foreground')
    expect(getLayer(editor.document, secondId)?.name).toBe('Foreground')

    editor.removeLayer(secondId)
    expect(editor.document.layers).toHaveLength(1)
    expect(editor.currentLayerId).toBe(firstId)

    // The last remaining layer is never removed.
    editor.removeLayer(firstId)
    expect(editor.document.layers).toHaveLength(1)
  })

  it('ensureShapeKeyframe keys only the targeted object', () => {
    editor.addShape(rect('a'))
    editor.addShape(rect('b'))
    const layerId = editor.currentLayerId
    editor.insertFrameHere()
    editor.setFrame(1)

    expect(editor.ensureShapeKeyframe('a')).toBe(true)
    expect(editor.hasShapeKeyframeAt(layerId, 'a', 1)).toBe(true)
    expect(editor.hasShapeKeyframeAt(layerId, 'b', 1)).toBe(false)
    const layer = getLayer(editor.document, layerId)!
    const keyed = layer.keyframes.find((keyframe) => keyframe.frame === 1)!
    expect(keyed.shapes.map((shape) => shape.id)).toEqual(['a'])
    // b has no keyframe at frame 1, so its span ends at frame 0: only `a`
    // is on stage here.
    const content = evaluateLayerAtFrame(layer, 1)
    expect(content.map((shape) => shape.id)).toEqual(['a'])
  })

  it('seekToFrame extends the timeline so keyframes can land after the last one', () => {
    editor.addShape(rect('a'))
    const layerId = editor.currentLayerId
    expect(editor.duration).toBe(1)

    editor.seekToFrame(5)
    expect(editor.currentFrame).toBe(5)
    expect(editor.duration).toBe(6)

    expect(editor.ensureShapeKeyframe('a')).toBe(true)
    expect(editor.hasShapeKeyframeAt(layerId, 'a', 5)).toBe(true)
    const layer = getLayer(editor.document, layerId)!
    expect(layer.keyframes.some((keyframe) => keyframe.frame === 5)).toBe(true)

    // Seeking back stays inside the extended timeline.
    editor.seekToFrame(2)
    expect(editor.currentFrame).toBe(2)
    expect(editor.duration).toBe(6)
  })

  it('insertKeyframeHere and removeKeyframeHere act on the selected object', () => {
    editor.addShape(rect('a'))
    editor.addShape(rect('b'))
    const layerId = editor.currentLayerId
    editor.insertFrameHere()
    editor.setFrame(1)

    editor.selectShapes(['a'], 'replace')
    expect(editor.insertKeyframeHere()).toBe(true)
    expect(editor.hasShapeKeyframeAt(layerId, 'a', 1)).toBe(true)
    expect(editor.hasShapeKeyframeAt(layerId, 'b', 1)).toBe(false)

    expect(editor.removeKeyframeHere()).toBe(true)
    expect(editor.hasShapeKeyframeAt(layerId, 'a', 1)).toBe(false)

    // Without a selection both actions are no-ops.
    editor.selectShapes([], 'replace')
    expect(editor.insertKeyframeHere()).toBe(false)
    expect(editor.removeKeyframeHere()).toBe(false)
  })
})

describe('Editor multi-select', () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor(createDocument('test', 960, 540, 24))
  })

  function rectAt(id: string, x: number, y: number): Shape {
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

  function contentIds(): string[] {
    const layer = getLayer(editor.document, editor.currentLayerId)!
    return evaluateLayerAtFrame(layer, editor.currentFrame).map((shape) => shape.id)
  }

  it('selectShapes replaces, adds and toggles membership', () => {
    editor.addShape(rectAt('a', 0, 0))
    editor.addShape(rectAt('b', 100, 0))
    editor.addShape(rectAt('c', 200, 0))

    editor.selectShapes(['a'], 'replace')
    expect(editor.selectedShapeIds).toEqual(['a'])
    expect(editor.primarySelectedShapeId).toBe('a')

    editor.selectShapes(['b'], 'add')
    expect(editor.selectedShapeIds).toEqual(['a', 'b'])
    expect(editor.primarySelectedShapeId).toBe('b')

    editor.selectShapes(['a'], 'toggle')
    expect(editor.selectedShapeIds).toEqual(['b'])

    // Neither 'a' nor 'c' is selected, so both get added.
    editor.selectShapes(['a', 'c'], 'toggle')
    expect([...editor.selectedShapeIds].sort()).toEqual(['a', 'b', 'c'])

    editor.selectShapes(['b', 'c'], 'replace')
    expect(editor.selectedShapeIds).toEqual(['b', 'c'])
  })

  it('updateSelectedShapes moves the whole selection and auto-keys each shape', () => {
    editor.addShape(rectAt('a', 0, 0))
    editor.addShape(rectAt('b', 100, 0))
    editor.addShape(rectAt('c', 200, 0))
    const layerId = editor.currentLayerId
    editor.selectShapes(['a', 'c'], 'replace')

    editor.seekToFrame(3)
    editor.updateSelectedShapes((shape) => {
      shape.center.x += 50
    })

    expect(editor.hasShapeKeyframeAt(layerId, 'a', 3)).toBe(true)
    expect(editor.hasShapeKeyframeAt(layerId, 'b', 3)).toBe(false)
    expect(editor.hasShapeKeyframeAt(layerId, 'c', 3)).toBe(true)
    const layer = getLayer(editor.document, layerId)!
    const content = evaluateLayerAtFrame(layer, 3)
    expect(content.find((shape) => shape.id === 'a')?.center.x).toBe(50)
    expect(content.find((shape) => shape.id === 'c')?.center.x).toBe(250)
    // Only the two selected shapes received the keyframe at frame 3.
    expect(layer.keyframes.find((keyframe) => keyframe.frame === 3)!.shapes).toHaveLength(2)
  })

  it('nudgeSelected and deleteSelected operate on the whole selection', () => {
    editor.addShape(rectAt('a', 0, 0))
    editor.addShape(rectAt('b', 100, 0))
    editor.addShape(rectAt('c', 200, 0))
    editor.selectShapes(['a', 'b'], 'replace')

    editor.nudgeSelected(10, 5)
    const layer = getLayer(editor.document, editor.currentLayerId)!
    const content = evaluateLayerAtFrame(layer, 0)
    expect(content.find((shape) => shape.id === 'a')?.center).toEqual({ x: 10, y: 5 })
    expect(content.find((shape) => shape.id === 'b')?.center).toEqual({ x: 110, y: 5 })
    expect(content.find((shape) => shape.id === 'c')?.center).toEqual({ x: 200, y: 0 })

    editor.deleteSelected()
    expect(contentIds()).toEqual(['c'])
    expect(editor.selectedShapeIds).toEqual([])
  })

  it('insertKeyframeHere keys every selected shape', () => {
    editor.addShape(rectAt('a', 0, 0))
    editor.addShape(rectAt('b', 100, 0))
    const layerId = editor.currentLayerId
    editor.insertFrameHere()
    editor.setFrame(1)
    editor.selectShapes(['a', 'b'], 'replace')

    expect(editor.insertKeyframeHere()).toBe(true)
    expect(editor.hasShapeKeyframeAt(layerId, 'a', 1)).toBe(true)
    expect(editor.hasShapeKeyframeAt(layerId, 'b', 1)).toBe(true)
  })

  it('getSelectionBounds returns the union of the selected shape bounds', () => {
    editor.addShape(rectAt('a', 10, 20))
    editor.addShape(rectAt('b', 100, 80))
    editor.selectShapes(['a'], 'replace')
    expect(editor.getSelectionBounds()).toEqual({ x: 5, y: 15, width: 10, height: 10 })

    editor.selectShapes(['b'], 'add')
    expect(editor.getSelectionBounds()).toEqual({ x: 5, y: 15, width: 100, height: 70 })

    editor.selectShapes([], 'replace')
    expect(editor.getSelectionBounds()).toBeNull()
  })
})
