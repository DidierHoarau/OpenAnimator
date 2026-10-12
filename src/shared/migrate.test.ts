import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { evaluateDocumentAtFrame } from './render'
import { isAnimatorDocument } from './document'
import { MigrationError, migrateDocument } from './migrate'
import type { AnimatorDocument, ObjectLayer, PrimitiveNode } from './model'

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'v1', `${name}.json`), 'utf8'))
}

function primitive(id: string, overrides: Partial<PrimitiveNode> & { primitive: 'rect' | 'ellipse' }): PrimitiveNode {
  return {
    type: 'primitive',
    id,
    center: { x: 0, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    fill: '#000000',
    opacity: 1,
    ...overrides
  }
}

/** Hand-written current-schema equivalent of `fixtures/v1/tweened-strokes.json`. */
function expectedTweenedStrokesDocument(): AnimatorDocument {
  return {
    schemaVersion: 4,
    name: 'Tween demo',
    width: 960,
    height: 540,
    fps: 24,
    background: '#10151b',
    assets: [],
    layers: [
      {
        kind: 'object',
        id: 'layer-hero',
        name: 'Hero',
        visible: true,
        locked: false,
        keyframes: [
          {
            frame: 0,
            nodes: [
              primitive('ball', {
                primitive: 'ellipse',
                name: 'Ball',
                center: { x: 100, y: 100 },
                width: 80,
                height: 80,
                fill: '#f59e0b',
                stroke: '#fcd34d',
                strokeWidth: 3
              }),
              primitive('ground', {
                primitive: 'rect',
                name: 'Ground',
                center: { x: 480, y: 500 },
                width: 960,
                height: 80,
                fill: '#1f2937'
              })
            ],
            tween: { easing: 'ease-in-out' }
          },
          {
            frame: 12,
            nodes: [
              primitive('ball', {
                primitive: 'ellipse',
                name: 'Ball',
                center: { x: 480, y: 380 },
                width: 120,
                height: 120,
                rotation: 90,
                fill: '#38bdf8',
                opacity: 0.5
              }),
              primitive('ground', {
                primitive: 'rect',
                name: 'Ground',
                center: { x: 480, y: 500 },
                width: 960,
                height: 80,
                fill: '#1f2937'
              })
            ]
          }
        ]
      }
    ],
    frames: 13
  }
}

describe('migrateDocument — v1 fixtures', () => {
  it('migrates the tweened fixture with strokes and names verbatim', () => {
    const raw = loadFixture('tweened-strokes')
    const migrated = migrateDocument(raw)
    const expected = expectedTweenedStrokesDocument()
    expect(migrated).toEqual(expected)
    expect(isAnimatorDocument(migrated)).toBe(true)
  })

  it('migrates the multi-layer fixture including hidden/locked flags', () => {
    const raw = loadFixture('multi-layer')
    const migrated = migrateDocument(raw)
    expect(migrated.schemaVersion).toBe(4)
    expect(migrated.layers).toHaveLength(2)
    expect(migrated.layers[0]).toMatchObject({
      id: 'layer-fx',
      visible: false,
      locked: true,
      keyframes: [{ frame: 0, nodes: [expect.objectContaining({ id: 'glow', primitive: 'ellipse' })] }]
    })
    expect(
      (migrated.layers[1] as ObjectLayer).keyframes.map((keyframe) => keyframe.frame)
    ).toEqual([0, 6])
    expect((migrated.layers[1] as ObjectLayer).keyframes[0].tween).toEqual({ easing: 'linear' })
    expect(
      (migrated.layers[1] as ObjectLayer).keyframes[1].nodes.map((node) => node.id)
    ).toEqual(['box-a', 'box-b'])
    expect(isAnimatorDocument(migrated)).toBe(true)
  })

  it('migrates a legacy save without the frames field', () => {
    const raw = loadFixture('no-frames')
    const migrated = migrateDocument(raw)
    expect(migrated.frames).toBeUndefined()
    expect((migrated.layers[0] as ObjectLayer).keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 4])
    expect((migrated.layers[0] as ObjectLayer).keyframes[1].tween).toEqual({ easing: 'ease-out' })
    expect(isAnimatorDocument(migrated)).toBe(true)
  })

  it('migrates the minimal fixture with an empty keyframe', () => {
    const raw = loadFixture('minimal')
    const migrated = migrateDocument(raw)
    expect(migrated).toEqual({
      schemaVersion: 4,
      name: 'Untitled',
      width: 960,
      height: 540,
      fps: 24,
      background: '#10151b',
      assets: [],
      layers: [
        {
          kind: 'object',
          id: 'layer-1',
          name: 'Layer 1',
          visible: true,
          locked: false,
          keyframes: [{ frame: 0, nodes: [] }]
        }
      ]
    })
    expect(isAnimatorDocument(migrated)).toBe(true)
  })

  it('evaluates migrated v1 content identically to its v2 equivalent', () => {
    const migrated = migrateDocument(loadFixture('tweened-strokes'))
    const expected = expectedTweenedStrokesDocument()
    for (let frame = 0; frame < 13; frame++) {
      expect(evaluateDocumentAtFrame(migrated, frame)).toEqual(
        evaluateDocumentAtFrame(expected, frame)
      )
    }
    // And a tweened midpoint really interpolates (the render pipeline works).
    const atSix = evaluateDocumentAtFrame(migrated, 6)[0].nodes.find((node) => node.id === 'ball')
    expect(atSix?.center.x).toBeCloseTo(290)
  })

  it('passes a v2 document through unchanged and detached from the input', () => {
    const v2 = migrateDocument(loadFixture('tweened-strokes'))
    const roundTripped: unknown = JSON.parse(JSON.stringify(v2))
    const result = migrateDocument(roundTripped)
    expect(result).toEqual(v2)
    expect(result).not.toBe(roundTripped)
    expect(isAnimatorDocument(result)).toBe(true)

    // Rejected: a "v2" document that fails deep validation.
    const corrupted = JSON.parse(JSON.stringify(v2)) as Record<string, unknown>
    ;(corrupted.layers as { keyframes: unknown }[])[0].keyframes = 'nope'
    expect(() => migrateDocument(corrupted)).toThrow(MigrationError)
  })

  it('does not mutate its input', () => {
    const raw = loadFixture('tweened-strokes') as Record<string, unknown>
    const snapshot = JSON.parse(JSON.stringify(raw))
    migrateDocument(raw)
    expect(raw).toEqual(snapshot)
  })
})

describe('migrateDocument — invalid content', () => {
  it('rejects non-objects and junk shapes with a clear message', () => {
    expect(() => migrateDocument(null)).toThrow(MigrationError)
    expect(() => migrateDocument('hello')).toThrow(MigrationError)
    expect(() => migrateDocument([])).toThrow(MigrationError)
    expect(() => migrateDocument({})).toThrow(MigrationError)
  })

  it('rejects an unknown shape kind', () => {
    const raw = {
      name: 'x',
      width: 100,
      height: 100,
      fps: 24,
      background: '#000000',
      layers: [
        {
          id: 'l',
          name: 'L',
          visible: true,
          locked: false,
          keyframes: [{ frame: 0, shapes: [{ id: 's', kind: 'polygon' }] }]
        }
      ]
    }
    expect(() => migrateDocument(raw)).toThrow(/unknown shape kind "polygon"/)
    expect(() => migrateDocument(raw)).toThrow(MigrationError)
  })

  it('rejects non-finite numbers, bad opacity and bad frames', () => {
    const base = {
      name: 'x',
      width: 100,
      height: 100,
      fps: 24,
      background: '#000000',
      layers: [
        {
          id: 'l',
          name: 'L',
          visible: true,
          locked: false,
          keyframes: [
            {
              frame: 0,
              shapes: [
                {
                  id: 's',
                  kind: 'rect',
                  center: { x: 0, y: 0 },
                  width: 10,
                  height: 10,
                  rotation: 0,
                  fill: '#ffffff',
                  opacity: 1
                }
              ]
            }
          ]
        }
      ]
    }
    const hugeWidth = JSON.parse(JSON.stringify(base))
    hugeWidth.layers[0].keyframes[0].shapes[0].width = Number.MAX_VALUE * 2
    expect(() => migrateDocument(hugeWidth)).toThrow(/"width" and "height" must be finite/)

    const badOpacity = JSON.parse(JSON.stringify(base))
    badOpacity.layers[0].keyframes[0].shapes[0].opacity = 1.5
    expect(() => migrateDocument(badOpacity)).toThrow(/"opacity" must be a number between 0 and 1/)

    const badFrame = JSON.parse(JSON.stringify(base))
    badFrame.layers[0].keyframes[0].frame = -1
    expect(() => migrateDocument(badFrame)).toThrow(/"frame" must be an integer/)

    const badEasing = JSON.parse(JSON.stringify(base))
    badEasing.layers[0].keyframes[0].tween = { easing: 'wobble' }
    expect(() => migrateDocument(badEasing)).toThrow(/unknown tween easing "wobble"/)

    const badFps = JSON.parse(JSON.stringify(base))
    badFps.fps = 0
    expect(() => migrateDocument(badFps)).toThrow(/"fps" must be a positive number/)

    const missingShapes = JSON.parse(JSON.stringify(base))
    delete missingShapes.layers[0].keyframes[0].shapes
    expect(() => migrateDocument(missingShapes)).toThrow(/"shapes" must be an array/)
  })

  it('reports the location of the first invalid shape', () => {
    const raw = {
      name: 'x',
      width: 100,
      height: 100,
      fps: 24,
      background: '#000000',
      layers: [
        {
          id: 'l',
          name: 'L',
          visible: true,
          locked: false,
          keyframes: [{ frame: 0, shapes: [] }]
        },
        {
          id: 'l2',
          name: 'L2',
          visible: true,
          locked: false,
          keyframes: [{ frame: 0, shapes: [] }, { frame: 1, shapes: [{ id: 'oops', kind: 42 }] }]
        }
      ]
    }
    expect(() => migrateDocument(raw)).toThrow(/layer 2, keyframe 2, node 1/)
  })
})

describe('migrateDocument — assets', () => {
  const base = {
    schemaVersion: 3,
    name: 'x',
    width: 100,
    height: 100,
    fps: 24,
    background: '#000000',
    layers: [{ id: 'l', name: 'L', visible: true, locked: false, keyframes: [{ frame: 0, nodes: [] }] }]
  }

  it('normalizes a v2 document without assets to an empty asset list', () => {
    const migrated = migrateDocument(JSON.parse(JSON.stringify(base)))
    expect(migrated.assets).toEqual([])
    expect(isAnimatorDocument(migrated)).toBe(true)
  })

  it('keeps valid assets through the migration', () => {
    const withAssets = {
      ...JSON.parse(JSON.stringify(base)),
      assets: [
        {
          id: 'a',
          name: 'Rocket',
          kind: 'symbol',
          content: {
            type: 'group',
            id: 'content',
            center: { x: 0, y: 0 },
            width: 100,
            height: 50,
            rotation: 0,
            opacity: 1,
            children: []
          },
          createdAt: 1
        }
      ]
    }
    const migrated = migrateDocument(withAssets)
    expect(migrated.assets).toHaveLength(1)
    expect(migrated.assets[0].id).toBe('a')
    expect(isAnimatorDocument(migrated)).toBe(true)
  })

  it('rejects a malformed assets array', () => {
    expect(() => migrateDocument({ ...base, assets: 'nope' })).toThrow(/"assets" must be an array/)
  })

  it('rejects a malformed asset entry', () => {
    expect(() => migrateDocument({ ...base, assets: [{ garbage: true }] })).toThrow(MigrationError)
  })

  it('loads a cyclic-but-structurally-valid asset graph (rendered as placeholders)', () => {
    const cyclic = {
      ...JSON.parse(JSON.stringify(base)),
      assets: [
        {
          id: 'a',
          name: 'Loop',
          kind: 'symbol',
          content: {
            type: 'group',
            id: 'content',
            center: { x: 0, y: 0 },
            width: 100,
            height: 50,
            rotation: 0,
            opacity: 1,
            children: [
              { id: 'self', type: 'symbol', assetId: 'a', center: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0, opacity: 1 }
            ]
          },
          createdAt: 1
        }
      ]
    }
    const migrated = migrateDocument(cyclic)
    expect(migrated.assets).toHaveLength(1)
    expect(isAnimatorDocument(migrated)).toBe(true)
  })
})

describe('migrateDocument — v4 pass-through', () => {
  const v4Base = () => ({
    schemaVersion: 4,
    name: 'x',
    width: 100,
    height: 100,
    fps: 24,
    background: '#000000',
    layers: [{ id: 'l', name: 'L', visible: true, locked: false, keyframes: [{ frame: 0, nodes: [] }] }]
  })

  it('keeps holdStep, tween path and bezier easings through deep validation', () => {
    const raw = {
      ...v4Base(),
      holdStep: 3,
      layers: [
        {
          kind: 'object',
          id: 'l',
          name: 'L',
          visible: true,
          locked: false,
          keyframes: [
            {
              frame: 0,
              nodes: [],
              tween: { easing: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 }, path: 'smooth' }
            }
          ]
        }
      ]
    }
    const migrated = migrateDocument(raw)
    expect(migrated.schemaVersion).toBe(4)
    expect(migrated.holdStep).toBe(3)
    expect((migrated.layers[0] as ObjectLayer).keyframes[0].tween).toEqual({
      easing: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
      path: 'smooth'
    })
    expect(isAnimatorDocument(migrated)).toBe(true)
  })

  it('rejects out-of-bounds holdSteps and malformed tween paths', () => {
    expect(() => migrateDocument({ ...v4Base(), holdStep: 17 })).toThrow(MigrationError)
    expect(() => migrateDocument({ ...v4Base(), holdStep: 0 })).toThrow(MigrationError)
    const badPath = {
      ...v4Base(),
      layers: [
        {
          kind: 'object',
          id: 'l',
          name: 'L',
          visible: true,
          locked: false,
          keyframes: [{ frame: 0, nodes: [], tween: { easing: 'linear', path: 'wobbly' } }]
        }
      ]
    }
    expect(() => migrateDocument(badPath)).toThrow(MigrationError)
    const badBezier = {
      ...v4Base(),
      layers: [
        {
          kind: 'object',
          id: 'l',
          name: 'L',
          visible: true,
          locked: false,
          keyframes: [{ frame: 0, nodes: [], tween: { easing: { x1: 2, y1: 0, x2: 0.5, y2: 1 } } }]
        }
      ]
    }
    expect(() => migrateDocument(badBezier)).toThrow(MigrationError)
  })

  it('restamps a v3 document to v4', () => {
    const raw = { ...v4Base(), schemaVersion: 3 }
    const migrated = migrateDocument(JSON.parse(JSON.stringify(raw)))
    expect(migrated.schemaVersion).toBe(4)
    expect(isAnimatorDocument(migrated)).toBe(true)
  })
})

describe('migrateDocument — drawing layers', () => {
  const baseWithUntypedLayer = () => ({
    schemaVersion: 3,
    name: 'x',
    width: 100,
    height: 100,
    fps: 24,
    background: '#000000',
    layers: [{ id: 'l', name: 'L', visible: true, locked: false, keyframes: [{ frame: 0, nodes: [] }] }]
  })

  it('normalizes v2 documents written before drawing layers to object layers', () => {
    const migrated = migrateDocument(JSON.parse(JSON.stringify(baseWithUntypedLayer())))
    expect(migrated.layers[0].kind).toBe('object')
    expect(isAnimatorDocument(migrated)).toBe(true)
  })

  it('accepts well-formed drawing layers of v2 documents', () => {
    const withDrawing = JSON.parse(JSON.stringify(baseWithUntypedLayer()))
    withDrawing.layers.push({
      kind: 'drawing',
      id: 'd',
      name: 'Draw',
      visible: true,
      locked: false,
      resolutionScale: 2,
      cells: [{ frame: 0, resourceId: 'res-1' }]
    })
    const migrated = migrateDocument(withDrawing)
    expect(migrated.layers[1].kind).toBe('drawing')
    expect(isAnimatorDocument(migrated)).toBe(true)
  })

  it('rejects malformed drawing layers', () => {
    const badScale = JSON.parse(JSON.stringify(baseWithUntypedLayer()))
    badScale.layers.push({
      kind: 'drawing',
      id: 'd',
      name: 'Draw',
      visible: true,
      locked: false,
      resolutionScale: 0,
      cells: []
    })
    expect(() => migrateDocument(badScale)).toThrow(MigrationError)

    const badCell = JSON.parse(JSON.stringify(baseWithUntypedLayer()))
    badCell.layers.push({
      kind: 'drawing',
      id: 'd',
      name: 'Draw',
      visible: true,
      locked: false,
      resolutionScale: 1,
      cells: [{ frame: 0 }]
    })
    expect(() => migrateDocument(badCell)).toThrow(MigrationError)
  })
})
