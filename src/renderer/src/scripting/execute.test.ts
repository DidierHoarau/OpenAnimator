// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import type { LibraryListResult } from '@shared/api'
import { isAudioLayer, isObjectLayer } from '@shared/model'
import type { Asset, DrawingLayer, PrimitiveNode } from '@shared/model'
import { DEFAULT_PREFERENCES } from '@shared/preferences'
import type { ExportOptions } from '@shared/exportOptions'
import { createStarterDocument } from '@shared/starterDocument'
import { SCRIPT_EXAMPLES } from '@shared/scripting/examples'
import { validateScriptPayload } from '@shared/scripting/commands'

import { Editor } from '../editor'
import { executeScriptCommands } from './execute'
import type {
  ScriptExportBridge,
  ScriptGlobalPaletteBridge,
  ScriptImportAudioBridge,
  ScriptImportAudioRequest,
  ScriptImportImageBridge,
  ScriptImportImageRequest,
  ScriptLibraryBridge,
  ScriptPreferencesBridge
} from './execute'

const AUDIO_RESOURCE = 'a1b2c3d4'.repeat(8)
const AUDIO_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])

function createEditor(): Editor {
  return new Editor(createStarterDocument(), {
    measureText: (line: string) => line.length * 10
  })
}

function validated(commands: unknown): ReturnType<typeof validateScriptPayload>['commands'] {
  const { commands: parsed, errors } = validateScriptPayload(commands)
  if (errors.length > 0) throw new Error(`fixture invalid: ${errors.join('; ')}`)
  return parsed
}

function ballLayer(editor: Editor) {
  const layer = editor.document.layers.find((entry) => entry.name === 'Ball')
  if (!layer || !isObjectLayer(layer)) throw new Error('expected the Ball object layer')
  return layer
}

function namedLayer(editor: Editor, name: string) {
  const layer = editor.document.layers.find((entry) => entry.name === name)
  if (!layer || !isObjectLayer(layer)) throw new Error(`expected the ${name} object layer`)
  return layer
}

function rectNode(id: string, center: { x: number; y: number } = { x: 100, y: 100 }): PrimitiveNode {
  return {
    type: 'primitive',
    id,
    primitive: 'rect',
    name: id,
    width: 50,
    height: 50,
    center: { ...center },
    rotation: 0,
    opacity: 1,
    fill: '#334155'
  }
}

describe('executeScriptCommands', () => {
  it('applies the bouncing ball example end to end', async () => {
    const editor = createEditor()
    const commands = validated({ commands: SCRIPT_EXAMPLES[0].commands })
    const result = await executeScriptCommands(editor, commands)
    expect(result.issues).toEqual([])
    expect(result.applied).toBe(commands.length)

    const layer = ballLayer(editor)
    const at = (frame: number) =>
      layer.keyframes.find((keyframe) => keyframe.frame === frame)?.nodes.find((node) => node.id === 'ball')
    expect(at(0)).toMatchObject({ type: 'primitive', primitive: 'ellipse', fill: '#ff5252' })
    expect(at(11)).toMatchObject({ center: { x: 480, y: 450 } })
    expect(at(23)).toMatchObject({ center: { x: 480, y: 100 } })
    expect(layer.keyframes[0].tween).toMatchObject({ easing: 'ease-in' })
    expect(layer.keyframes[1].tween).toMatchObject({ easing: 'ease-out' })
    expect(editor.duration).toBe(24)
  })

  it('applies the title card fade-in example with refreshed text metrics', async () => {
    const editor = createEditor()
    const commands = validated({ commands: SCRIPT_EXAMPLES[1].commands })
    const result = await executeScriptCommands(editor, commands)
    expect(result.issues).toEqual([])
    expect(result.applied).toBe(commands.length)

    const layer = editor.document.layers.find((entry) => entry.name === 'Title')
    if (!layer || !isObjectLayer(layer)) throw new Error('expected the Title object layer')
    const start = layer.keyframes[0].nodes[0]
    expect(start).toMatchObject({ type: 'text', text: 'OPENANIMATOR', opacity: 0 })
    const end = layer.keyframes[1].nodes[0]
    expect(end).toMatchObject({ opacity: 1 })
  })

  it('re-measures the text box when typography patches change the layout', async () => {
    const editor = createEditor()
    const commands = validated({
      commands: [
        { op: 'addLayer', kind: 'object', name: 'Caption' },
        {
          op: 'addNode',
          frame: 0,
          node: {
            type: 'text',
            id: 'caption',
            text: 'AB\nCD',
            fontFamily: 'Noto Sans',
            fontSize: 10,
            fontWeight: 400,
            align: 'left',
            fill: '#ffffff',
            width: 20,
            height: 25,
            center: { x: 480, y: 270 },
            rotation: 0,
            opacity: 1
          }
        },
        // letterSpacing widens the measured lines, lineHeight grows the box.
        { op: 'updateNode', nodeId: 'caption', patch: { letterSpacing: 5 } },
        { op: 'updateNode', nodeId: 'caption', frame: 0, patch: { lineHeight: 2 } }
      ]
    })
    const result = await executeScriptCommands(editor, commands)
    expect(result.issues).toEqual([])
    const layer = editor.document.layers.find((entry) => entry.name === 'Caption')
    if (!layer || !isObjectLayer(layer)) throw new Error('expected the Caption object layer')
    expect(layer.keyframes[0].nodes[0]).toMatchObject({ width: 30, height: 40 })
  })

  it('reports per-command issues without aborting the rest of the script', async () => {
    const editor = createEditor()
    const commands = validated({
      commands: [
        { op: 'updateNode', nodeId: 'ghost', patch: { opacity: 0.5 } },
        { op: 'addLayer', name: 'Scratch' },
        { op: 'removeLayer', layerId: 'missing-layer' }
      ]
    })
    const result = await executeScriptCommands(editor, commands)
    expect(result.applied).toBe(1)
    expect(result.issues).toHaveLength(2)
    expect(result.issues[0]).toMatchObject({ index: 0, severity: 'error' })
    expect(result.issues[1]).toMatchObject({ index: 2, severity: 'error' })
    expect(editor.document.layers.some((layer) => layer.name === 'Scratch')).toBe(true)
  })

  it('warns instead of failing on clamped seeks and idempotent durations', async () => {
    const editor = createEditor()
    const commands = validated({
      commands: [
        { op: 'seek', frame: 999 },
        { op: 'setDuration', frames: 25 }
      ]
    })
    const result = await executeScriptCommands(editor, commands)
    expect(result.issues).toHaveLength(2)
    expect(result.issues.every((issue) => issue.severity === 'warning')).toBe(true)
    expect(editor.currentFrame).toBe(editor.duration - 1)
  })

  it('rejects setCell on object layers and setTween on frames without a keyframe', async () => {
    const editor = createEditor()
    const commands = validated({
      commands: [
        { op: 'setCell', resourceId: 'res-1', frame: 0 },
        { op: 'setTween', frame: 5 }
      ]
    })
    const result = await executeScriptCommands(editor, commands)
    expect(result.applied).toBe(0)
    expect(result.issues).toHaveLength(2)
  })

  it('commits each command as exactly one undo entry', async () => {
    const editor = createEditor()
    const commands = validated({ commands: SCRIPT_EXAMPLES[0].commands })
    await executeScriptCommands(editor, commands)
    expect(editor.duration).toBe(24)

    editor.undo()
    // The last command was setDuration: the animation content stays.
    expect(editor.duration).toBe(25)
    expect(editor.document.layers.some((layer) => layer.name === 'Ball')).toBe(true)

    // Undoing the whole script eventually restores the starter document.
    for (let index = 1; index < commands.length; index += 1) editor.undo()
    expect(editor.document.layers.some((layer) => layer.name === 'Ball')).toBe(false)
  })

  it('deletes nodes and keys poses through the same pipeline as gestures', async () => {
    const editor = createEditor()
    const commands = validated({
      commands: [
        { op: 'addLayer', name: 'Ball' },
        {
          op: 'addNode',
          node: {
            type: 'primitive',
            id: 'ball',
            primitive: 'ellipse',
            fill: '#ff5252',
            center: { x: 480, y: 100 },
            width: 90,
            height: 90,
            rotation: 0,
            opacity: 1
          }
        },
        { op: 'updateNode', nodeId: 'ball', frame: 11, patch: { rotation: 45 } },
        { op: 'deleteNode', nodeId: 'ball' }
      ]
    })
    const result = await executeScriptCommands(editor, commands)
    expect(result.issues).toEqual([])
    expect(result.applied).toBe(4)
    const layer = ballLayer(editor)
    expect(layer.keyframes.every((keyframe) => !keyframe.nodes.some((node) => node.id === 'ball'))).toBe(true)
  })

  it('applies the retimed slide example: bezier ease, smooth path, moved keyframe, hold step', async () => {
    const editor = createEditor()
    const commands = validated({ commands: SCRIPT_EXAMPLES[2].commands })
    const result = await executeScriptCommands(editor, commands)
    expect(result.issues).toEqual([])
    expect(result.applied).toBe(commands.length)

    const layer = editor.document.layers.find((entry) => entry.name === 'Square')
    if (!layer || !isObjectLayer(layer)) throw new Error('expected the Square object layer')
    // updateNode keyed 0/11/23, then moveKeyframe retimed the middle pose to 9.
    expect(layer.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 9, 23])
    expect(layer.keyframes[0].tween).toEqual({
      easing: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
      path: 'smooth'
    })
    expect(editor.holdStep).toBe(2)
    expect(editor.document.holdStep).toBe(2)
    expect(editor.duration).toBe(24)
  })

  it('moveKeyframe retimes a pose as one undo entry and warns when nothing moves', async () => {
    const editor = createEditor()
    const setup = validated({
      commands: [
        { op: 'addLayer', name: 'Ball' },
        {
          op: 'addNode',
          frame: 0,
          node: {
            type: 'primitive',
            id: 'ball',
            primitive: 'ellipse',
            fill: '#ff5252',
            center: { x: 480, y: 100 },
            width: 90,
            height: 90,
            rotation: 0,
            opacity: 1
          }
        },
        { op: 'updateNode', nodeId: 'ball', frame: 11, patch: { rotation: 45 } },
        { op: 'moveKeyframe', nodeId: 'ball', fromFrame: 11, toFrame: 7 }
      ]
    })
    const result = await executeScriptCommands(editor, setup)
    expect(result.issues).toEqual([])
    expect(result.applied).toBe(4)
    expect(ballLayer(editor).keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 7])

    editor.undo()
    expect(ballLayer(editor).keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 11])

    // No-op, missing-source and unknown-node moves warn without changing anything.
    const warnings = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'moveKeyframe', nodeId: 'ball', fromFrame: 11, toFrame: 11 },
          { op: 'moveKeyframe', nodeId: 'ball', fromFrame: 20, toFrame: 3 },
          { op: 'moveKeyframe', nodeId: 'ghost', fromFrame: 0, toFrame: 3 }
        ]
      })
    )
    expect(warnings.applied).toBe(0)
    expect(warnings.issues).toHaveLength(3)
    expect(warnings.issues[0]).toMatchObject({ index: 0, severity: 'warning' })
    expect(warnings.issues[1]).toMatchObject({ index: 1, severity: 'warning' })
    expect(warnings.issues[2]).toMatchObject({ index: 2, severity: 'error' })
  })

  it('copyKeyframes copies a chunk to the target frame, carrying a tween once', async () => {
    const editor = createEditor()
    const setup = validated({
      commands: [
        { op: 'addLayer', name: 'Ball' },
        {
          op: 'addNode',
          frame: 0,
          node: {
            type: 'primitive',
            id: 'ball',
            primitive: 'ellipse',
            fill: '#ff5252',
            center: { x: 480, y: 100 },
            width: 90,
            height: 90,
            rotation: 0,
            opacity: 1
          }
        },
        { op: 'setTween', frame: 0, easing: 'ease-in' },
        { op: 'updateNode', nodeId: 'ball', frame: 5, patch: { center: { x: 480, y: 450 } } },
        { op: 'copyKeyframes', nodeId: 'ball', fromFrame: 0, toFrame: 5, targetFrame: 12 }
      ]
    })
    const result = await executeScriptCommands(editor, setup)
    expect(result.issues).toEqual([])
    expect(result.applied).toBe(5)
    const layer = ballLayer(editor)
    expect(layer.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 5, 12, 17])
    const at = (frame: number) =>
      layer.keyframes.find((keyframe) => keyframe.frame === frame)?.nodes.find((node) => node.id === 'ball')
    expect(at(12)).toMatchObject({ center: { x: 480, y: 100 } })
    expect(at(17)).toMatchObject({ center: { x: 480, y: 450 } })
    expect(layer.keyframes.find((keyframe) => keyframe.frame === 12)?.tween).toEqual({ easing: 'ease-in' })

    editor.undo()
    expect(ballLayer(editor).keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 5])

    // No poses in the requested range and an out-of-bounds target warn.
    const warnings = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'copyKeyframes', nodeId: 'ball', fromFrame: 20, toFrame: 22, targetFrame: 0 },
          { op: 'copyKeyframes', nodeId: 'ball', fromFrame: 0, toFrame: 0, targetFrame: 999 }
        ]
      })
    )
    expect(warnings.applied).toBe(0)
    expect(warnings.issues).toHaveLength(2)
    expect(warnings.issues[0]).toMatchObject({ index: 0, severity: 'warning' })
    expect(warnings.issues[1]).toMatchObject({ index: 1, severity: 'warning' })
  })

  it('setHoldStep plays the document on n\u2019s without touching the frame data', async () => {
    const editor = createEditor()
    const setup = validated({
      commands: [
        { op: 'addLayer', name: 'Ball' },
        {
          op: 'addNode',
          frame: 0,
          node: {
            type: 'primitive',
            id: 'ball',
            primitive: 'ellipse',
            fill: '#ff5252',
            center: { x: 480, y: 100 },
            width: 90,
            height: 90,
            rotation: 0,
            opacity: 1
          }
        },
        { op: 'setHoldStep', step: 3 }
      ]
    })
    const result = await executeScriptCommands(editor, setup)
    expect(result.issues).toEqual([])
    expect(editor.holdStep).toBe(3)
    expect(editor.document.holdStep).toBe(3)
    const before = JSON.stringify(ballLayer(editor).keyframes)
    executeScriptCommands(editor, validated({ commands: [{ op: 'seek', frame: 4 }] }))
    expect(editor.holdStep).toBe(3)
    expect(JSON.stringify(ballLayer(editor).keyframes)).toBe(before)

    // 1 removes the field entirely; undo walks back one command at a time.
    executeScriptCommands(editor, validated({ commands: [{ op: 'setHoldStep', step: 1 }] }))
    expect(editor.holdStep).toBe(1)
    expect('holdStep' in editor.document).toBe(false)
    editor.undo()
    expect(editor.holdStep).toBe(3)
    editor.undo()
    expect(editor.holdStep).toBe(3)
    editor.undo()
    expect(editor.holdStep).toBe(1)
  })

  it('addLayer camera creates the singleton camera layer once', async () => {
    const editor = createEditor()
    const result = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'addLayer', kind: 'camera', name: 'Cam' },
          { op: 'addLayer', kind: 'camera' }
        ]
      })
    )
    expect(result.applied).toBe(1)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ index: 1, severity: 'error' })
    expect(result.issues[0].message).toContain('already has a camera layer')
    expect(editor.cameraLayer?.name).toBe('Cam')
  })

  it('setCameraKeyframe creates the camera layer on demand and keys poses', async () => {
    const editor = createEditor()
    const commands = validated({
      commands: [
        { op: 'setCameraKeyframe', frame: 0, center: { x: 100, y: 80 }, zoom: 2, rotation: 30, tween: true },
        { op: 'setCameraKeyframe', frame: 12, center: { x: 480, y: 270 } }
      ]
    })
    const result = await executeScriptCommands(editor, commands)
    expect(result.issues).toEqual([])
    expect(result.applied).toBe(2)

    const layer = editor.cameraLayer
    if (!layer) throw new Error('expected the camera layer')
    expect(layer.name).toBe('Camera')
    expect(layer.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 12])
    expect(layer.keyframes[0].pose).toEqual({ center: { x: 100, y: 80 }, zoom: 2, rotation: 30 })
    expect(layer.keyframes[0].tween).toEqual({ easing: 'ease-in-out' })
    // The second key holds the sampled pose; only its center was patched.
    expect(layer.keyframes[1].pose).toEqual({ center: { x: 480, y: 270 }, zoom: 2, rotation: 30 })
    expect(layer.keyframes[1].tween).toBeUndefined()

    // The whole keying flow is one undo entry per command.
    editor.undo()
    expect(editor.cameraLayer?.keyframes.map((keyframe) => keyframe.frame)).toEqual([0])
    editor.undo()
    expect(editor.cameraLayer).toBeUndefined()
  })

  it('clamps out-of-range camera frames, warns on missing keyframes and errors without a camera', async () => {
    const editor = createEditor()
    // Removing before any camera layer exists is an error.
    const noCamera = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'removeCameraKeyframe', frame: 0 }] })
    )
    expect(noCamera.applied).toBe(0)
    expect(noCamera.issues[0]).toMatchObject({ index: 0, severity: 'error' })
    expect(noCamera.issues[0].message).toContain('no camera layer')

    // Keys past the timeline clamp to the last frame with a warning.
    const clamped = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'setCameraKeyframe', frame: 999 }] })
    )
    expect(clamped.applied).toBe(1)
    expect(clamped.issues).toHaveLength(1)
    expect(clamped.issues[0]).toMatchObject({ index: 0, severity: 'warning' })
    expect(editor.currentFrame).toBe(editor.duration - 1)
    expect(editor.hasCameraKeyframeAt(editor.duration - 1)).toBe(true)

    // Removing a frame without a keyframe warns; the keyed frame is removed.
    const missing = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'removeCameraKeyframe', frame: 5 }] })
    )
    expect(missing.applied).toBe(0)
    expect(missing.issues[0]).toMatchObject({ index: 0, severity: 'warning' })

    const removed = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'removeCameraKeyframe', frame: editor.duration - 1 }] })
    )
    expect(removed.issues).toEqual([])
    expect(removed.applied).toBe(1)
    expect(editor.cameraLayer?.keyframes.map((keyframe) => keyframe.frame)).toEqual([0])
  })

  it('setTween targets the camera layer with easings, smooth paths and clearing', async () => {
    const editor = createEditor()
    const setup = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'setCameraKeyframe', frame: 0, center: { x: 100, y: 80 } },
          { op: 'setCameraKeyframe', frame: 12, center: { x: 480, y: 270 } },
          { op: 'setTween', frame: 0, easing: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 }, path: 'smooth' }
        ]
      })
    )
    expect(setup.issues).toEqual([])
    expect(setup.applied).toBe(3)
    const layer = editor.cameraLayer
    if (!layer) throw new Error('expected the camera layer')
    expect(layer.keyframes[0].tween).toEqual({
      easing: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
      path: 'smooth'
    })

    // Clearing with `easing: null` works; a frame with no camera key errors.
    const cleared = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'setTween', frame: 0, easing: null },
          { op: 'setTween', frame: 5 }
        ]
      })
    )
    expect(cleared.applied).toBe(1)
    expect(cleared.issues).toHaveLength(1)
    expect(cleared.issues[0]).toMatchObject({ index: 1, severity: 'error' })
    expect(layer.keyframes[0].tween).toBeUndefined()
  })

  it('setTween applies per-channel easings and clears channels with null', async () => {
    const editor = createEditor()
    const setup = validated({
      commands: [
        { op: 'addLayer', name: 'Ball' },
        {
          op: 'addNode',
          frame: 0,
          node: rectNode('ball', { x: 100, y: 100 })
        },
        {
          op: 'setTween',
          frame: 0,
          easing: 'linear',
          easings: { opacity: 'ease-in', fill: { x1: 0.1, y1: 0, x2: 0.9, y2: 1 } }
        },
        { op: 'updateNode', nodeId: 'ball', frame: 10, patch: { center: { x: 300, y: 100 } } }
      ]
    })
    const result = await executeScriptCommands(editor, setup)
    expect(result.issues).toEqual([])
    expect(result.applied).toBe(4)
    const tween = () => ballLayer(editor).keyframes[0].tween
    expect(tween()).toEqual({
      easing: 'linear',
      easings: { opacity: 'ease-in', fill: { x1: 0.1, y1: 0, x2: 0.9, y2: 1 } }
    })

    // `null` clears one channel; the untouched override survives.
    const cleared = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'setTween', frame: 0, easing: 'linear', easings: { opacity: null } }] })
    )
    expect(cleared.issues).toEqual([])
    expect(cleared.applied).toBe(1)
    expect(tween()).toEqual({ easing: 'linear', easings: { fill: { x1: 0.1, y1: 0, x2: 0.9, y2: 1 } } })

    // Camera keyframes ignore the field with a warning.
    const camera = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'setCameraKeyframe', frame: 0 },
          { op: 'setTween', frame: 0, easings: { transform: 'ease-out' } }
        ]
      })
    )
    expect(camera.applied).toBe(2)
    expect(camera.issues).toHaveLength(1)
    expect(camera.issues[0]).toMatchObject({ index: 1, severity: 'warning' })
    expect(camera.issues[0].message).toContain('object keyframes only')
  })

  it('adds audio layers from session resources and applies setAudio edits', async () => {
    const editor = createEditor()
    editor.resources.put(AUDIO_RESOURCE, AUDIO_BYTES)
    const added = await executeScriptCommands(
      editor,
      validated({
        commands: [{ op: 'addLayer', kind: 'audio', resourceId: AUDIO_RESOURCE, name: 'Score', startFrame: 4 }]
      })
    )
    expect(added.issues).toEqual([])
    expect(added.applied).toBe(1)
    const layer = editor.document.layers.find((entry) => entry.name === 'Score')
    if (!layer || !isAudioLayer(layer)) throw new Error('expected the Score audio layer')
    expect(layer).toMatchObject({ resourceId: AUDIO_RESOURCE, startFrame: 4, volume: 1, visible: true })

    const edited = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'setAudio', layerId: layer.id, startFrame: 10, volume: 0.5, muted: true }] })
    )
    expect(edited.issues).toEqual([])
    expect(edited.applied).toBe(1)
    expect(layer).toMatchObject({ startFrame: 10, volume: 0.5, visible: false })

    // `muted` mirrors the visible flag: asking for the state it is in toggles.
    const unmuted = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'setAudio', layerId: layer.id, muted: false }] })
    )
    expect(unmuted.issues).toEqual([])
    expect(layer.visible).toBe(true)

    // Locked layers and non-audio ids are rejected without aborting the run.
    layer.locked = true
    const locked = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'setAudio', layerId: layer.id, volume: 0.2 }] })
    )
    expect(locked.applied).toBe(0)
    expect(locked.issues[0]).toMatchObject({ index: 0, severity: 'error' })
    layer.locked = false

    const wrongKind = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'setAudio', layerId: editor.document.layers[0].id, volume: 0.2 }] })
    )
    expect(wrongKind.applied).toBe(0)
    expect(wrongKind.issues[0]).toMatchObject({ index: 0, severity: 'error' })
    expect(wrongKind.issues[0].message).toContain('not an audio layer')
  })

  it('reports a missing audio resource instead of adding the layer', async () => {
    const editor = createEditor()
    const result = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'addLayer', kind: 'audio', resourceId: 'not-here', name: 'Ghost', startFrame: 0 },
          { op: 'addLayer', name: 'After' }
        ]
      })
    )
    expect(result.applied).toBe(1)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ index: 0, severity: 'error' })
    expect(result.issues[0].message).toContain('not available')
    expect(editor.document.layers.some((layer) => layer.name === 'Ghost')).toBe(false)
    expect(editor.document.layers.some((layer) => layer.name === 'After')).toBe(true)
  })

  it('groups and ungroups nodes, reporting the ids needed to chain commands', async () => {
    const editor = createEditor()
    const result = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'addLayer', kind: 'object', name: 'Shapes' },
          { op: 'addNode', frame: 0, node: rectNode('a') },
          { op: 'addNode', frame: 0, node: rectNode('b', { x: 200, y: 100 }) },
          { op: 'group', nodeIds: ['a', 'b'] }
        ]
      })
    )
    expect(result.applied).toBe(4)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ index: 3, severity: 'warning' })
    expect(result.issues[0].message).toContain('grouped into node')

    const layer = namedLayer(editor, 'Shapes')
    expect(layer.keyframes[0].nodes).toHaveLength(1)
    const group = layer.keyframes[0].nodes[0]
    expect(group.type).toBe('group')

    // Ungroup round-trips back to the two rects as one undo entry.
    const ungrouped = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'ungroup', nodeIds: [group.id] }] })
    )
    expect(ungrouped.applied).toBe(1)
    expect(ungrouped.issues).toHaveLength(1)
    expect(ungrouped.issues[0].message).toContain('dissolved into nodes')
    expect(layer.keyframes[0].nodes.map((node) => node.id).sort()).toEqual(['a', 'b'])

    editor.undo()
    expect(namedLayer(editor, 'Shapes').keyframes[0].nodes).toHaveLength(1)

    // Selection-based commands fail cleanly when the nodes are unknown.
    const missing = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'group', nodeIds: ['ghost'], layerId: layer.id },
          { op: 'ungroup', nodeIds: ['ghost'], layerId: layer.id }
        ]
      })
    )
    expect(missing.applied).toBe(0)
    expect(missing.issues).toHaveLength(2)
    expect(missing.issues.every((entry) => entry.severity === 'warning')).toBe(true)
  })

  it('runs the symbol round trip: create, place, edit, commit and break apart', async () => {
    const editor = createEditor()
    const created = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'addLayer', kind: 'object', name: 'Shapes' },
          { op: 'addNode', frame: 0, node: rectNode('a') },
          { op: 'createSymbol', nodeIds: ['a'], name: 'Star' }
        ]
      })
    )
    expect(created.applied).toBe(3)
    expect(created.issues).toHaveLength(1)
    expect(created.issues[0].message).toContain('created symbol asset')
    const asset = editor.document.assets.find((entry) => entry.name === 'Star')
    if (!asset) throw new Error('expected the Star symbol asset')

    // placeAsset adds an independent instance at the requested position.
    const placed = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'placeAsset', assetId: asset.id, at: { x: 300, y: 200 } }] })
    )
    expect(placed.applied).toBe(1)
    expect(placed.issues).toHaveLength(1)
    expect(placed.issues[0].message).toContain('placed as node')
    const layer = namedLayer(editor, 'Shapes')
    const instances = layer.keyframes[0].nodes.filter((node) => node.type === 'symbol')
    expect(instances).toHaveLength(2)
    expect(instances[1]).toMatchObject({ assetId: asset.id, center: { x: 300, y: 200 } })

    // editSymbol parks the document; nested edits only touch the scratch copy.
    const editing = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'editSymbol', assetId: asset.id }] })
    )
    expect(editing.applied).toBe(1)
    expect(editor.editingAssetId).toBe(asset.id)
    const nested = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'editSymbol', assetId: asset.id }] })
    )
    expect(nested.applied).toBe(0)
    expect(nested.issues[0].message).toContain('already editing')
    const beforeChildren = asset.content?.children.length ?? 0
    const inner = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'addNode', frame: 0, node: rectNode('accent', { x: 0, y: 0 }) }] })
    )
    expect(inner.applied).toBe(1)
    const committed = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'endSymbolEdit', commit: true }] })
    )
    expect(committed.applied).toBe(1)
    expect(editor.editingAssetId).toBeNull()
    const updated = editor.document.assets.find((entry) => entry.id === asset.id)
    if (!updated || updated.kind !== 'symbol' || !updated.content) {
      throw new Error('expected the symbol content to exist')
    }
    expect(updated.content.children.some((child) => child.id === 'accent')).toBe(true)
    expect(updated.content.children.length).toBe(beforeChildren + 1)

    // A discarded edit session leaves the asset untouched.
    const reopened = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'editSymbol', assetId: asset.id },
          { op: 'addNode', frame: 0, node: rectNode('junk', { x: 0, y: 0 }) }
        ]
      })
    )
    expect(reopened.applied).toBe(2)
    const discarded = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'endSymbolEdit', commit: false }] })
    )
    expect(discarded.applied).toBe(1)
    expect(updated.content.children.some((child) => child.id === 'junk')).toBe(false)

    // breakApart replaces an instance with editable group content.
    const instanceId = instances[0].id
    const broken = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'breakApart', nodeId: instanceId, layerId: layer.id }] })
    )
    expect(broken.applied).toBe(1)
    expect(broken.issues).toHaveLength(1)
    expect(broken.issues[0].message).toContain('replaced by group')
    const node = layer.keyframes[0].nodes.find((entry) => entry.id === instances[0].id)
    expect(node).toBeUndefined()
    expect(layer.keyframes[0].nodes.some((entry) => entry.type === 'group')).toBe(true)

    // endSymbolEdit outside an edit session, and editSymbol on a non-symbol.
    const stray = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'endSymbolEdit', commit: false }] })
    )
    expect(stray.applied).toBe(0)
    expect(stray.issues[0].message).toContain('not editing a symbol')
    const notSymbol = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'editSymbol', assetId: 'ghost-asset' }] })
    )
    expect(notSymbol.applied).toBe(0)
    expect(notSymbol.issues[0].message).toContain('not a symbol asset')
  })

  it('renames, duplicates and deletes assets with instance warnings', async () => {
    const editor = createEditor()
    await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'addLayer', kind: 'object', name: 'Shapes' },
          { op: 'addNode', frame: 0, node: rectNode('a') },
          { op: 'createSymbol', nodeIds: ['a'], name: 'Star' }
        ]
      })
    )
    const asset = editor.document.assets.find((entry) => entry.name === 'Star')
    if (!asset) throw new Error('expected the Star symbol asset')

    const renamed = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'renameAsset', assetId: asset.id, name: 'Comet' }] })
    )
    expect(renamed.issues).toEqual([])
    expect(asset.name).toBe('Comet')

    const duplicated = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'duplicateAsset', assetId: asset.id }] })
    )
    expect(duplicated.applied).toBe(1)
    expect(duplicated.issues).toHaveLength(1)
    expect(duplicated.issues[0].message).toContain('created asset')
    const copy = editor.document.assets.find((entry) => entry.name === 'Comet copy')
    if (!copy) throw new Error('expected the duplicated asset')

    // The copy has no instances: deleting it is silent.
    const deletedCopy = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'deleteAsset', assetId: copy.id }] })
    )
    expect(deletedCopy.applied).toBe(1)
    expect(deletedCopy.issues).toEqual([])

    // Deleting an instantiated asset warns about the placeholders.
    const deleted = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'deleteAsset', assetId: asset.id }] })
    )
    expect(deleted.applied).toBe(1)
    expect(deleted.issues).toHaveLength(1)
    expect(deleted.issues[0].message).toContain('placeholder')
    expect(editor.document.assets.some((entry) => entry.id === asset.id)).toBe(false)

    const missing = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'renameAsset', assetId: 'ghost', name: 'X' },
          { op: 'duplicateAsset', assetId: 'ghost' },
          { op: 'deleteAsset', assetId: 'ghost' }
        ]
      })
    )
    expect(missing.applied).toBe(0)
    expect(missing.issues).toHaveLength(3)
    expect(missing.issues.every((entry) => entry.severity === 'error')).toBe(true)
  })

  it('saves to and inserts from the global library through the bridge', async () => {
    const editor = createEditor()
    await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'addLayer', kind: 'object', name: 'Shapes' },
          { op: 'addNode', frame: 0, node: rectNode('a') },
          { op: 'createSymbol', nodeIds: ['a'], name: 'Star' }
        ]
      })
    )
    const asset = editor.document.assets.find((entry) => entry.name === 'Star')
    if (!asset) throw new Error('expected the Star symbol asset')

    const saved: Asset[] = []
    const listing: LibraryListResult = { assets: [structuredClone(asset)], resources: {} }
    const bridge: ScriptLibraryBridge = {
      listLibrary: vi.fn(async () => listing),
      addLibraryAsset: vi.fn(async (entry: Asset) => {
        saved.push(entry)
      }),
      addResource: vi.fn(async () => ({ resourceId: 'res-lib', deduped: false }))
    }

    // Without a bridge both commands fail with a clear error.
    const noBridge = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'saveToLibrary', assetId: asset.id },
          { op: 'insertFromLibrary', name: 'Star' }
        ]
      })
    )
    expect(noBridge.applied).toBe(0)
    expect(noBridge.issues).toHaveLength(2)
    expect(noBridge.issues[0].message).toContain('not available')

    const saveResult = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'saveToLibrary', assetId: asset.id }] }),
      { library: bridge }
    )
    expect(saveResult.issues).toEqual([])
    expect(saveResult.applied).toBe(1)
    expect(saved.map((entry) => entry.id)).toEqual([asset.id])

    // insertFromLibrary resolves by exact name and places a fresh instance.
    const layer = namedLayer(editor, 'Shapes')
    const inserted = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'insertFromLibrary', name: 'Star', at: { x: 300, y: 200 } }] }),
      { library: bridge }
    )
    expect(inserted.issues).toEqual([])
    expect(inserted.applied).toBe(1)
    const instances = layer.keyframes[0].nodes.filter((node) => node.type === 'symbol')
    expect(instances).toHaveLength(2)
    expect(instances[1]).toMatchObject({ center: { x: 300, y: 200 } })

    // Unknown names error and list the known assets.
    const unknown = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'insertFromLibrary', name: 'Ghost' }] }),
      { library: bridge }
    )
    expect(unknown.applied).toBe(0)
    expect(unknown.issues[0].message).toContain('known assets')
    expect(unknown.issues[0].message).toContain('Star')
  })

  it('inserts and removes timeline frames, shifting later keyframes', async () => {
    const editor = createEditor()
    await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'addLayer', kind: 'object', name: 'Ball' },
          { op: 'addNode', frame: 0, node: rectNode('ball') },
          { op: 'updateNode', nodeId: 'ball', frame: 10, patch: { rotation: 45 } }
        ]
      })
    )
    const layer = ballLayer(editor)
    const frames = (): number[] => ballLayer(editor).keyframes.map((keyframe) => keyframe.frame)
    expect(frames()).toEqual([0, 10])

    const inserted = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'insertFrames', layerId: layer.id, frame: 5, count: 2 }] })
    )
    expect(inserted.issues).toEqual([])
    expect(inserted.applied).toBe(1)
    expect(frames()).toEqual([0, 12])

    const removed = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'removeFrames', layerId: layer.id, frame: 5, count: 1 }] })
    )
    expect(removed.issues).toEqual([])
    expect(removed.applied).toBe(1)
    expect(frames()).toEqual([0, 11])

    // Each command is one undo entry: the removal first, then the whole insert.
    editor.undo()
    expect(frames()).toEqual([0, 12])
    editor.undo()
    expect(frames()).toEqual([0, 10])

    const missing = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'insertFrames', layerId: 'ghost-layer' }] })
    )
    expect(missing.applied).toBe(0)
    expect(missing.issues[0].message).toContain('not found')

    ballLayer(editor).locked = true
    const locked = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'removeFrames', layerId: layer.id }] })
    )
    expect(locked.applied).toBe(0)
    expect(locked.issues[0].message).toContain('locked')
  })

  it('moveCell retimes a drawing cell and moveNodeToFrame retimes a node track', async () => {
    const editor = new Editor(createStarterDocument(), {
      measureText: (line: string) => line.length * 10,
      createTransparentPng: async () => new Uint8Array([0]),
      storeResource: async () => 'res-blank'
    })
    editor.addLayerAtBottom('drawing')
    const layerId = editor.currentLayerId
    editor.commitStroke('res-a', 0)

    const moved = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'moveCell', layerId, fromFrame: 0, toFrame: 3 }] })
    )
    expect(moved.issues).toEqual([])
    expect(moved.applied).toBe(1)
    const drawing = editor.document.layers.find((entry) => entry.id === layerId) as DrawingLayer
    expect(drawing.cells.map((cell) => cell.frame)).toEqual([3])

    // A frame without a cell and a non-drawing layer warn instead of failing.
    const noCell = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'moveCell', layerId, fromFrame: 1, toFrame: 4 }] })
    )
    expect(noCell.applied).toBe(0)
    expect(noCell.issues[0].severity).toBe('warning')
    const wrongKind = await executeScriptCommands(
      editor,
      validated({
        commands: [{ op: 'moveCell', layerId: editor.document.layers[0].id, fromFrame: 0, toFrame: 1 }]
      })
    )
    expect(wrongKind.applied).toBe(0)
    expect(wrongKind.issues[0].severity).toBe('warning')

    // moveNodeToFrame shifts the whole track; the relative timing is kept.
    await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'addLayer', kind: 'object', name: 'Ball' },
          { op: 'addNode', frame: 0, node: rectNode('ball') },
          { op: 'updateNode', nodeId: 'ball', frame: 10, patch: { rotation: 45 } }
        ]
      })
    )
    const retimed = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'moveNodeToFrame', nodeId: 'ball', targetFrame: 4 }] })
    )
    expect(retimed.issues).toEqual([])
    expect(retimed.applied).toBe(1)
    expect(ballLayer(editor).keyframes.map((keyframe) => keyframe.frame)).toEqual([4, 14])

    editor.undo()
    expect(ballLayer(editor).keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 10])

    const warnings = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'moveNodeToFrame', nodeId: 'ghost', targetFrame: 2 },
          { op: 'moveNodeToFrame', nodeId: 'ball', targetFrame: 0 }
        ]
      })
    )
    expect(warnings.applied).toBe(0)
    expect(warnings.issues).toHaveLength(2)
    expect(warnings.issues.every((entry) => entry.severity === 'warning')).toBe(true)
  })

  it('replaces a path geometry with setPathAnchors through the shared commit point', async () => {
    const editor = createEditor()
    const result = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'addLayer', kind: 'object', name: 'Shape' },
          {
            op: 'addNode',
            frame: 0,
            node: {
              type: 'path',
              id: 'stroke',
              d: 'M-50 -20L0 20L50 -20',
              width: 100,
              height: 40,
              center: { x: 480, y: 270 },
              rotation: 0,
              opacity: 1,
              stroke: '#e6edf3',
              strokeWidth: 4
            }
          },
          {
            op: 'setPathAnchors',
            nodeId: 'stroke',
            subpaths: [
              {
                closed: false,
                anchors: [
                  { x: -50, y: -25 },
                  { x: 10, y: 35 },
                  { x: 50, y: -25 }
                ]
              }
            ]
          }
        ]
      })
    )
    expect(result.issues).toEqual([])
    expect(result.applied).toBe(3)

    const layer = namedLayer(editor, 'Shape')
    const node = layer.keyframes[0].nodes.find((entry) => entry.id === 'stroke')
    // The anchor change re-normalizes `d` and shifts the center by the bbox
    // offset (raw center (0,5) → center (480,275)); the size follows.
    expect(node).toMatchObject({
      type: 'path',
      d: 'M-50 -30L10 30L50 -30',
      center: { x: 480, y: 275 },
      width: 100,
      height: 60
    })

    // One undo entry per command. Undo installs a fresh document clone, so
    // the layer has to be re-fetched from the editor.
    editor.undo()
    const restored = namedLayer(editor, 'Shape')
    expect(restored.keyframes[0].nodes.find((entry) => entry.id === 'stroke')).toMatchObject({
      d: 'M-50 -20L0 20L50 -20',
      center: { x: 480, y: 270 }
    })
  })

  it('reports setPathAnchors on non-paths, missing nodes and degenerate geometry', async () => {
    const editor = createEditor()
    const subpaths = [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]
    const result = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'addLayer', kind: 'object', name: 'Shape' },
          { op: 'addNode', frame: 0, node: rectNode('box') },
          { op: 'setPathAnchors', nodeId: 'box', subpaths },
          { op: 'setPathAnchors', nodeId: 'ghost', subpaths }
        ]
      })
    )
    expect(result.applied).toBe(2)
    expect(result.issues).toHaveLength(2)
    expect(result.issues[0].message).toContain('is not a path node')
    expect(result.issues[1].message).toContain('not found on any object layer')

    // Degenerate geometry (all anchors coincident) warns and changes nothing.
    await executeScriptCommands(
      editor,
      validated({
        commands: [
          {
            op: 'addNode',
            frame: 0,
            node: {
              type: 'path',
              id: 'curve',
              d: 'M0 0L10 10',
              width: 10,
              height: 10,
              center: { x: 0, y: 0 },
              rotation: 0,
              opacity: 1,
              stroke: '#e6edf3',
              strokeWidth: 2
            }
          }
        ]
      })
    )
    const degenerate = await executeScriptCommands(
      editor,
      validated({
        commands: [
          {
            op: 'setPathAnchors',
            nodeId: 'curve',
            subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }]
          }
        ]
      })
    )
    expect(degenerate.applied).toBe(0)
    expect(degenerate.issues[0].severity).toBe('warning')
    expect(degenerate.issues[0].message).toContain('degenerate')
  })

  it('duplicateNodes, align and distribute act on the current selection', async () => {
    const editor = createEditor()
    const setup = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'addLayer', kind: 'object', name: 'Shapes' },
          { op: 'addNode', frame: 0, node: rectNode('a', { x: 100, y: 100 }) },
          { op: 'addNode', frame: 0, node: rectNode('b', { x: 200, y: 140 }) },
          { op: 'addNode', frame: 0, node: rectNode('c', { x: 500, y: 180 }) },
          { op: 'group', nodeIds: ['a', 'b', 'c'] }
        ]
      })
    )
    expect(setup.issues).toHaveLength(1)

    // group leaves the new group selected: duplicateNodes needs no fields.
    const duplicated = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'duplicateNodes' }] })
    )
    expect(duplicated.applied).toBe(1)
    expect(duplicated.issues).toHaveLength(1)
    expect(duplicated.issues[0]).toMatchObject({ index: 0, severity: 'warning' })
    expect(duplicated.issues[0].message).toContain('duplicated 1 node')
    expect(namedLayer(editor, 'Shapes').keyframes[0].nodes).toHaveLength(2)

    // One undo entry steps back to the single group.
    editor.undo()
    const groupId = namedLayer(editor, 'Shapes').keyframes[0].nodes[0].id
    expect(namedLayer(editor, 'Shapes').keyframes[0].nodes).toHaveLength(1)

    // Ungrouping selects the children: align/distribute see a multi-selection.
    await executeScriptCommands(editor, validated({ commands: [{ op: 'ungroup', nodeIds: [groupId] }] }))
    const centers = (): Record<string, { x: number; y: number }> =>
      Object.fromEntries(
        namedLayer(editor, 'Shapes').keyframes[0].nodes.map((node) => [node.id, { ...node.center }])
      )

    const distributed = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'distribute', axis: 'h' }] })
    )
    expect(distributed.issues).toEqual([])
    expect(distributed.applied).toBe(1)
    // Outermost two fixed, the middle snaps to even spacing.
    expect(centers()).toMatchObject({
      a: { x: 100, y: 100 },
      b: { x: 300, y: 140 },
      c: { x: 500, y: 180 }
    })

    const aligned = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'align', mode: 'top' }] })
    )
    expect(aligned.issues).toEqual([])
    expect(aligned.applied).toBe(1)
    expect(centers()).toMatchObject({
      a: { x: 100, y: 100 },
      b: { x: 300, y: 100 },
      c: { x: 500, y: 100 }
    })

    // Each command is its own undo entry (align first, then distribute).
    editor.undo()
    expect(centers()).toMatchObject({ b: { x: 300, y: 140 }, c: { x: 500, y: 180 } })
    editor.undo()
    expect(centers()).toMatchObject({ b: { x: 200, y: 140 } })

    // An empty selection warns without failing the run.
    const nothing = await executeScriptCommands(
      createEditor(),
      validated({
        commands: [
          { op: 'align', mode: 'left' },
          { op: 'distribute', axis: 'h' },
          { op: 'duplicateNodes' }
        ]
      })
    )
    expect(nothing.applied).toBe(0)
    expect(nothing.issues).toHaveLength(3)
    expect(nothing.issues.every((entry) => entry.severity === 'warning')).toBe(true)
  })

  it('setPreferences merges through the injected store and warns without one', async () => {
    const editor = createEditor()
    const stored = { ...DEFAULT_PREFERENCES }
    const bridge: ScriptPreferencesBridge = {
      get: () => ({ ...stored }),
      update: async (patch) => {
        Object.assign(stored, patch)
        return { ...stored }
      }
    }
    const applied = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'setPreferences', preferences: { gridSize: 32, showDemoOnNew: true } },
          { op: 'setPreferences', preferences: { gridSize: 32 } }
        ]
      }),
      { preferences: bridge }
    )
    expect(applied.applied).toBe(1)
    expect(applied.issues).toHaveLength(2)
    expect(applied.issues[0].message).toContain('gridSize=32')
    expect(applied.issues[0].message).toContain('showDemoOnNew=true')
    expect(applied.issues[1].message).toContain('no preference changed')
    expect(stored.gridSize).toBe(32)
    expect(stored.showDemoOnNew).toBe(true)

    // Without a store (the CLI context) the command warns instead of failing.
    const noStore = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'setPreferences', preferences: { fps: 30 } }] })
    )
    expect(noStore.applied).toBe(0)
    expect(noStore.issues[0]).toMatchObject({ index: 0, severity: 'warning' })
    expect(noStore.issues[0].message).toContain('no preference store')
  })

  it('export runs through the bridge with sanitized options and reports the path', async () => {
    const editor = createEditor()
    const calls: Array<{ options: ExportOptions; out?: string }> = []
    const bridge: ScriptExportBridge = async (options, out) => {
      calls.push({ options, out })
      return { ok: true, path: out ?? '/tmp/picked.gif' }
    }
    const result = await executeScriptCommands(
      editor,
      validated({
        commands: [
          {
            op: 'export',
            format: 'gif',
            out: '/tmp/bounce.gif',
            fromFrame: 10,
            toFrame: 2,
            scale: 2,
            fps: 12,
            transparent: true,
            gifPalette: 'global',
            gifDither: true,
            gifLoop: 0,
            videoQuality: 'high'
          }
        ]
      }),
      { export: bridge }
    )
    expect(result.applied).toBe(1)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ index: 0, severity: 'warning' })
    expect(result.issues[0].message).toContain('/tmp/bounce.gif')
    expect(calls).toHaveLength(1)
    expect(calls[0].out).toBe('/tmp/bounce.gif')
    // Sanitized: the frame range is reordered, size/rate/alpha carried over,
    // and the GIF/video keys pass straight through.
    expect(calls[0].options).toMatchObject({
      format: 'gif',
      fromFrame: 2,
      toFrame: 10,
      scale: 2,
      fps: 12,
      transparent: true,
      gifPalette: 'global',
      gifDither: true,
      gifLoop: 0,
      videoQuality: 'high'
    })

    // Bridge failures surface the error text; missing bridges fail cleanly.
    const failed = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'export', format: 'webm' }] }),
      { export: async () => ({ ok: false, error: 'disk is full' }) }
    )
    expect(failed.applied).toBe(0)
    expect(failed.issues[0]).toMatchObject({ index: 0, severity: 'error' })
    expect(failed.issues[0].message).toContain('disk is full')

    const missing = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'export', format: 'webm' }] })
    )
    expect(missing.applied).toBe(0)
    expect(missing.issues[0]).toMatchObject({ index: 0, severity: 'error' })
    expect(missing.issues[0].message).toContain('not available')
  })

  it('importImage and importAudio delegate to their bridges and report ids', async () => {
    const editor = createEditor()
    const imageRequests: ScriptImportImageRequest[] = []
    const imageBridge: ScriptImportImageBridge = async (request) => {
      imageRequests.push(request)
      return { ok: true, nodeId: 'node-7' }
    }
    const audioRequests: ScriptImportAudioRequest[] = []
    const audioBridge: ScriptImportAudioBridge = async (request) => {
      audioRequests.push(request)
      return { ok: true, layerId: 'layer-9' }
    }
    const result = await executeScriptCommands(
      editor,
      validated({
        commands: [
          {
            op: 'importImage',
            frame: 4,
            layerId: 'l1',
            at: { x: 10, y: 20 },
            width: 100,
            height: 50,
            name: 'logo.png'
          },
          { op: 'importImage' },
          { op: 'importAudio', startFrame: 6 }
        ]
      }),
      { importImage: imageBridge, importAudio: audioBridge }
    )
    expect(result.applied).toBe(3)
    expect(result.issues.map((entry) => entry.severity)).toEqual(['warning', 'warning', 'warning'])
    expect(result.issues[0].message).toContain('node-7')
    expect(result.issues[2].message).toContain('layer-9')
    expect(imageRequests).toEqual([
      { frame: 4, layerId: 'l1', at: { x: 10, y: 20 }, width: 100, height: 50, name: 'logo.png' },
      {}
    ])
    expect(audioRequests).toEqual([{ startFrame: 6 }])

    // Bridge errors surface their text; missing bridges fail cleanly.
    const failed = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'importImage' }] }),
      { importImage: async () => ({ ok: false, error: 'no image picked' }) }
    )
    expect(failed.applied).toBe(0)
    expect(failed.issues[0]).toMatchObject({ index: 0, severity: 'error' })
    expect(failed.issues[0].message).toContain('no image picked')

    const missing = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'importImage' }, { op: 'importAudio' }] })
    )
    expect(missing.applied).toBe(0)
    expect(missing.issues).toHaveLength(2)
    expect(missing.issues.every((entry) => entry.severity === 'error')).toBe(true)
    expect(missing.issues[0].message).toContain('not available')
    expect(missing.issues[1].message).toContain('not available')
  })

  it('setOnionSkin and setBrush drive the session display options', async () => {
    const editor = createEditor()
    const result = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'setOnionSkin', enabled: true, before: 3, after: 1 },
          { op: 'setBrush', color: '#ff8800', size: 24, opacity: 0.4 }
        ]
      })
    )
    expect(result.issues).toEqual([])
    expect(result.applied).toBe(2)
    expect(editor.onionSkin).toBe(true)
    expect(editor.onionBefore).toBe(3)
    expect(editor.onionAfter).toBe(1)
    expect(editor.brushColor).toBe('#ff8800')
    expect(editor.brushSize).toBe(24)
    expect(editor.brushOpacity).toBe(0.4)

    // `enabled: false` toggles back off when onion skinning is on.
    const off = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'setOnionSkin', enabled: false }] })
    )
    expect(off.issues).toEqual([])
    expect(off.applied).toBe(1)
    expect(editor.onionSkin).toBe(false)
  })

  it('setGlobalPalette and addGlobalPaletteColor go through the palette bridge', async () => {
    const editor = createEditor()
    let colors: string[] = []
    const set = vi.fn(async (next: string[]) => {
      colors = next
    })
    const get = vi.fn(async () => [...colors])
    const bridge: ScriptGlobalPaletteBridge = { get, set }

    const replaced = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'setGlobalPalette', colors: ['#111111', '#222222'] }] }),
      { globalPalette: bridge }
    )
    expect(replaced.issues).toEqual([])
    expect(replaced.applied).toBe(1)
    expect(colors).toEqual(['#111111', '#222222'])

    // Appending normalizes the color to lowercase #rrggbb.
    const appended = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'addGlobalPaletteColor', color: '#AABBCC' }] }),
      { globalPalette: bridge }
    )
    expect(appended.issues).toEqual([])
    expect(appended.applied).toBe(1)
    expect(colors).toEqual(['#111111', '#222222', '#aabbcc'])

    // Duplicates are rejected case-insensitively, without writing.
    const duplicate = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'addGlobalPaletteColor', color: '#aabbcc' }] }),
      { globalPalette: bridge }
    )
    expect(duplicate.applied).toBe(0)
    expect(duplicate.issues[0]).toMatchObject({ index: 0, severity: 'warning' })
    expect(duplicate.issues[0].message).toContain('already')
    expect(set).toHaveBeenCalledTimes(2)

    // The 48-color cap rejects without writing.
    colors = Array.from({ length: 48 }, (_, index) => `#${index.toString(16).padStart(6, '0')}`)
    const full = await executeScriptCommands(
      editor,
      validated({ commands: [{ op: 'addGlobalPaletteColor', color: '#ffffff' }] }),
      { globalPalette: bridge }
    )
    expect(full.applied).toBe(0)
    expect(full.issues[0]).toMatchObject({ index: 0, severity: 'error' })
    expect(full.issues[0].message).toContain('full')
    expect(set).toHaveBeenCalledTimes(2)

    // Without a bridge both palette commands fail cleanly.
    const missing = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'setGlobalPalette', colors: ['#ffffff'] },
          { op: 'addGlobalPaletteColor', color: '#ffffff' }
        ]
      })
    )
    expect(missing.applied).toBe(0)
    expect(missing.issues).toHaveLength(2)
    expect(missing.issues.every((entry) => entry.severity === 'error')).toBe(true)
    expect(missing.issues[0].message).toContain('not available')
  })
})
