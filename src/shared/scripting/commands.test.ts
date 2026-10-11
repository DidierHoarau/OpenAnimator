import { describe, expect, it } from 'vitest'
import Ajv from 'ajv'

import { createStarterDocument } from '../starterDocument'
import { COMMANDS_SCHEMA, validateDocumentPayload, validateScriptPayload } from './commands'
import { SCRIPT_EXAMPLES } from './examples'

describe('validateScriptPayload', () => {
  it('accepts a payload with relaxed node fields and returns the commands', () => {
    const payload = {
      commands: [
        { op: 'addLayer', kind: 'object', name: 'Ball' },
        {
          op: 'addNode',
          frame: 0,
          node: { type: 'primitive', primitive: 'ellipse', fill: '#ff5252' }
        },
        { op: 'updateNode', nodeId: 'ball', frame: 5, patch: { opacity: 0.5 } },
        { op: 'seek', frame: 0 }
      ]
    }
    const { commands, errors } = validateScriptPayload(payload)
    expect(errors).toEqual([])
    expect(commands).toHaveLength(4)
    expect(commands[0]).toMatchObject({ op: 'addLayer', name: 'Ball' })
  })

  it('rejects an unknown op with an ajv pointer', () => {
    const { commands, errors } = validateScriptPayload({ commands: [{ op: 'bogusOp' }] })
    expect(commands).toEqual([])
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toContain('/commands/0')
  })

  it('rejects commands missing their required fields', () => {
    const { errors } = validateScriptPayload({
      commands: [{ op: 'addNode' }, { op: 'updateNode', nodeId: 'x' }, { op: 'setDuration' }]
    })
    expect(errors.join('\n')).toContain('/commands/0')
    expect(errors.join('\n')).toContain('patch')
    expect(errors.join('\n')).toContain('frames')
  })

  it('rejects unknown patch fields and invalid frame numbers', () => {
    const { errors } = validateScriptPayload({
      commands: [
        { op: 'updateNode', nodeId: 'x', patch: { notAField: 1 } },
        { op: 'seek', frame: -1 }
      ]
    })
    expect(errors.join('\n')).toContain('/commands/0/patch')
    expect(errors.join('\n')).toContain('additional properties')
    expect(errors.join('\n')).toContain('/commands/1')
  })

  it('rejects a non-object or empty payload', () => {
    expect(validateScriptPayload(null).errors.length).toBeGreaterThan(0)
    expect(validateScriptPayload({ commands: [] }).errors.length).toBeGreaterThan(0)
    expect(validateScriptPayload({ commands: 'nope' }).errors.length).toBeGreaterThan(0)
  })

  it('restricts setTween easing to the named easings or null', () => {
    const ok = validateScriptPayload({ commands: [{ op: 'setTween', easing: 'ease-in-out' }] })
    expect(ok.errors).toEqual([])
    const clear = validateScriptPayload({ commands: [{ op: 'setTween', easing: null }] })
    expect(clear.errors).toEqual([])
    const bad = validateScriptPayload({ commands: [{ op: 'setTween', easing: 'wobbly' }] })
    expect(bad.errors.length).toBeGreaterThan(0)
  })
})

describe('validateDocumentPayload', () => {
  it('accepts the starter document', () => {
    const { valid, errors } = validateDocumentPayload(createStarterDocument())
    expect(errors).toEqual([])
    expect(valid).toBe(true)
  })

  it('rejects documents with a wrong schemaVersion or an incomplete node', () => {
    const document = createStarterDocument()
    const { valid, errors } = validateDocumentPayload({ ...document, schemaVersion: 2 })
    expect(valid).toBe(false)
    expect(errors.join('\n')).toContain('schemaVersion')

    const layer = document.layers[0]
    if (layer.kind !== 'object') throw new Error('expected an object layer')
    const broken = {
      ...document,
      layers: [
        { ...layer, keyframes: [{ frame: 0, nodes: [{ type: 'primitive', primitive: 'rect' }] }] }
      ]
    }
    const missingFill = validateDocumentPayload(broken)
    expect(missingFill.valid).toBe(false)
    expect(missingFill.errors.join('\n')).toContain('fill')
  })

  it('is exposed together with the commands schema for tooling', () => {
    expect(COMMANDS_SCHEMA.properties?.commands?.type).toBe('array')
  })
})

describe('SCRIPT_EXAMPLES', () => {
  it('every example validates against the command schema', () => {
    for (const example of SCRIPT_EXAMPLES) {
      const { errors } = validateScriptPayload({ commands: example.commands })
      expect(errors, example.name).toEqual([])
    }
  })
})

describe('hand-rolled validator vs JSON Schema', () => {
  // The renderer validates with the CSP-safe hand-rolled validator; this
  // corpus keeps it in sync with the exported COMMANDS_SCHEMA (ajv runs only
  // in Node, never under the renderer CSP).
  const ajvValidate = new Ajv({ allErrors: true }).compile(COMMANDS_SCHEMA)

  const corpus: unknown[] = [
    { commands: SCRIPT_EXAMPLES[0].commands },
    { commands: SCRIPT_EXAMPLES[1].commands },
    { commands: [] },
    { commands: 'nope' },
    { commands: [{ op: 'addLayer', kind: 'drawing', name: 'Sketch' }] },
    { commands: [{ op: 'addLayer', kind: 'vector' }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { fontSize: 0 } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { fontWeight: 1001 } }] },
    {
      commands: [
        {
          op: 'addNode',
          node: {
            type: 'text',
            text: 'Hi',
            fontFamily: 'Noto Sans',
            fontSize: 24,
            fontWeight: 400,
            fill: '#fff',
            align: 'center'
          }
        }
      ]
    },
    { commands: [{ op: 'addNode', node: { type: 'text', text: 'Hi' } }] },
    { commands: [{ op: 'addNode', node: { type: 'alien' } }] },
    { commands: [{ op: 'addNode', node: { type: 'group', children: [{ type: 'rect' }] } }] },
    { commands: [{ op: 'setTween', easing: 'wobbly' }] },
    { commands: [{ op: 'setTween', easing: null }] },
    { commands: [{ op: 'setFps', fps: 0 }] },
    { commands: [{ op: 'setDuration', frames: 1.5 }] },
    { commands: [{ op: 'seek', frame: -1 }] },
    { commands: [{ op: 'deleteNode', nodeId: 'x', surprise: 1 }] },
    { commands: [{ op: 'setKeyframe', nodeId: 'x', patch: { opacity: 2 } }] }
  ]

  it('agrees with the compiled schema on every corpus entry', () => {
    for (const payload of corpus) {
      const handRolled = validateScriptPayload(payload).errors.length === 0
      const ajv = ajvValidate(payload) as boolean
      expect(handRolled, `${JSON.stringify(payload)}: hand-rolled=${handRolled} ajv=${ajv}`).toBe(ajv)
    }
  })
})
