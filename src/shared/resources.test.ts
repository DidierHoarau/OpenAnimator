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
})
