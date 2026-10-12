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

  it('restricts setTween easing to named easings, bezier objects or null', () => {
    const ok = validateScriptPayload({ commands: [{ op: 'setTween', easing: 'ease-in-out' }] })
    expect(ok.errors).toEqual([])
    const clear = validateScriptPayload({ commands: [{ op: 'setTween', easing: null }] })
    expect(clear.errors).toEqual([])
    const bezier = validateScriptPayload({
      commands: [{ op: 'setTween', easing: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } }]
    })
    expect(bezier.errors).toEqual([])
    const bad = validateScriptPayload({ commands: [{ op: 'setTween', easing: 'wobbly' }] })
    expect(bad.errors.length).toBeGreaterThan(0)
    const badBezier = validateScriptPayload({
      commands: [{ op: 'setTween', easing: { x1: 2, y1: 0, x2: 0.5, y2: 1 } }]
    })
    expect(badBezier.errors.join('\n')).toContain('/x1')
  })

  it('restricts setTween channel easings to the channel keys and easing values', () => {
    const ok = validateScriptPayload({
      commands: [
        {
          op: 'setTween',
          easings: { transform: 'ease-in', opacity: null, fill: { x1: 0.1, y1: 0, x2: 0.9, y2: 1 } }
        }
      ]
    })
    expect(ok.errors).toEqual([])

    const unknownChannel = validateScriptPayload({
      commands: [{ op: 'setTween', easings: { rotation: 'ease-in' } }]
    })
    expect(unknownChannel.errors.join('\n')).toContain('/commands/0/easings/rotation')

    const badEasing = validateScriptPayload({
      commands: [{ op: 'setTween', easings: { opacity: 'wobbly' } }]
    })
    expect(badEasing.errors.join('\n')).toContain('/commands/0/easings/opacity')

    const badShape = validateScriptPayload({
      commands: [{ op: 'setTween', easings: 'ease-in' }]
    })
    expect(badShape.errors.join('\n')).toContain('/commands/0/easings')
  })

  it('accepts the new keyframe-move and hold-step ops and rejects their bad shapes', () => {
    const ok = validateScriptPayload({
      commands: [
        { op: 'moveKeyframe', nodeId: 'ball', fromFrame: 0, toFrame: 12 },
        { op: 'copyKeyframes', nodeId: 'ball', fromFrame: 0, toFrame: 12, targetFrame: 30 },
        { op: 'setHoldStep', step: 3 },
        { op: 'setTween', path: 'smooth' }
      ]
    })
    expect(ok.errors).toEqual([])
    const bad = validateScriptPayload({
      commands: [
        { op: 'moveKeyframe', nodeId: 'ball', fromFrame: -1 },
        { op: 'copyKeyframes', nodeId: 'ball', targetFrame: 1.5 },
        { op: 'setHoldStep', step: 17 },
        { op: 'setTween', path: 'wavy' }
      ]
    })
    expect(bad.errors.join('\n')).toContain('/commands/0')
    expect(bad.errors.join('\n')).toContain('/commands/1')
    expect(bad.errors.join('\n')).toContain('/commands/2/step')
    expect(bad.errors.join('\n')).toContain('/commands/3/path')
  })

  it('accepts typography patch fields and rejects their bad shapes', () => {
    const ok = validateScriptPayload({
      commands: [
        {
          op: 'updateNode',
          nodeId: 'title',
          patch: {
            letterSpacing: 2,
            lineHeight: 1.5,
            verticalAlign: 'middle',
            fontFallback: ['Lato', 'Inter'],
            fontStyle: 'italic',
            ligatures: false,
            stroke: '#000000',
            strokeWidth: 3
          }
        },
        {
          op: 'addNode',
          frame: 0,
          node: { type: 'text', text: 'Hi', fontFamily: 'Noto Sans', fontSize: 24, fontWeight: 400, fill: '#fff', align: 'left', lineHeight: 1.2, verticalAlign: 'bottom', fontFallback: [], fontStyle: 'normal', ligatures: true }
        }
      ]
    })
    expect(ok.errors).toEqual([])
    const bad = validateScriptPayload({
      commands: [
        { op: 'updateNode', nodeId: 'title', patch: { lineHeight: 0.2 } },
        { op: 'updateNode', nodeId: 'title', patch: { verticalAlign: 'center' } },
        { op: 'updateNode', nodeId: 'title', patch: { fontFallback: [1, 2] } },
        { op: 'updateNode', nodeId: 'title', patch: { letterSpacing: 'wide' } },
        { op: 'updateNode', nodeId: 'title', patch: { fontStyle: 'oblique' } },
        { op: 'updateNode', nodeId: 'title', patch: { ligatures: 'off' } }
      ]
    })
    expect(bad.errors.join('\n')).toContain('/commands/0/patch/lineHeight')
    expect(bad.errors.join('\n')).toContain('/commands/1/patch/verticalAlign')
    expect(bad.errors.join('\n')).toContain('/commands/2/patch/fontFallback/0')
    expect(bad.errors.join('\n')).toContain('/commands/3/patch/letterSpacing')
    expect(bad.errors.join('\n')).toContain('/commands/4/patch/fontStyle')
    expect(bad.errors.join('\n')).toContain('/commands/5/patch/ligatures')
  })

  it('accepts stroke-style fields and rejects their bad shapes', () => {
    const ok = validateScriptPayload({
      commands: [
        {
          op: 'updateNode',
          nodeId: 'x',
          patch: {
            strokeLinecap: 'round',
            strokeLinejoin: 'bevel',
            strokeDasharray: [6, 4],
            strokeDashoffset: 2
          }
        },
        {
          op: 'addNode',
          frame: 0,
          node: {
            type: 'path',
            d: 'M0 0L10 10',
            stroke: '#000000',
            strokeLinecap: 'square',
            strokeDasharray: [2]
          }
        }
      ]
    })
    expect(ok.errors).toEqual([])
    const bad = validateScriptPayload({
      commands: [
        { op: 'updateNode', nodeId: 'x', patch: { strokeLinecap: 'fancy' } },
        { op: 'updateNode', nodeId: 'x', patch: { strokeLinejoin: 'pointy' } },
        { op: 'updateNode', nodeId: 'x', patch: { strokeDasharray: [] } },
        { op: 'updateNode', nodeId: 'x', patch: { strokeDasharray: [0, 0] } },
        { op: 'updateNode', nodeId: 'x', patch: { strokeDasharray: [6, -1] } },
        { op: 'updateNode', nodeId: 'x', patch: { strokeDasharray: ['6'] } },
        {
          op: 'updateNode',
          nodeId: 'x',
          patch: { strokeDasharray: Array.from({ length: 17 }, () => 4) }
        },
        { op: 'updateNode', nodeId: 'x', patch: { strokeDashoffset: 'x' } },
        { op: 'addNode', frame: 0, node: { type: 'path', d: 'M0 0L1 1', strokeDasharray: [0] } }
      ]
    })
    const joined = bad.errors.join('\n')
    expect(joined).toContain('/commands/0/patch/strokeLinecap')
    expect(joined).toContain('/commands/1/patch/strokeLinejoin')
    expect(joined).toContain('/commands/2/patch/strokeDasharray: must have at least 1 item')
    expect(joined).toContain('/commands/3/patch/strokeDasharray: must not be all zeros')
    expect(joined).toContain('/commands/4/patch/strokeDasharray/1')
    expect(joined).toContain('/commands/5/patch/strokeDasharray/0')
    expect(joined).toContain('/commands/6/patch/strokeDasharray: must have at most 16 items')
    expect(joined).toContain('/commands/7/patch/strokeDashoffset')
    expect(joined).toContain('/commands/8')
  })

  it('accepts the UX ops and rejects bad modes, axes and preference patches', () => {
    const ok = validateScriptPayload({
      commands: [
        { op: 'duplicateNodes' },
        { op: 'align', mode: 'centerH' },
        { op: 'distribute', axis: 'v' },
        { op: 'setPreferences', preferences: { gridSize: 32, showDemoOnNew: false } }
      ]
    })
    expect(ok.errors).toEqual([])
    expect(ok.commands).toHaveLength(4)

    const bad = validateScriptPayload({
      commands: [
        { op: 'align', mode: 'diagonal' },
        { op: 'distribute', axis: 'x' },
        { op: 'align' },
        { op: 'setPreferences', preferences: { gridSize: 'big' } },
        { op: 'setPreferences', preferences: { notAKey: 1 } },
        { op: 'setPreferences', preferences: [1] },
        { op: 'duplicateNodes', mode: 'left' }
      ]
    })
    const errors = bad.errors.join('\n')
    expect(errors).toContain('/commands/0/mode')
    expect(errors).toContain('/commands/1/axis')
    expect(errors).toContain('/commands/2/mode')
    expect(errors).toContain('/commands/3/preferences/gridSize')
    expect(errors).toContain('/commands/4/preferences/notAKey')
    expect(errors).toContain('/commands/5/preferences')
    expect(errors).toContain('/commands/6/mode')
  })

  it('accepts the camera and audio ops and rejects their bad shapes', () => {
    const ok = validateScriptPayload({
      commands: [
        { op: 'addLayer', kind: 'camera', name: 'Camera' },
        { op: 'addLayer', kind: 'audio', name: 'Sound', resourceId: 'a'.repeat(64), startFrame: 0 },
        { op: 'setCameraKeyframe', frame: 12, center: { x: 10, y: 20 }, zoom: 2, rotation: 30, tween: true },
        { op: 'removeCameraKeyframe', frame: 12 },
        { op: 'setAudio', layerId: 'l1', startFrame: 6, volume: 0.5, muted: false }
      ]
    })
    expect(ok.errors).toEqual([])
    expect(ok.commands).toHaveLength(5)
    expect(ok.commands[0]).toMatchObject({ op: 'addLayer', kind: 'camera' })

    // resourceId is required when the added layer is an audio layer.
    const missingResource = validateScriptPayload({
      commands: [{ op: 'addLayer', kind: 'audio', name: 'Sound' }]
    })
    expect(missingResource.errors.join('\n')).toContain('/commands/0/resourceId')

    const bad = validateScriptPayload({
      commands: [
        { op: 'addLayer', kind: 'holo' },
        { op: 'addLayer', kind: 'audio', resourceId: 'r', startFrame: -2 },
        { op: 'setCameraKeyframe', frame: -1 },
        { op: 'setCameraKeyframe', frame: 0, zoom: 0 },
        { op: 'setCameraKeyframe', frame: 0.5 },
        { op: 'setCameraKeyframe', frame: 0, extra: 1 },
        { op: 'removeCameraKeyframe' },
        { op: 'setAudio', volume: 0.5 },
        { op: 'setAudio', layerId: 'l1', volume: 2 },
        { op: 'setAudio', layerId: 'l1', muted: 'yes' },
        { op: 'setAudio', layerId: 'l1', surprise: true }
      ]
    })
    const joined = bad.errors.join('\n')
    expect(joined).toContain('/commands/0/kind')
    expect(joined).toContain('/commands/1/startFrame')
    expect(joined).toContain('/commands/2/frame')
    expect(joined).toContain('/commands/3/zoom')
    expect(joined).toContain('/commands/4/frame')
    expect(joined).toContain('/commands/5/extra')
    expect(joined).toContain('/commands/6/frame')
    expect(joined).toContain('/commands/7/layerId')
    expect(joined).toContain('/commands/8/volume')
    expect(joined).toContain('/commands/9/muted')
    expect(joined).toContain('/commands/10/surprise')
  })

  it('accepts the group, symbol and library ops and rejects their bad shapes', () => {
    const ok = validateScriptPayload({
      commands: [
        { op: 'group', nodeIds: ['a', 'b'], frame: 0 },
        { op: 'ungroup', nodeIds: ['g'], layerId: 'l1' },
        { op: 'breakApart', nodeId: 's', frame: 2 },
        { op: 'createSymbol', nodeIds: ['a'], name: 'Star' },
        { op: 'placeAsset', assetId: 'asset-1', at: { x: 10, y: 20 } },
        { op: 'editSymbol', assetId: 'asset-1' },
        { op: 'endSymbolEdit', commit: true },
        { op: 'renameAsset', assetId: 'asset-1', name: 'Comet' },
        { op: 'duplicateAsset', assetId: 'asset-1' },
        { op: 'deleteAsset', assetId: 'asset-1' },
        { op: 'saveToLibrary', assetId: 'asset-1' },
        { op: 'insertFromLibrary', name: 'Star', at: { x: 5, y: 5 } },
        { op: 'insertFromLibrary', assetId: 'asset-1' }
      ]
    })
    expect(ok.errors).toEqual([])
    expect(ok.commands).toHaveLength(13)

    const bad = validateScriptPayload({
      commands: [
        { op: 'group', nodeIds: [] },
        { op: 'group', layerId: 'l1' },
        { op: 'breakApart' },
        { op: 'createSymbol', nodeIds: ['a'], extra: 1 },
        { op: 'placeAsset', at: { x: 1, y: 2 } },
        { op: 'placeAsset', assetId: 'a', at: { x: 1 } },
        { op: 'endSymbolEdit' },
        { op: 'endSymbolEdit', commit: 'yes' },
        { op: 'insertFromLibrary', layerId: 'l1' },
        { op: 'renameAsset', assetId: 'a' }
      ]
    })
    const joined = bad.errors.join('\n')
    expect(joined).toContain('/commands/0/nodeIds')
    expect(joined).toContain('/commands/1/nodeIds')
    expect(joined).toContain('/commands/2/nodeId')
    expect(joined).toContain('/commands/3/extra')
    expect(joined).toContain('/commands/4/assetId')
    expect(joined).toContain('/commands/5/at/y')
    expect(joined).toContain('/commands/6/commit')
    expect(joined).toContain('/commands/7/commit')
    expect(joined).toContain('/commands/8/assetId')
    expect(joined).toContain('/commands/9/name')
  })

  it('accepts the timeline-frame ops and rejects their bad shapes', () => {
    const ok = validateScriptPayload({
      commands: [
        { op: 'insertFrames', layerId: 'l1', frame: 3, count: 2 },
        { op: 'removeFrames' },
        { op: 'moveCell', fromFrame: 0, toFrame: 4 },
        { op: 'moveNodeToFrame', nodeId: 'ball', targetFrame: 6 }
      ]
    })
    expect(ok.errors).toEqual([])
    expect(ok.commands).toHaveLength(4)

    const bad = validateScriptPayload({
      commands: [
        { op: 'insertFrames', count: 0 },
        { op: 'insertFrames', count: 1000 },
        { op: 'insertFrames', count: 1.5 },
        { op: 'insertFrames', frame: -1 },
        { op: 'moveCell', fromFrame: 0 },
        { op: 'moveNodeToFrame', targetFrame: 3 },
        { op: 'moveNodeToFrame', nodeId: 'x' }
      ]
    })
    const joined = bad.errors.join('\n')
    expect(joined).toContain('/commands/0/count')
    expect(joined).toContain('/commands/1/count')
    expect(joined).toContain('/commands/2/count')
    expect(joined).toContain('/commands/3/frame')
    expect(joined).toContain('/commands/4/toFrame')
    expect(joined).toContain('/commands/5/nodeId')
    expect(joined).toContain('/commands/6/targetFrame')
  })

  it('accepts the export, import, onion, brush and global-palette ops and rejects bad shapes', () => {
    const ok = validateScriptPayload({
      commands: [
        {
          op: 'export',
          format: 'gif',
          out: '/tmp/bounce.gif',
          fromFrame: 0,
          toFrame: 23,
          scale: 2,
          fps: 12,
          transparent: true,
          gifPalette: 'global',
          gifDither: false,
          gifLoop: 0,
          videoQuality: 'high'
        },
        {
          op: 'importImage',
          frame: 3,
          layerId: 'l1',
          at: { x: 10, y: 20 },
          width: 100,
          height: 50,
          name: 'logo.png'
        },
        { op: 'importImage' },
        { op: 'importAudio', startFrame: 6 },
        { op: 'setOnionSkin', enabled: true, before: 3, after: 1 },
        { op: 'setBrush', color: '#ff8800', size: 12, opacity: 0.5 },
        { op: 'setGlobalPalette', colors: ['#fff', '#123456'] },
        { op: 'addGlobalPaletteColor', color: '#a1b2c3' }
      ]
    })
    expect(ok.errors).toEqual([])
    expect(ok.commands).toHaveLength(8)

    const bad = validateScriptPayload({
      commands: [
        { op: 'export' },
        { op: 'export', format: 'bogus' },
        { op: 'export', format: 'gif', fps: 12.5 },
        { op: 'export', format: 'gif', gifPalette: 'adaptive' },
        { op: 'export', format: 'gif', videoQuality: 'ultra' },
        { op: 'export', format: 'gif', gifLoop: -2 },
        { op: 'export', format: 'gif', extra: 1 },
        { op: 'importImage', width: 0 },
        { op: 'importImage', at: { x: 1 } },
        { op: 'importAudio', startFrame: -1 },
        { op: 'importAudio', surprise: 1 },
        { op: 'setOnionSkin' },
        { op: 'setOnionSkin', before: 6 },
        { op: 'setOnionSkin', enabled: 'yes' },
        { op: 'setBrush' },
        { op: 'setBrush', color: 'red' },
        { op: 'setBrush', size: 0 },
        { op: 'setBrush', opacity: 1.5 },
        { op: 'setGlobalPalette' },
        { op: 'setGlobalPalette', colors: [] },
        { op: 'setGlobalPalette', colors: ['red'] },
        { op: 'addGlobalPaletteColor' },
        { op: 'addGlobalPaletteColor', color: 'red' }
      ]
    })
    const joined = bad.errors.join('\n')
    expect(joined).toContain('/commands/0/format')
    expect(joined).toContain('/commands/1/format')
    expect(joined).toContain('/commands/2/fps')
    expect(joined).toContain('/commands/3/gifPalette')
    expect(joined).toContain('/commands/4/videoQuality')
    expect(joined).toContain('/commands/5/gifLoop')
    expect(joined).toContain('/commands/6/extra')
    expect(joined).toContain('/commands/7/width')
    expect(joined).toContain('/commands/8/at')
    expect(joined).toContain('/commands/9/startFrame')
    expect(joined).toContain('/commands/10/surprise')
    expect(joined).toContain('/commands/11: must set at least one')
    expect(joined).toContain('/commands/12/before')
    expect(joined).toContain('/commands/13/enabled')
    expect(joined).toContain('/commands/14: must set at least one')
    expect(joined).toContain('/commands/15/color')
    expect(joined).toContain('/commands/16/size')
    expect(joined).toContain('/commands/17/opacity')
    expect(joined).toContain('/commands/18/colors')
    expect(joined).toContain('/commands/19/colors')
    expect(joined).toContain('/commands/20/colors/0')
    expect(joined).toContain('/commands/21/color')
    expect(joined).toContain('/commands/22/color')
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
            align: 'left',
            fontStyle: 'italic',
            ligatures: false
          }
        }
      ]
    },
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
            align: 'left',
            fontStyle: 'bold'
          }
        }
      ]
    },
    { commands: [{ op: 'addNode', node: { type: 'alien' } }] },
    { commands: [{ op: 'addNode', node: { type: 'group', children: [{ type: 'rect' }] } }] },
    { commands: [{ op: 'setTween', easing: 'wobbly' }] },
    { commands: [{ op: 'setTween', easing: null }] },
    { commands: [{ op: 'setTween', easing: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } }] },
    { commands: [{ op: 'setTween', easing: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 }, path: 'smooth' }] },
    { commands: [{ op: 'setTween', easing: { x1: 2, y1: 0, x2: 0.58, y2: 1 } }] },
    { commands: [{ op: 'setTween', easing: { x1: 0.42, y1: 0, x2: 0.58 } }] },
    { commands: [{ op: 'setTween', easing: { x1: 0.42, y1: 0, x2: 0.58, y2: 1, extra: 0 } }] },
    { commands: [{ op: 'setTween', easing: { x1: 'a', y1: 0, x2: 0.58, y2: 1 } }] },
    { commands: [{ op: 'setTween', easing: ['ease'] }] },
    {
      commands: [
        {
          op: 'setTween',
          easings: { transform: 'ease-in', opacity: null, fill: { x1: 0.1, y1: 0, x2: 0.9, y2: 1 } }
        }
      ]
    },
    { commands: [{ op: 'setTween', easings: {} }] },
    { commands: [{ op: 'setTween', easings: { rotation: 'ease-in' } }] },
    { commands: [{ op: 'setTween', easings: { transform: 'wobbly' } }] },
    { commands: [{ op: 'setTween', easings: { transform: { x1: 2, y1: 0, x2: 0.5, y2: 1 } } }] },
    { commands: [{ op: 'setTween', easings: { transform: { x1: 0.1, y1: 0, x2: 0.9 } } }] },
    { commands: [{ op: 'setTween', easings: 'ease-in' }] },
    { commands: [{ op: 'setTween', easings: { transform: ['ease'] } }] },
    { commands: [{ op: 'setTween', easings: { transform: null, extra: null } }] },
    { commands: [{ op: 'setTween', path: 'smooth' }] },
    { commands: [{ op: 'setTween', path: 'wavy' }] },
    { commands: [{ op: 'moveKeyframe', nodeId: 'x', fromFrame: 0, toFrame: 10 }] },
    { commands: [{ op: 'moveKeyframe', nodeId: 'x', fromFrame: 0 }] },
    { commands: [{ op: 'moveKeyframe', nodeId: 'x', fromFrame: -1, toFrame: 10 }] },
    { commands: [{ op: 'moveKeyframe', nodeId: 'x', fromFrame: 0, toFrame: 10, tween: true }] },
    { commands: [{ op: 'copyKeyframes', nodeId: 'x', fromFrame: 0, toFrame: 5, targetFrame: 20 }] },
    { commands: [{ op: 'copyKeyframes', nodeId: 'x', fromFrame: 0, targetFrame: 20 }] },
    { commands: [{ op: 'copyKeyframes', nodeId: 'x', fromFrame: 2.5, targetFrame: 20 }] },
    { commands: [{ op: 'setHoldStep', step: 4 }] },
    { commands: [{ op: 'setHoldStep', step: 0 }] },
    { commands: [{ op: 'setHoldStep', step: 17 }] },
    { commands: [{ op: 'setHoldStep', step: 2.5 }] },
    { commands: [{ op: 'setHoldStep' }] },
    { commands: [{ op: 'setFps', fps: 0 }] },
    { commands: [{ op: 'setDuration', frames: 1.5 }] },
    { commands: [{ op: 'setPalette', colors: ['#fff', '#123456', '#abcdEF'] }] },
    { commands: [{ op: 'setPalette', colors: [] }] },
    { commands: [{ op: 'setPalette' }] },
    { commands: [{ op: 'setPalette', colors: ['red'] }] },
    { commands: [{ op: 'setPalette', colors: ['#fff'], extra: 1 }] },
    { commands: [{ op: 'seek', frame: -1 }] },
    { commands: [{ op: 'deleteNode', nodeId: 'x', surprise: 1 }] },
    { commands: [{ op: 'setKeyframe', nodeId: 'x', patch: { opacity: 2 } }] },
    {
      commands: [
        {
          op: 'addNode',
          node: {
            type: 'primitive',
            primitive: 'rect',
            fill: {
              type: 'linear',
              angle: 90,
              stops: [
                { offset: 0, color: '#f59e0b' },
                { offset: 1, color: '#7c2d12' }
              ]
            }
          }
        }
      ]
    },
    {
      commands: [
        {
          op: 'addNode',
          node: {
            type: 'path',
            d: 'M 0 0 L 10 10',
            stroke: {
              type: 'radial',
              cx: 0.5,
              cy: 0.5,
              r: 0.5,
              stops: [
                { offset: 0, color: '#fff' },
                { offset: 1, color: '#000' }
              ]
            }
          }
        }
      ]
    },
    {
      commands: [
        {
          op: 'addNode',
          node: {
            type: 'primitive',
            primitive: 'rect',
            fill: {
              type: 'linear',
              angle: 0,
              stops: [
                { offset: 0, color: '#f59e0b', alpha: 0.5 },
                { offset: 0.5, color: '#fff', alpha: 1 },
                { offset: 1, color: '#000' }
              ]
            }
          }
        }
      ]
    },
    {
      commands: [
        {
          op: 'addNode',
          node: {
            type: 'primitive',
            primitive: 'rect',
            fill: {
              type: 'linear',
              angle: 0,
              stops: [
                { offset: 0, color: '#fff', alpha: 1.5 },
                { offset: 1, color: '#000' }
              ]
            }
          }
        }
      ]
    },
    {
      commands: [
        {
          op: 'addNode',
          node: {
            type: 'primitive',
            primitive: 'rect',
            fill: {
              type: 'linear',
              angle: 0,
              stops: [
                { offset: 0, color: '#fff', alpha: 'x' },
                { offset: 1, color: '#000' }
              ]
            }
          }
        }
      ]
    },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { stroke: 'none' } }] },
    { commands: [{ op: 'addNode', node: { type: 'primitive', primitive: 'rect', fill: '' } }] },
    {
      commands: [
        {
          op: 'updateNode',
          nodeId: 'x',
          patch: { letterSpacing: 2, lineHeight: 1.5, verticalAlign: 'middle', fontFallback: ['Lato'] }
        }
      ]
    },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { fontStyle: 'italic', ligatures: false } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { fontStyle: 'oblique' } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { ligatures: 1 } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { lineHeight: 0.2 } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { lineHeight: 5.5 } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { verticalAlign: 'left' } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { fontFallback: ['ok', 3] } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { letterSpacing: 'wide' } }] },
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
            align: 'center',
            letterSpacing: 1,
            lineHeight: 1.2,
            stroke: '#000',
            strokeWidth: 2,
            verticalAlign: 'bottom',
            fontFallback: []
          }
        }
      ]
    },
    {
      commands: [
        {
          op: 'addNode',
          node: {
            type: 'primitive',
            primitive: 'rect',
            fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#fff' }] }
          }
        }
      ]
    },
    {
      commands: [
        {
          op: 'addNode',
          node: {
            type: 'primitive',
            primitive: 'rect',
            fill: {
              type: 'linear',
              angle: 0,
              stops: [
                { offset: 0, color: 'red' },
                { offset: 1, color: '#000' }
              ]
            }
          }
        }
      ]
    },
    {
      commands: [
        {
          op: 'addNode',
          node: {
            type: 'primitive',
            primitive: 'rect',
            fill: {
              type: 'radial',
              cx: 0.5,
              stops: [
                { offset: 0, color: '#fff' },
                { offset: 1, color: '#000' }
              ]
            }
          }
        }
      ]
    },
    {
      commands: [
        {
          op: 'addNode',
          node: {
            type: 'primitive',
            primitive: 'rect',
            fill: {
              type: 'linear',
              angle: 0,
              stops: [
                { offset: 0, color: '#fff' },
                { offset: 1, color: '#000' }
              ],
              extra: 1
            }
          }
        }
      ]
    },
    {
      commands: [
        {
          op: 'updateNode',
          nodeId: 'x',
          patch: {
            fill: {
              type: 'linear',
              angle: -45,
              stops: [
                { offset: 0, color: '#fff' },
                { offset: 2, color: '#000' }
              ]
            }
          }
        }
      ]
    },
    { commands: [{ op: 'addLayer', kind: 'camera', name: 'Camera' }] },
    { commands: [{ op: 'addLayer', kind: 'audio', resourceId: 'a'.repeat(64), startFrame: 8 }] },
    { commands: [{ op: 'addLayer', kind: 'audio', name: 'Sound' }] },
    { commands: [{ op: 'addLayer', kind: 'audio', resourceId: 42 }] },
    { commands: [{ op: 'addLayer', kind: 'audio', startFrame: 4 }] },
    {
      commands: [
        { op: 'setCameraKeyframe', frame: 12, center: { x: 1, y: 2 }, zoom: 2, rotation: 30, tween: true }
      ]
    },
    { commands: [{ op: 'setCameraKeyframe', frame: 0 }] },
    { commands: [{ op: 'setCameraKeyframe' }] },
    { commands: [{ op: 'setCameraKeyframe', frame: -1 }] },
    { commands: [{ op: 'setCameraKeyframe', frame: 2.5 }] },
    { commands: [{ op: 'setCameraKeyframe', frame: 0, zoom: 0 }] },
    { commands: [{ op: 'setCameraKeyframe', frame: 0, center: { x: 1 } }] },
    { commands: [{ op: 'setCameraKeyframe', frame: 0, center: { x: 1, y: 2, z: 3 } }] },
    { commands: [{ op: 'setCameraKeyframe', frame: 0, extra: 1 }] },
    { commands: [{ op: 'removeCameraKeyframe', frame: 3 }] },
    { commands: [{ op: 'removeCameraKeyframe' }] },
    { commands: [{ op: 'removeCameraKeyframe', frame: -1 }] },
    { commands: [{ op: 'setAudio', layerId: 'l1' }] },
    { commands: [{ op: 'setAudio', layerId: 'l1', startFrame: 6, volume: 0.5, muted: true }] },
    { commands: [{ op: 'setAudio', volume: 0.5 }] },
    { commands: [{ op: 'setAudio', layerId: 'l1', volume: 1.5 }] },
    { commands: [{ op: 'setAudio', layerId: 'l1', volume: -0.1 }] },
    { commands: [{ op: 'setAudio', layerId: 'l1', muted: 'no' }] },
    { commands: [{ op: 'setAudio', layerId: 'l1', extra: 1 }] },
    { commands: [{ op: 'group', nodeIds: ['a', 'b'], frame: 0 }] },
    { commands: [{ op: 'group', nodeIds: [] }] },
    { commands: [{ op: 'group', layerId: 'l1' }] },
    { commands: [{ op: 'group', nodeIds: [1, 2] }] },
    { commands: [{ op: 'ungroup', nodeIds: ['g'], surprise: 1 }] },
    { commands: [{ op: 'breakApart', nodeId: 's' }] },
    { commands: [{ op: 'breakApart' }] },
    { commands: [{ op: 'breakApart', nodeId: 's', frame: 2 }] },
    { commands: [{ op: 'createSymbol', nodeIds: ['a'], name: 'Star', frame: 0 }] },
    { commands: [{ op: 'createSymbol', nodeIds: ['a'], extra: 1 }] },
    { commands: [{ op: 'placeAsset', assetId: 'a', at: { x: 1, y: 2 } }] },
    { commands: [{ op: 'placeAsset', at: { x: 1, y: 2 } }] },
    { commands: [{ op: 'placeAsset', assetId: 'a', at: { x: 1 } }] },
    { commands: [{ op: 'placeAsset', assetId: 'a', at: { x: 1, y: 2, z: 3 } }] },
    { commands: [{ op: 'editSymbol', assetId: 'a' }] },
    { commands: [{ op: 'editSymbol' }] },
    { commands: [{ op: 'endSymbolEdit', commit: true }] },
    { commands: [{ op: 'endSymbolEdit' }] },
    { commands: [{ op: 'endSymbolEdit', commit: 'yes' }] },
    { commands: [{ op: 'renameAsset', assetId: 'a', name: 'B' }] },
    { commands: [{ op: 'renameAsset', assetId: 'a' }] },
    { commands: [{ op: 'duplicateAsset', assetId: 'a' }] },
    { commands: [{ op: 'duplicateAsset' }] },
    { commands: [{ op: 'deleteAsset', assetId: 'a' }] },
    { commands: [{ op: 'saveToLibrary', assetId: 'a' }] },
    { commands: [{ op: 'insertFromLibrary', assetId: 'a' }] },
    { commands: [{ op: 'insertFromLibrary', name: 'Star' }] },
    { commands: [{ op: 'insertFromLibrary' }] },
    { commands: [{ op: 'insertFromLibrary', layerId: 'l1' }] },
    { commands: [{ op: 'insertFromLibrary', name: 'Star', at: { x: 5, y: 5 } }] },
    { commands: [{ op: 'insertFrames' }] },
    { commands: [{ op: 'insertFrames', count: 2 }] },
    { commands: [{ op: 'insertFrames', count: 0 }] },
    { commands: [{ op: 'insertFrames', count: 1000 }] },
    { commands: [{ op: 'insertFrames', count: 2.5 }] },
    { commands: [{ op: 'insertFrames', frame: -1 }] },
    { commands: [{ op: 'removeFrames', layerId: 'l1', frame: 3, count: 1 }] },
    { commands: [{ op: 'removeFrames', count: 3 }] },
    { commands: [{ op: 'moveCell', fromFrame: 0, toFrame: 3 }] },
    { commands: [{ op: 'moveCell', fromFrame: 0 }] },
    { commands: [{ op: 'moveCell', toFrame: 3 }] },
    { commands: [{ op: 'moveNodeToFrame', nodeId: 'x', targetFrame: 3 }] },
    { commands: [{ op: 'moveNodeToFrame', targetFrame: 3 }] },
    { commands: [{ op: 'moveNodeToFrame', nodeId: 'x' }] },
    {
      commands: [
        {
          op: 'updateNode',
          nodeId: 'x',
          patch: {
            strokeLinecap: 'round',
            strokeLinejoin: 'bevel',
            strokeDasharray: [6, 4],
            strokeDashoffset: 2
          }
        }
      ]
    },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { strokeLinecap: 'fancy' } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { strokeDasharray: [] } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { strokeDasharray: [0, 0] } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { strokeDasharray: [6, -1] } }] },
    {
      commands: [
        { op: 'updateNode', nodeId: 'x', patch: { strokeDasharray: Array.from({ length: 17 }, () => 4) } }
      ]
    },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { strokeDashoffset: 'x' } }] },
    {
      commands: [
        { op: 'addNode', node: { type: 'path', d: 'M0 0L1 1', strokeLinecap: 'round', strokeDasharray: [0] } }
      ]
    },
    {
      commands: [
        {
          op: 'setPathAnchors',
          nodeId: 'x',
          subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }]
        }
      ]
    },
    {
      commands: [
        {
          op: 'setPathAnchors',
          nodeId: 'x',
          frame: 3,
          layerId: 'l1',
          subpaths: [
            {
              closed: true,
              anchors: [
                { x: 0, y: 0, in: { x: -1, y: 0 }, out: { x: 1, y: 0 } },
                { x: 10, y: 10 },
                { x: 20, y: 0 }
              ]
            }
          ]
        }
      ]
    },
    { commands: [{ op: 'setPathAnchors', nodeId: 'x' }] },
    {
      commands: [
        { op: 'setPathAnchors', subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] }
      ]
    },
    { commands: [{ op: 'setPathAnchors', nodeId: 'x', subpaths: [] }] },
    {
      commands: [
        { op: 'setPathAnchors', nodeId: 'x', subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }] }] }
      ]
    },
    {
      commands: [
        {
          op: 'setPathAnchors',
          nodeId: 'x',
          subpaths: [{ closed: 'yes', anchors: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]
        }
      ]
    },
    {
      commands: [
        {
          op: 'setPathAnchors',
          nodeId: 'x',
          subpaths: [{ closed: false, anchors: [{ x: 'a', y: 0 }, { x: 1, y: 1 }] }]
        }
      ]
    },
    {
      commands: [
        {
          op: 'setPathAnchors',
          nodeId: 'x',
          subpaths: [{ closed: false, anchors: [{ x: 0, y: 0, in: { x: 1 } }, { x: 1, y: 1 }] }]
        }
      ]
    },
    {
      commands: [
        {
          op: 'setPathAnchors',
          nodeId: 'x',
          subpaths: [{ closed: false, anchors: [{ x: 0, y: 0, in: null }, { x: 1, y: 1 }] }]
        }
      ]
    },
    {
      commands: [
        {
          op: 'setPathAnchors',
          nodeId: 'x',
          subpaths: [{ closed: false, anchors: [{ x: 0, y: 0, extra: 1 }, { x: 1, y: 1 }] }]
        }
      ]
    },
    {
      commands: [
        {
          op: 'setPathAnchors',
          nodeId: 'x',
          subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 1, y: 1 }], extra: 1 }]
        }
      ]
    },
    {
      commands: [
        {
          op: 'setPathAnchors',
          nodeId: 'x',
          subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
          extra: 1
        }
      ]
    },
    {
      commands: [
        {
          op: 'export',
          format: 'gif',
          out: '/tmp/out.gif',
          fromFrame: 0,
          toFrame: 12,
          scale: 2,
          fps: 12,
          transparent: true,
          gifPalette: 'global',
          gifDither: false,
          gifLoop: 0,
          videoQuality: 'high'
        }
      ]
    },
    { commands: [{ op: 'export', format: 'png-sequence' }] },
    { commands: [{ op: 'export', format: 'lottie', fps: 24 }] },
    { commands: [{ op: 'export' }] },
    { commands: [{ op: 'export', format: 'bogus' }] },
    { commands: [{ op: 'export', format: 'gif', fps: 12.5 }] },
    { commands: [{ op: 'export', format: 'gif', fps: 0 }] },
    { commands: [{ op: 'export', format: 'gif', gifPalette: 'adaptive' }] },
    { commands: [{ op: 'export', format: 'webm', gifPalette: 'perFrame' }] },
    { commands: [{ op: 'export', format: 'mp4', videoQuality: 'ultra' }] },
    { commands: [{ op: 'export', format: 'gif', gifLoop: -2 }] },
    { commands: [{ op: 'export', format: 'gif', gifLoop: -1 }] },
    { commands: [{ op: 'export', format: 'gif', extra: 1 }] },
    { commands: [{ op: 'export', format: 'gif', fromFrame: -1 }] },
    {
      commands: [
        {
          op: 'importImage',
          frame: 3,
          layerId: 'l1',
          at: { x: 10, y: 20 },
          width: 100,
          height: 50,
          name: 'logo.png'
        }
      ]
    },
    { commands: [{ op: 'importImage' }] },
    { commands: [{ op: 'importImage', width: 0 }] },
    { commands: [{ op: 'importImage', height: -2 }] },
    { commands: [{ op: 'importImage', at: { x: 1 } }] },
    { commands: [{ op: 'importImage', at: { x: 1, y: 2, z: 3 } }] },
    { commands: [{ op: 'importImage', layerId: 'l1', extra: 1 }] },
    { commands: [{ op: 'importAudio', startFrame: 6 }] },
    { commands: [{ op: 'importAudio' }] },
    { commands: [{ op: 'importAudio', startFrame: -1 }] },
    { commands: [{ op: 'importAudio', surprise: 1 }] },
    { commands: [{ op: 'setOnionSkin', enabled: true, before: 3, after: 1 }] },
    { commands: [{ op: 'setOnionSkin', enabled: false }] },
    { commands: [{ op: 'setOnionSkin', before: 5 }] },
    { commands: [{ op: 'setOnionSkin' }] },
    { commands: [{ op: 'setOnionSkin', before: 6 }] },
    { commands: [{ op: 'setOnionSkin', after: -1 }] },
    { commands: [{ op: 'setOnionSkin', enabled: 'yes' }] },
    { commands: [{ op: 'setOnionSkin', opacity: 0.5 }] },
    { commands: [{ op: 'setBrush', color: '#ff8800', size: 12, opacity: 0.5 }] },
    { commands: [{ op: 'setBrush', color: '#FFF' }] },
    { commands: [{ op: 'setBrush', size: 0.5 }] },
    { commands: [{ op: 'setBrush' }] },
    { commands: [{ op: 'setBrush', color: 'red' }] },
    { commands: [{ op: 'setBrush', size: 0 }] },
    { commands: [{ op: 'setBrush', opacity: 1.5 }] },
    { commands: [{ op: 'setBrush', color: '#aabbcc', extra: 1 }] },
    { commands: [{ op: 'setGlobalPalette', colors: ['#fff', '#123456'] }] },
    { commands: [{ op: 'setGlobalPalette', colors: ['#ffffff'] }] },
    { commands: [{ op: 'setGlobalPalette', colors: Array.from({ length: 48 }, () => '#fff') }] },
    { commands: [{ op: 'setGlobalPalette', colors: Array.from({ length: 49 }, () => '#fff') }] },
    { commands: [{ op: 'setGlobalPalette', colors: [] }] },
    { commands: [{ op: 'setGlobalPalette' }] },
    { commands: [{ op: 'setGlobalPalette', colors: ['red'] }] },
    { commands: [{ op: 'setGlobalPalette', colors: ['#fff'], extra: 1 }] },
    { commands: [{ op: 'addGlobalPaletteColor', color: '#a1b2c3' }] },
    { commands: [{ op: 'addGlobalPaletteColor' }] },
    { commands: [{ op: 'addGlobalPaletteColor', color: 'red' }] },
    { commands: [{ op: 'addGlobalPaletteColor', color: '#abc', extra: 1 }] },
    { commands: [{ op: 'addLayer', kind: 'object', layerId: 'layer-7', name: 'Layer 7' }] },
    { commands: [{ op: 'addLayer', kind: 'audio', resourceId: 'clip-1', layerId: 'aud-1', startFrame: 0 }] },
    { commands: [{ op: 'addLayer', kind: 'audio', layerId: 'aud-1' }] },
    { commands: [{ op: 'addLayer', layerId: null }] },
    {
      commands: [
        {
          op: 'updateNode',
          nodeId: 'x',
          patch: {
            name: null,
            stroke: null,
            strokeWidth: null,
            fontStyle: null,
            ligatures: null,
            letterSpacing: null,
            lineHeight: null,
            verticalAlign: null,
            fontFallback: null,
            strokeLinecap: null,
            strokeLinejoin: null,
            strokeDasharray: null,
            strokeDashoffset: null
          }
        }
      ]
    },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { fill: null } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { center: null } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { opacity: null } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { name: 7 } }] },
    { commands: [{ op: 'updateNode', nodeId: 'x', patch: { fontStyle: null, lineHeight: 0.2 } }] }
  ]

  it('agrees with the compiled schema on every corpus entry', () => {
    for (const payload of corpus) {
      const handRolled = validateScriptPayload(payload).errors.length === 0
      const ajv = ajvValidate(payload) as boolean
      expect(handRolled, `${JSON.stringify(payload)}: hand-rolled=${handRolled} ajv=${ajv}`).toBe(ajv)
    }
  })
})
