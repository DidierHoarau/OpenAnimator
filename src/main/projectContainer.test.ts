import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { strToU8, zipSync } from 'fflate'

import { describe, expect, it } from 'vitest'

import { evaluateDocumentAtFrame } from '../shared/render'
import { MigrationError, migrateDocument } from '../shared/migrate'
import type { AnimatorDocument, ImageNode, SceneNode } from '../shared/model'
import { isZipContainer, packProject, parseProject } from './projectContainer'
import type { ProjectResourceMap } from './projectContainer'

function loadV1Fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, '../shared/fixtures/v1', `${name}.json`), 'utf8'))
}

function imageNode(id: string, resourceId: string): ImageNode {
  return {
    id,
    type: 'image',
    resourceId,
    center: { x: 100, y: 100 },
    width: 320,
    height: 240,
    rotation: 0,
    opacity: 1,
    naturalWidth: 640,
    naturalHeight: 480,
    smoothing: true
  }
}

function documentWithNodes(nodes: SceneNode[]): AnimatorDocument {
  const document = migrateDocument({
    name: 'container-test',
    width: 960,
    height: 540,
    fps: 24,
    background: '#10151b',
    layers: [{ id: 'layer-1', name: 'Layer 1', visible: true, locked: false, keyframes: [{ frame: 0, shapes: [] }] }]
  })
  const layer = document.layers[0]
  if (layer.kind !== 'object') throw new Error('expected an object layer')
  layer.keyframes[0].nodes.push(...nodes)
  return document
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6])
const AUDIO_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
const SAME_BYTES = PNG_BYTES.slice()

function resources(entries: Array<[string, Uint8Array, string]>): ProjectResourceMap {
  return new Map(entries.map(([id, bytes, ext]) => [id, { bytes, ext }]))
}

describe('isZipContainer', () => {
  it('detects the PK magic bytes', () => {
    expect(isZipContainer(packProject(documentWithNodes([]), new Map()))).toBe(true)
  })

  it('rejects plain JSON documents', () => {
    expect(isZipContainer(new TextEncoder().encode('{"schemaVersion":2}'))).toBe(false)
  })

  it('rejects empty input', () => {
    expect(isZipContainer(new Uint8Array())).toBe(false)
  })
})

describe('packProject / parseProject — round trip', () => {
  it('round-trips a document with resources', () => {
    const document = documentWithNodes([imageNode('img-1', 'a'.repeat(64))])
    const packed = packProject(
      document,
      resources([['a'.repeat(64), PNG_BYTES, 'png'], ['b'.repeat(64), JPG_BYTES, 'jpg']])
    )
    const parsed = parseProject(packed)
    expect(parsed.document).toEqual(document)
    expect(parsed.resources.size).toBe(1)
    expect(parsed.resources.get('a'.repeat(64))).toEqual({ bytes: PNG_BYTES, ext: 'png' })
  })

  it('writes stored (level 0) resource entries: the bytes survive verbatim', () => {
    const document = documentWithNodes([imageNode('img-1', 'a'.repeat(64))])
    const parsed = parseProject(packProject(document, resources([['a'.repeat(64), PNG_BYTES, 'png']])))
    expect(Array.from(parsed.resources.get('a'.repeat(64))!.bytes)).toEqual(Array.from(PNG_BYTES))
  })

  it('always writes a ZIP, even with no resources', () => {
    const document = documentWithNodes([])
    const packed = packProject(document, new Map())
    expect(isZipContainer(packed)).toBe(true)
    const parsed = parseProject(packed)
    expect(parsed.document).toEqual(document)
    expect(parsed.resources.size).toBe(0)
  })

  it('migrates a real v1 fixture packed into a container and evaluates it', () => {
    const document = migrateDocument(loadV1Fixture('tweened-strokes'))
    const packed = packProject(document, new Map())
    const parsed = parseProject(packed)
    expect(parsed.document.schemaVersion).toBe(7)
    expect(evaluateDocumentAtFrame(parsed.document, 0).layers.length).toBeGreaterThan(0)
  })

  it('round-trips camera and audio layers, keeping the audio resource', () => {
    const document = documentWithNodes([])
    document.layers.push(
      {
        kind: 'camera',
        id: 'cam',
        name: 'Camera',
        visible: true,
        locked: false,
        keyframes: [
          { frame: 0, pose: { center: { x: 10, y: 20 }, zoom: 1.5, rotation: 0 }, tween: { easing: 'linear' } },
          { frame: 10, pose: { center: { x: 90, y: 80 }, zoom: 2, rotation: 30 } }
        ]
      },
      {
        kind: 'audio',
        id: 'sound',
        name: 'Sound',
        visible: true,
        locked: false,
        resourceId: 'e'.repeat(64),
        startFrame: 3,
        volume: 0.4
      }
    )
    const parsed = parseProject(
      packProject(document, resources([['e'.repeat(64), AUDIO_BYTES, 'wav']]))
    )
    expect(parsed.document).toEqual(document)
    expect(parsed.resources.get('e'.repeat(64))).toEqual({ bytes: AUDIO_BYTES, ext: 'wav' })
    // The camera pose evaluates out of the parsed container.
    expect(evaluateDocumentAtFrame(parsed.document, 5).camera!.center).toEqual({ x: 50, y: 50 })
  })

  it('dedupes identical content into a single ZIP entry', () => {
    const document = documentWithNodes([
      imageNode('img-1', 'a'.repeat(64)),
      imageNode('img-2', 'a'.repeat(64))
    ])
    // The store may hold the same content under one hash; even under two
    // names the writer cannot produce duplicate bytes for identical content.
    const packed = packProject(document, resources([['a'.repeat(64), SAME_BYTES, 'png']]))
    const parsed = parseProject(packed)
    expect(parsed.resources.size).toBe(1)
    const layer = parsed.document.layers[0]
    if (layer.kind !== 'object') throw new Error('expected an object layer')
    expect(layer.keyframes[0].nodes.length).toBe(2)
  })

  it('skips unreferenced resources (refcount walk)', () => {
    const document = documentWithNodes([imageNode('img-1', 'a'.repeat(64))])
    const parsed = parseProject(
      packProject(document, resources([['a'.repeat(64), PNG_BYTES, 'png'], ['c'.repeat(64), JPG_BYTES, 'jpg']]))
    )
    expect(parsed.resources.size).toBe(1)
    expect(parsed.resources.has('c'.repeat(64))).toBe(false)
  })

  it('keeps resources referenced only by document assets', () => {
    // Regression: the refcount walk must include document.assets, or the
    // resources behind library-only symbol content would be dropped on save.
    const document = documentWithNodes([])
    document.assets = [
      {
        id: 'a',
        name: 'badge',
        kind: 'symbol',
        content: {
          type: 'group',
          id: 'content',
          center: { x: 0, y: 0 },
          width: 10,
          height: 10,
          rotation: 0,
          opacity: 1,
          children: [imageNode('inner', 'c'.repeat(64))]
        },
        createdAt: 1
      }
    ]
    const parsed = parseProject(
      packProject(document, resources([['c'.repeat(64), JPG_BYTES, 'jpg']]))
    )
    expect(parsed.resources.get('c'.repeat(64))).toEqual({ bytes: JPG_BYTES, ext: 'jpg' })
  })
})

describe('parseProject — error handling', () => {
  it('parses with the resource absent from the map when the zip lacks it', () => {
    const document = documentWithNodes([imageNode('img-1', 'd'.repeat(64))])
    const packed = packProject(document, new Map())
    const parsed = parseProject(packed)
    expect(parsed.document).toEqual(document)
    expect(parsed.resources.size).toBe(0)
  })

  it('rejects a structurally corrupt zip with a clear error', () => {
    const packed = packProject(documentWithNodes([]), new Map())
    expect(() => parseProject(packed.slice(0, Math.floor(packed.length / 2)))).toThrow(MigrationError)
    expect(() => parseProject(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]))).toThrow(
      'The project file is not a valid OpenAnimator archive.'
    )
    expect(() => parseProject(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(
      'The project file is not a valid OpenAnimator archive.'
    )
  })

  it('rejects a valid zip without a document.json entry', () => {
    const packed = zipSync({ 'resources/ab.png': [PNG_BYTES, { level: 0 }] })
    expect(() => parseProject(packed)).toThrow(/document\.json/)
  })

  it('rejects a zip whose document.json is not JSON', () => {
    const packed = zipSync({ 'document.json': [strToU8('not json'), { level: 6 }] })
    expect(() => parseProject(packed)).toThrow(/invalid document\.json/)
  })

  it('fails on unknown node types instead of shim-migrating them', () => {
    const raw = {
      schemaVersion: 2,
      name: 'bad',
      width: 100,
      height: 100,
      fps: 24,
      background: '#000000',
      assets: [],
      layers: [
        {
          id: 'l1',
          name: 'L',
          visible: true,
          locked: false,
          keyframes: [{ frame: 0, nodes: [{ id: 'x', type: 'hologram', center: { x: 0, y: 0 } }] }]
        }
      ]
    }
    const forged = zipSync({
      'document.json': [strToU8(JSON.stringify(raw)), { level: 6 }]
    })
    expect(() => parseProject(forged)).toThrow(MigrationError)
  })

  it('parses a plain-JSON v2 document through migrateDocument with no resources', () => {
    const document = documentWithNodes([])
    const plain = new TextEncoder().encode(JSON.stringify(document))
    expect(isZipContainer(plain)).toBe(false)
    const migrated = migrateDocument(JSON.parse(new TextDecoder().decode(plain)))
    expect(migrated).toEqual(document)
  })
})
