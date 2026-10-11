import { describe, expect, it } from 'vitest'

import { createDocument } from '../shared/document'
import type { AnimatorDocument, ImageNode } from '../shared/model'
import { ResourceStore, extensionOf } from './resources'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7])

function documentWithImage(resourceId: string): AnimatorDocument {
  const document = createDocument('test', 100, 100, 24)
  const image: ImageNode = {
    id: 'img-1',
    type: 'image',
    resourceId,
    center: { x: 50, y: 50 },
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    naturalWidth: 10,
    naturalHeight: 10,
    smoothing: true
  }
  const layer = document.layers[0]
  if (layer.kind !== 'object') throw new Error('expected an object layer')
  layer.keyframes[0].nodes.push(image)
  return document
}

describe('ResourceStore', () => {
  it('adds resources keyed by SHA-256 content digest', () => {
    const store = new ResourceStore()
    const { resourceId, deduped } = store.add(PNG_BYTES, 'png')
    expect(resourceId).toMatch(/^[0-9a-f]{64}$/)
    expect(deduped).toBe(false)
    expect(store.all().get(resourceId)).toEqual({ bytes: PNG_BYTES, ext: 'png' })
  })

  it('dedupes identical content regardless of the given extension', () => {
    const store = new ResourceStore()
    const first = store.add(PNG_BYTES, 'png')
    const second = store.add(new Uint8Array(PNG_BYTES), 'jpg')
    expect(second.resourceId).toBe(first.resourceId)
    expect(second.deduped).toBe(true)
    expect(store.all().size).toBe(1)
    expect(store.all().get(first.resourceId)?.ext).toBe('png')
  })

  it('distinguishes different content', () => {
    const store = new ResourceStore()
    const first = store.add(PNG_BYTES, 'png')
    const second = store.add(JPG_BYTES, 'jpg')
    expect(second.resourceId).not.toBe(first.resourceId)
    expect(store.all().size).toBe(2)
  })

  it('purges only unreferenced resources', () => {
    const store = new ResourceStore()
    const used = store.add(PNG_BYTES, 'png').resourceId
    const unused = store.add(JPG_BYTES, 'jpg').resourceId
    const document = documentWithImage(used)
    expect(store.purgeUnused(document)).toBe(1)
    expect(store.all().has(used)).toBe(true)
    expect(store.all().has(unused)).toBe(false)
  })

  it('keeps everything when nothing is unreferenced', () => {
    const store = new ResourceStore()
    const used = store.add(PNG_BYTES, 'png').resourceId
    const document = documentWithImage(used)
    expect(store.purgeUnused(document)).toBe(0)
    expect(store.all().size).toBe(1)
  })

  it('reset replaces the whole store contents', () => {
    const store = new ResourceStore()
    store.add(PNG_BYTES, 'png')
    const nextId = store.add(JPG_BYTES, 'jpg').resourceId
    const next = new Map([[nextId, { bytes: JPG_BYTES, ext: 'jpg' }]])
    store.reset(next)
    expect(store.all().size).toBe(1)
    expect(store.all().has(nextId)).toBe(true)
  })

  it('keeps resources referenced by drawing cells when purging', () => {
    const store = new ResourceStore()
    const cellId = store.add(PNG_BYTES, 'png').resourceId
    const unusedId = store.add(JPG_BYTES, 'jpg').resourceId
    const document = createDocument('test', 100, 100, 24)
    document.layers.push({
      kind: 'drawing',
      id: 'draw',
      name: 'Draw',
      visible: true,
      locked: false,
      resolutionScale: 1,
      cells: [{ frame: 0, resourceId: cellId }]
    })
    expect(store.purgeUnused(document)).toBe(1)
    expect(store.all().has(cellId)).toBe(true)
    expect(store.all().has(unusedId)).toBe(false)
  })
})

describe('extensionOf', () => {
  it('extracts the lowercased extension', () => {
    expect(extensionOf('photo.PNG')).toBe('png')
    expect(extensionOf('/a/b/c.jpeg')).toBe('jpeg')
    expect(extensionOf('noext')).toBe('')
    expect(extensionOf('.hidden')).toBe('')
  })
})
