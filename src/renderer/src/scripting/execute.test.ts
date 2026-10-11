// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { isObjectLayer } from '@shared/model'
import { createStarterDocument } from '@shared/starterDocument'
import { SCRIPT_EXAMPLES } from '@shared/scripting/examples'
import { validateScriptPayload } from '@shared/scripting/commands'

import { Editor } from '../editor'
import { executeScriptCommands } from './execute'

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

describe('executeScriptCommands', () => {
  it('applies the bouncing ball example end to end', () => {
    const editor = createEditor()
    const commands = validated({ commands: SCRIPT_EXAMPLES[0].commands })
    const result = executeScriptCommands(editor, commands)
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

  it('applies the title card fade-in example with refreshed text metrics', () => {
    const editor = createEditor()
    const commands = validated({ commands: SCRIPT_EXAMPLES[1].commands })
    const result = executeScriptCommands(editor, commands)
    expect(result.issues).toEqual([])
    expect(result.applied).toBe(commands.length)

    const layer = editor.document.layers.find((entry) => entry.name === 'Title')
    if (!layer || !isObjectLayer(layer)) throw new Error('expected the Title object layer')
    const start = layer.keyframes[0].nodes[0]
    expect(start).toMatchObject({ type: 'text', text: 'OPENANIMATOR', opacity: 0 })
    const end = layer.keyframes[1].nodes[0]
    expect(end).toMatchObject({ opacity: 1 })
  })

  it('reports per-command issues without aborting the rest of the script', () => {
    const editor = createEditor()
    const commands = validated({
      commands: [
        { op: 'updateNode', nodeId: 'ghost', patch: { opacity: 0.5 } },
        { op: 'addLayer', name: 'Scratch' },
        { op: 'removeLayer', layerId: 'missing-layer' }
      ]
    })
    const result = executeScriptCommands(editor, commands)
    expect(result.applied).toBe(1)
    expect(result.issues).toHaveLength(2)
    expect(result.issues[0]).toMatchObject({ index: 0, severity: 'error' })
    expect(result.issues[1]).toMatchObject({ index: 2, severity: 'error' })
    expect(editor.document.layers.some((layer) => layer.name === 'Scratch')).toBe(true)
  })

  it('warns instead of failing on clamped seeks and idempotent durations', () => {
    const editor = createEditor()
    const commands = validated({
      commands: [
        { op: 'seek', frame: 999 },
        { op: 'setDuration', frames: 25 }
      ]
    })
    const result = executeScriptCommands(editor, commands)
    expect(result.issues).toHaveLength(2)
    expect(result.issues.every((issue) => issue.severity === 'warning')).toBe(true)
    expect(editor.currentFrame).toBe(editor.duration - 1)
  })

  it('rejects setCell on object layers and setTween on frames without a keyframe', () => {
    const editor = createEditor()
    const commands = validated({
      commands: [
        { op: 'setCell', resourceId: 'res-1', frame: 0 },
        { op: 'setTween', frame: 5 }
      ]
    })
    const result = executeScriptCommands(editor, commands)
    expect(result.applied).toBe(0)
    expect(result.issues).toHaveLength(2)
  })

  it('commits each command as exactly one undo entry', () => {
    const editor = createEditor()
    const commands = validated({ commands: SCRIPT_EXAMPLES[0].commands })
    executeScriptCommands(editor, commands)
    expect(editor.duration).toBe(24)

    editor.undo()
    // The last command was setDuration: the animation content stays.
    expect(editor.duration).toBe(25)
    expect(editor.document.layers.some((layer) => layer.name === 'Ball')).toBe(true)

    // Undoing the whole script eventually restores the starter document.
    for (let index = 1; index < commands.length; index += 1) editor.undo()
    expect(editor.document.layers.some((layer) => layer.name === 'Ball')).toBe(false)
  })

  it('deletes nodes and keys poses through the same pipeline as gestures', () => {
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
    const result = executeScriptCommands(editor, commands)
    expect(result.issues).toEqual([])
    expect(result.applied).toBe(4)
    const layer = ballLayer(editor)
    expect(layer.keyframes.every((keyframe) => !keyframe.nodes.some((node) => node.id === 'ball'))).toBe(true)
  })
})
