import { describe, expect, it } from 'vitest'

import { createDocument, createLayer } from './document'
import type { AnimatorDocument, ImageNode, Layer, PrimitiveNode, SceneNode } from './model'
import { collectResourceCounts } from './resources'

function rect(id: string, x = 0): PrimitiveNode {
  return {
    id,
    type: 'primitive',
    primitive: 'rect',
    center: { x, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    fill: '#000000',
    opacity: 1
  }
}

function image(id: string, resourceId: string): ImageNode {
  return {
    id,
    type: 'image',
    resourceId,
    center: { x: 0, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    naturalWidth: 10,
    naturalHeight: 10,
    smoothing: true
  }
}

function documentWithLayers(layers: Layer[]): AnimatorDocument {
  const document = createDocument('test', 960, 540, 24)
  document.layers = layers
  return document
}

describe('collectResourceCounts', () => {
  it('returns an empty map for a document without images', () => {
    const document = documentWithLayers([createLayer('Layer 1')])
    expect(collectResourceCounts(document)).toEqual(new Map())
  })

  it('counts image nodes across layers and keyframes', () => {
    const a = createLayer('A')
    a.keyframes.push({ frame: 0, nodes: [image('img-1', 'hash-a'), rect('r-1')] })
    const b = createLayer('B')
    b.keyframes.push({ frame: 0, nodes: [image('img-2', 'hash-a')] })
    b.keyframes.push({ frame: 4, nodes: [image('img-3', 'hash-b')] })
    const counts = collectResourceCounts(documentWithLayers([a, b]))
    expect(counts.get('hash-a')).toBe(2)
    expect(counts.get('hash-b')).toBe(1)
    expect(counts.size).toBe(2)
  })

  it('recurses into group children', () => {
    const layer = createLayer('A')
    const group: SceneNode = {
      id: 'g-1',
      type: 'group',
      center: { x: 0, y: 0 },
      width: 20,
      height: 20,
      rotation: 0,
      opacity: 1,
      children: [image('img-1', 'hash-a'), { ...image('img-2', 'hash-b') }]
    }
    layer.keyframes.push({ frame: 0, nodes: [group, image('img-3', 'hash-a')] })
    const counts = collectResourceCounts(documentWithLayers([layer]))
    expect(counts.get('hash-a')).toBe(2)
    expect(counts.get('hash-b')).toBe(1)
  })

  it('does not double-count hold-through content (stored once per keyframe)', () => {
    const layer = createLayer('A')
    layer.keyframes.push({ frame: 0, nodes: [image('img-1', 'hash-a')] })
    layer.keyframes.push({ frame: 4, nodes: [image('img-1', 'hash-a')] })
    const counts = collectResourceCounts(documentWithLayers([layer]))
    expect(counts.get('hash-a')).toBe(2)
  })

  it('counts resources referenced by document assets', () => {
    const document = documentWithLayers([createLayer('A')])
    document.assets = [
      { id: 'a', name: 'pic', kind: 'image', resourceId: 'hash-a', createdAt: 1 },
      {
        id: 'b',
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
          children: [image('inner-1', 'hash-b'), { ...image('inner-2', 'hash-a') }]
        },
        createdAt: 1
      }
    ]
    const counts = collectResourceCounts(document)
    // hash-a is referenced twice: once by the image asset, once inside the
    // symbol content.
    expect(counts.get('hash-a')).toBe(2)
    expect(counts.get('hash-b')).toBe(1)
  })

  it('follows nested symbol references inside assets without double-counting', () => {
    const document = documentWithLayers([createLayer('A')])
    document.assets = [
      {
        id: 'inner',
        name: 'inner',
        kind: 'symbol',
        content: {
          type: 'group',
          id: 'c1',
          center: { x: 0, y: 0 },
          width: 10,
          height: 10,
          rotation: 0,
          opacity: 1,
          children: [image('i', 'hash-inner')]
        },
        createdAt: 1
      },
      {
        id: 'outer',
        name: 'outer',
        kind: 'symbol',
        content: {
          type: 'group',
          id: 'c2',
          center: { x: 0, y: 0 },
          width: 10,
          height: 10,
          rotation: 0,
          opacity: 1,
          children: [
            { id: 's', type: 'symbol', assetId: 'inner', center: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0, opacity: 1 }
          ]
        },
        createdAt: 1
      }
    ]
    const counts = collectResourceCounts(document)
    // Both assets reference hash-inner: the inner asset owns it, the outer
    // asset references it through the nested symbol instance.
    expect(counts.get('hash-inner')).toBe(2)
  })

  it('terminates on a cyclic asset graph', () => {
    const document = documentWithLayers([createLayer('A')])
    document.assets = [
      {
        id: 'cyclic',
        name: 'cyclic',
        kind: 'symbol',
        content: {
          type: 'group',
          id: 'c',
          center: { x: 0, y: 0 },
          width: 10,
          height: 10,
          rotation: 0,
          opacity: 1,
          children: [{ id: 's', type: 'symbol', assetId: 'cyclic', center: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0, opacity: 1 }]
        },
        createdAt: 1
      }
    ]
    expect(collectResourceCounts(document)).toEqual(new Map())
  })
})
