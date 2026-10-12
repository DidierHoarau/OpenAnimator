// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { cloneDocument } from '@shared/document'
import { createStarterDocument } from '@shared/starterDocument'
import { validateScriptPayload } from '@shared/scripting/commands'

import { Editor } from '../editor'
import { executeScriptCommands } from './execute'
import { getScriptRecorder, notifyGlobalPaletteSet } from './scriptRecorder'

const AUDIO_RESOURCE = 'a1b2c3d4'.repeat(8)
const AUDIO_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
const CELL_RESOURCE = 'ce11ce11'.repeat(8)
const CELL_BYTES = new Uint8Array([1, 2, 3])

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

describe('ScriptRecorder', () => {
  it('round-trips a full gesture session through validate + execute (one pipeline)', async () => {
    const editor = createEditor()
    const recorder = getScriptRecorder(editor)
    const base = cloneDocument(editor.document)
    recorder.start()

    // Gesture 1 — a script block through the same executor the console uses.
    const scripted = await executeScriptCommands(
      editor,
      validated({
        commands: [
          { op: 'addLayer', kind: 'object', name: 'Ball2' },
          {
            op: 'addNode',
            frame: 0,
            node: {
              type: 'primitive',
              id: 'ball2',
              primitive: 'ellipse',
              name: 'Ball 2',
              center: { x: 100, y: 100 },
              width: 100,
              height: 100,
              rotation: 0,
              fill: '#ff5252',
              opacity: 1
            }
          },
          { op: 'updateNode', nodeId: 'ball2', frame: 0, patch: { opacity: 0.5 } },
          { op: 'setKeyframe', nodeId: 'ball2', frame: 10, patch: { center: { x: 700, y: 400 } } },
          { op: 'setDuration', frames: 36 }
        ]
      })
    )
    expect(scripted.issues).toEqual([])

    // Gesture 2 — insert a frame at the playhead, then remove it again.
    editor.seekToFrame(3)
    editor.insertFrameHere()
    editor.seekToFrame(3)
    editor.removeFrameHere()

    // Gesture 4 — a drag (one coalesced interaction) keyframes the node at 6.
    editor.seekToFrame(6)
    editor.selectNodes(['ball2'], 'replace')
    editor.beginInteraction('Move nodes')
    editor.updateSelectedNode((node) => {
      node.center.x += 40
      node.center.y -= 20
    })
    editor.endInteraction()

    // Gesture 5 — tween stack on the new keyframe.
    editor.toggleTweenHere()
    editor.setTweenEasingHere('ease-out')
    editor.setTweenPathHere('smooth')
    editor.setTweenChannelEasingHere('opacity', 'ease-in')

    // Gesture 6 — move the keyframe; its tween is dropped with the emptied one.
    editor.moveNodeKeyframeEntry('ball2', 6, 8)

    // Gesture 7 — document scalars.
    editor.setFps(30)
    editor.setPalette(['#112233'])
    editor.setHoldStep(2)

    // Gesture 8 — a rename that is undone before the next flush: nothing records.
    const background = editor.document.layers.find((layer) => layer.name === 'Background')
    if (!background) throw new Error('expected the Background layer')
    editor.renameLayer(background.id, 'Temp')
    editor.undo()

    // Gesture 9 — camera layer with a keyed, tweened pose.
    const camera = editor.addCameraLayer()
    if (!camera) throw new Error('expected the camera layer')
    editor.seekToFrame(10)
    expect(editor.ensureCameraKeyframe()).toBe(true)
    editor.setCameraPoseHere({ center: { x: 600, y: 270 }, zoom: 2 })
    editor.toggleCameraTweenHere()

    // Gesture 10 — drawing layer: one cell, then retimed.
    editor.addLayerAtBottom('drawing')
    expect(editor.commitStroke(CELL_RESOURCE, 0)).toBe(true)
    expect(editor.moveCellToFrame(0, 3)).toBe(true)

    // Gesture 11 — audio layer: add, volume, mute.
    editor.resources.put(AUDIO_RESOURCE, AUDIO_BYTES)
    const audio = editor.addAudioLayer(AUDIO_RESOURCE, 'Score', 4)
    if (!audio) throw new Error('expected the audio layer')
    editor.setAudioLayerVolume(audio.id, 0.5)
    editor.toggleAudioMute(audio.id)

    recorder.stop()
    const recorded = recorder.take()
    expect(recorder.steps).toBe(0)

    // The capture is exact: no unsupported notes, and the payload survives a
    // JSON round-trip (it is what the console inserts into the textarea).
    expect(recorded.unsupported).toEqual([])
    expect(recorded.commands.map((command) => command.op)).toEqual([
      'addLayer',
      'addNode',
      'updateNode',
      'setKeyframe',
      'setDuration',
      'insertFrames',
      'removeFrames',
      'setKeyframe',
      'setTween',
      'setTween',
      'setTween',
      'setTween',
      'moveKeyframe',
      'setFps',
      'setPalette',
      'setHoldStep',
      'addLayer',
      'setCameraKeyframe',
      'setCameraKeyframe',
      'setTween',
      'addLayer',
      'setCell',
      'moveCell',
      'addLayer',
      'setAudio',
      'setAudio'
    ])

    const layers = editor.document.layers
    const ballLayer = layers.find((layer) => layer.name === 'Ball2')
    const drawingLayer = layers.find((layer) => layer.kind === 'drawing')
    const audioLayer = layers.find((layer) => layer.kind === 'audio')
    if (!ballLayer || !drawingLayer || !audioLayer) throw new Error('expected the added layers')

    // The frame context and the real ids are baked into the payload.
    expect(recorded.commands[5]).toEqual({
      op: 'insertFrames',
      layerId: ballLayer.id,
      frame: 3,
      count: 1
    })
    expect(recorded.commands[6]).toEqual({
      op: 'removeFrames',
      layerId: ballLayer.id,
      frame: 3,
      count: 1
    })
    expect(recorded.commands[12]).toEqual({
      op: 'moveKeyframe',
      nodeId: 'ball2',
      layerId: ballLayer.id,
      fromFrame: 6,
      toFrame: 8
    })
    expect(recorded.commands[16]).toEqual({
      op: 'addLayer',
      kind: 'camera',
      name: 'Camera',
      layerId: camera.id
    })
    expect(recorded.commands[25]).toEqual({ op: 'setAudio', layerId: audioLayer.id, muted: true })
    // The undone rename never makes it into the capture.
    expect(recorded.commands.some((command) => command.op === 'renameLayer')).toBe(false)

    // Replay through the normal console pipeline on a fresh editor seeded
    // with the same base document.
    const payload = JSON.parse(JSON.stringify({ commands: recorded.commands })) as unknown
    const { commands: parsed, errors } = validateScriptPayload(payload)
    expect(errors).toEqual([])
    expect(parsed.length).toBe(recorded.commands.length)

    const replay = new Editor(cloneDocument(base), {
      measureText: (line: string) => line.length * 10
    })
    replay.resources.put(AUDIO_RESOURCE, AUDIO_BYTES)
    replay.resources.put(CELL_RESOURCE, CELL_BYTES)
    const result = await executeScriptCommands(replay, parsed)
    expect(result.issues).toEqual([])
    expect(result.applied).toBe(parsed.length)
    expect(replay.document).toEqual(editor.document)
  })

  it('records global-palette sets through the bridge, deduped and only while recording', () => {
    const editor = createEditor()
    const recorder = getScriptRecorder(editor)
    recorder.start()

    notifyGlobalPaletteSet(['#112233', '#445566'])
    expect(recorder.steps).toBe(1)
    notifyGlobalPaletteSet(['#112233', '#445566'])
    expect(recorder.steps).toBe(1)
    notifyGlobalPaletteSet(['#000000'])
    expect(recorder.steps).toBe(2)

    recorder.stop()
    notifyGlobalPaletteSet(['#abcdef'])
    expect(recorder.steps).toBe(2)

    expect(recorder.take().commands).toEqual([
      { op: 'setGlobalPalette', colors: ['#112233', '#445566'] },
      { op: 'setGlobalPalette', colors: ['#000000'] }
    ])
    expect(recorder.steps).toBe(0)
  })

  it('hands out one recorder per editor and clears the capture on start', () => {
    const editor = createEditor()
    const recorder = getScriptRecorder(editor)
    expect(getScriptRecorder(editor)).toBe(recorder)
    expect(getScriptRecorder(createEditor())).not.toBe(recorder)

    const changes = vi.fn()
    const unsubscribe = recorder.onChange(changes)
    recorder.start()
    editor.setFps(48)
    expect(changes).toHaveBeenCalled()
    // The gesture in flight flushes on stop.
    expect(recorder.steps).toBe(0)
    recorder.stop()
    expect(recorder.steps).toBe(1)

    recorder.start()
    expect(recorder.steps).toBe(0)
    recorder.stop()
    unsubscribe()
    expect(changes).toHaveBeenCalled()
  })
})
