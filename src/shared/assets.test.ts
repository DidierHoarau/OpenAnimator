import { describe, expect, it } from 'vitest'

import {
  assetNaturalSize,
  collectAssetResourceIds,
  countAssetInstances,
  createDocumentAsset,
  duplicateAsset,
  instanceToGroup,
  symbolContentFromGroup
} from './assets'
import { createDocument, createLayer } from './document'
import { groupNodes } from './groups'
import type { Asset, GroupNode, ImageNode, PrimitiveNode, SceneNode, SymbolNode } from './model'

function rect(id: string, x = 0, y = 0): PrimitiveNode {
  return {
    type: 'primitive',
    primitive: 'rect',
    id,
    center: { x, y },
    width: 100,
    height: 50,
    rotation: 0,
    fill: '#ff0000',
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

function symbolNode(id: string, assetId: string, overrides: Partial<SymbolNode> = {}): SymbolNode {
  return {
    id,
    type: 'symbol',
    assetId,
    center: { x: 40, y: 30 },
    width: 200,
    height: 100,
    rotation: 0,
    opacity: 1,
    ...overrides
  }
}

function contentGroup(children: SceneNode[]): GroupNode {
  return {
    type: 'group',
    id: 'content',
    center: { x: 0, y: 0 },
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    children
  }
}

function symbolAsset(id: string, children: SceneNode[]): Asset {
  return {
    id,
    name: id,
    kind: 'symbol',
    content: contentGroup(children),
    createdAt: 1
  }
}

function imageAsset(id: string, resourceId: string): Asset {
  return { id, name: id, kind: 'image', resourceId, naturalWidth: 4, naturalHeight: 3, createdAt: 1 }
}

describe('createDocumentAsset', () => {
  it('assigns a fresh asset id and creation timestamp', () => {
    const asset = createDocumentAsset({ name: 'Rocket', kind: 'symbol', content: contentGroup([]) })
    expect(asset.id).toMatch(/^asset-/)
    expect(typeof asset.createdAt).toBe('number')
    expect(asset.name).toBe('Rocket')
    expect(asset.kind).toBe('symbol')
    expect(asset.content).toEqual(contentGroup([]))
  })

  it('generates distinct ids for successive calls', () => {
    const a = createDocumentAsset({ name: 'a', kind: 'image', resourceId: 'r' })
    const b = createDocumentAsset({ name: 'b', kind: 'image', resourceId: 'r' })
    expect(a.id).not.toBe(b.id)
  })
})

describe('duplicateAsset', () => {
  it('deep-clones the content under a new identity', () => {
    const original = symbolAsset('a', [rect('child')])
    const copy = duplicateAsset(original, 'b', 'a copy')
    expect(copy.id).toBe('b')
    expect(copy.name).toBe('a copy')
    expect(copy.kind).toBe('symbol')
    expect(copy.content).toEqual(original.content)
    expect(copy.content).not.toBe(original.content)
    expect(copy.createdAt).toBeGreaterThanOrEqual(original.createdAt)
  })

  it('mutating the copy never touches the original', () => {
    const original = symbolAsset('a', [rect('child')])
    const snapshot = structuredClone(original)
    const copy = duplicateAsset(original, 'b', 'copy')
    ;(copy.content!.children[0] as PrimitiveNode).fill = '#00ff00'
    copy.name = 'mutated'
    expect(original).toEqual(snapshot)
  })
})

describe('assetNaturalSize', () => {
  it('returns the symbol content bounds', () => {
    const group = groupNodes([rect('a', 0, 0), rect('b', 200, 0)], 'g')
    const asset = createDocumentAsset({ name: 's', kind: 'symbol', content: group })
    // The two 100x50 rects span x -50…250, y -25…25.
    expect(assetNaturalSize(asset)).toEqual({ width: 300, height: 50 })
  })

  it('returns the image intrinsic size, 0×0 when unknown', () => {
    expect(assetNaturalSize(imageAsset('a', 'r'))).toEqual({ width: 4, height: 3 })
    expect(assetNaturalSize({ ...imageAsset('a', 'r'), naturalWidth: undefined, naturalHeight: undefined })).toEqual({
      width: 0,
      height: 0
    })
  })

  it('returns 0×0 for a symbol without content', () => {
    const asset: Asset = { id: 'a', name: 'a', kind: 'symbol', createdAt: 1 }
    expect(assetNaturalSize(asset)).toEqual({ width: 0, height: 0 })
  })
})

describe('countAssetInstances', () => {
  it('counts symbol nodes across layers and keyframes, recursing groups', () => {
    const document = createDocument('t', 960, 540, 24)
    const layerA = createLayer('A')
    layerA.keyframes.push({ frame: 0, nodes: [symbolNode('s1', 'asset-1')] })
    layerA.keyframes.push({ frame: 4, nodes: [symbolNode('s2', 'asset-1'), symbolNode('s3', 'asset-2')] })
    const layerB = createLayer('B')
    layerB.keyframes.push({
      frame: 0,
      nodes: [
        {
          id: 'g',
          type: 'group',
          center: { x: 0, y: 0 },
          width: 10,
          height: 10,
          rotation: 0,
          opacity: 1,
          children: [symbolNode('s4', 'asset-1'), rect('r')]
        }
      ]
    })
    document.layers = [layerA, layerB]
    expect(countAssetInstances(document, 'asset-1')).toBe(3)
    expect(countAssetInstances(document, 'asset-2')).toBe(1)
    expect(countAssetInstances(document, 'asset-missing')).toBe(0)
  })
})

describe('collectAssetResourceIds', () => {
  it('returns the image asset resource', () => {
    expect(collectAssetResourceIds(imageAsset('a', 'hash-a'))).toEqual(['hash-a'])
  })

  it('collects the images inside symbol content, recursing groups', () => {
    const asset = symbolAsset('a', [
      image('i1', 'hash-a'),
      {
        id: 'g',
        type: 'group',
        center: { x: 0, y: 0 },
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1,
        children: [image('i2', 'hash-b'), rect('r')]
      }
    ])
    expect(collectAssetResourceIds(asset).sort()).toEqual(['hash-a', 'hash-b'])
  })

  it('follows nested symbol instances through the context assets', () => {
    const inner = symbolAsset('inner', [image('i1', 'hash-inner')])
    const outer = symbolAsset('outer', [symbolNode('s', 'inner'), image('i2', 'hash-own')])
    expect(collectAssetResourceIds(outer, [inner, outer]).sort()).toEqual(['hash-inner', 'hash-own'])
  })

  it('terminates on a self-referencing symbol graph', () => {
    const cyclic = symbolAsset('cyclic', [symbolNode('s', 'cyclic'), image('i', 'hash-a')])
    expect(collectAssetResourceIds(cyclic, [cyclic])).toEqual(['hash-a'])
  })

  it('returns nothing for a symbol without content or images', () => {
    const empty: Asset = { id: 'a', name: 'a', kind: 'symbol', content: contentGroup([]), createdAt: 1 }
    const bare: Asset = { id: 'b', name: 'b', kind: 'symbol', createdAt: 1 }
    expect(collectAssetResourceIds(empty)).toEqual([])
    expect(collectAssetResourceIds(bare)).toEqual([])
  })
})

describe('symbolContentFromGroup', () => {
  it('centers the content box on the origin at the natural size', () => {
    const group = groupNodes([rect('a', 0, 0), rect('b', 200, 0)], 'g')
    const content = symbolContentFromGroup(group)
    expect(content.center).toEqual({ x: 0, y: 0 })
    expect(content.width).toBe(300)
    expect(content.height).toBe(50)
    expect(content.rotation).toBe(0)
    expect(content.opacity).toBe(1)
    // Children keep their content-local coordinates.
    expect(content.children.map((child) => child.id)).toEqual(['a', 'b'])
  })
})

describe('instanceToGroup', () => {
  it('keeps the instance transform and deep-clones the content children', () => {
    const content = contentGroup([rect('child', 10, 20)])
    const instance = symbolNode('s', 'a', { name: 'Hero', rotation: 30, opacity: 0.5 })
    const group = instanceToGroup(instance, content, 'g-new')
    expect(group.type).toBe('group')
    expect(group.id).toBe('g-new')
    expect(group.name).toBe('Hero')
    expect(group.center).toEqual({ x: 40, y: 30 })
    expect(group.width).toBe(200)
    expect(group.height).toBe(100)
    expect(group.rotation).toBe(30)
    expect(group.opacity).toBe(0.5)
    expect(group.children).toEqual(content.children)
    expect(group.children[0]).not.toBe(content.children[0])
  })

  it('omits the name when the instance has none', () => {
    const group = instanceToGroup(symbolNode('s', 'a'), contentGroup([]), 'g')
    expect('name' in group).toBe(false)
  })
})
