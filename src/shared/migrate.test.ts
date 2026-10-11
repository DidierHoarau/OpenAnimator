import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { evaluateDocumentAtFrame } from './render'
import { isAnimatorDocument } from './document'
import { MigrationError, migrateDocument } from './migrate'
import type { AnimatorDocument, PrimitiveNode } from './model'

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

/** Hand-written v2 equivalent of `fixtures/v1/tweened-strokes.json`. */
function expectedTweenedStrokesDocument(): AnimatorDocument {
  return {
    schemaVersion: 2,
    name: 'Tween demo',
    width: 960,
    height: 540,
    fps: 24,
    background: '#10151b',
    layers: [
      {
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
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.layers).toHaveLength(2)
    expect(migrated.layers[0]).toMatchObject({
      id: 'layer-fx',
      visible: false,
      locked: true,
      keyframes: [{ frame: 0, nodes: [expect.objectContaining({ id: 'glow', primitive: 'ellipse' })] }]
    })
    expect(migrated.layers[1].keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 6])
    expect(migrated.layers[1].keyframes[0].tween).toEqual({ easing: 'linear' })
    expect(
      migrated.layers[1].keyframes[1].nodes.map((node) => node.id)
    ).toEqual(['box-a', 'box-b'])
    expect(isAnimatorDocument(migrated)).toBe(true)
  })

  it('migrates a legacy save without the frames field', () => {
    const raw = loadFixture('no-frames')
    const migrated = migrateDocument(raw)
    expect(migrated.frames).toBeUndefined()
    expect(migrated.layers[0].keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 4])
    expect(migrated.layers[0].keyframes[1].tween).toEqual({ easing: 'ease-out' })
    expect(isAnimatorDocument(migrated)).toBe(true)
  })

  it('migrates the minimal fixture with an empty keyframe', () => {
    const raw = loadFixture('minimal')
    const migrated = migrateDocument(raw)
    expect(migrated).toEqual({
      schemaVersion: 2,
      name: 'Untitled',
      width: 960,
      height: 540,
      fps: 24,
      background: '#10151b',
      layers: [
        {
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
