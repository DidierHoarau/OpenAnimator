import { describe, expect, it } from 'vitest'

import { MAX_SYMBOL_DEPTH, resolveSceneNodes, validateAssetGraph } from './symbols'
import type { Asset, GroupNode, SceneNode, SymbolNode } from './model'

function rect(id: string, x = 0): SceneNode {
  return {
    type: 'primitive',
    primitive: 'rect',
    id,
    center: { x, y: 0 },
    width: 100,
    height: 50,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1
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
    rotation: 15,
    opacity: 0.75,
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
  return { id, name: id, kind: 'symbol', content: contentGroup(children), createdAt: 1 }
}

describe('resolveSceneNodes', () => {
  it('replaces a symbol instance with a group keeping identity and transform', () => {
    const asset = symbolAsset('asset-1', [rect('child', 10)])
    const [resolved] = resolveSceneNodes([symbolNode('s', 'asset-1')], [asset])
    expect(resolved.type).toBe('group')
    const group = resolved as GroupNode
    expect(group.id).toBe('s')
    expect(group.center).toEqual({ x: 40, y: 30 })
    expect(group.width).toBe(200)
    expect(group.height).toBe(100)
    expect(group.rotation).toBe(15)
    expect(group.opacity).toBe(0.75)
    // Children come from the asset content in content-local coordinates.
    expect(group.children).toEqual(asset.content!.children)
  })

  it('keeps the instance name when present', () => {
    const asset = symbolAsset('asset-1', [])
    const [resolved] = resolveSceneNodes([symbolNode('s', 'asset-1', { name: 'Hero' })], [asset])
    expect((resolved as GroupNode).name).toBe('Hero')
  })

  it('passes through primitives and groups untouched (deep-resolving groups)', () => {
    const asset = symbolAsset('asset-1', [rect('inner')])
    const group: GroupNode = {
      type: 'group',
      id: 'g',
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      children: [symbolNode('s', 'asset-1'), rect('r')]
    }
    const [resolved] = resolveSceneNodes([group, rect('p')], [asset])
    expect(resolved.type).toBe('group')
    expect((resolved as GroupNode).children[0].type).toBe('group')
    expect((resolved as GroupNode).children[1].id).toBe('r')
  })

  it('leaves unresolvable instances as placeholders', () => {
    const imageAsset: Asset = { id: 'asset-2', name: 'pic', kind: 'image', resourceId: 'r', createdAt: 1 }
    const nodes = [
      symbolNode('missing', 'nope'),
      symbolNode('not-symbol', 'asset-2'),
      symbolNode('no-content', 'asset-3')
    ]
    const assets = [imageAsset, { id: 'asset-3', name: 'x', kind: 'symbol', createdAt: 1 } as Asset]
    expect(resolveSceneNodes(nodes, assets)).toEqual(nodes)
  })

  it('resolves nested symbols recursively', () => {
    const inner = symbolAsset('inner', [rect('leaf')])
    const outer = symbolAsset('outer', [symbolNode('nested', 'inner')])
    const [resolved] = resolveSceneNodes([symbolNode('s', 'outer')], [inner, outer])
    const outerGroup = resolved as GroupNode
    expect(outerGroup.id).toBe('s')
    expect(outerGroup.children[0].type).toBe('group')
    expect(((outerGroup.children[0] as GroupNode).children[0] as { id: string }).id).toBe('leaf')
  })

  it('terminates on a self-referencing symbol (cycle guard)', () => {
    const cyclic = symbolAsset('cyclic', [symbolNode('s', 'cyclic')])
    const [resolved] = resolveSceneNodes([symbolNode('s', 'cyclic')], [cyclic])
    // The outer instance resolves; its content's self-reference stays a
    // placeholder symbol node.
    expect(resolved.type).toBe('group')
    expect((resolved as GroupNode).children[0].type).toBe('symbol')
  })

  it('resolves a chain up to the depth cap, then leaves placeholders', () => {
    // asset-i references asset-(i+1); the chain is longer than the cap.
    const assets: Asset[] = []
    for (let i = 0; i < MAX_SYMBOL_DEPTH + 3; i++) {
      assets.push(symbolAsset(`asset-${i}`, [symbolNode('nested', `asset-${i + 1}`), rect(`leaf-${i}`)]))
    }
    const [resolved] = resolveSceneNodes([symbolNode('s', 'asset-0')], assets)
    let current = resolved as GroupNode
    let depth = 0
    while (current.type === 'group' && current.children[0].type === 'group') {
      current = current.children[0] as GroupNode
      depth += 1
    }
    // The chain resolves until the depth cap is reached; the node at the cap
    // stays an unresolvable symbol instance.
    expect(depth).toBe(MAX_SYMBOL_DEPTH - 1)
    expect(current.children[0].type).toBe('symbol')
  })

  it('does not mutate the input nodes', () => {
    const asset = symbolAsset('asset-1', [rect('child')])
    const instance = symbolNode('s', 'asset-1')
    const snapshot = structuredClone([instance])
    resolveSceneNodes([instance], [asset])
    expect(structuredClone([instance])).toEqual(snapshot)
  })
})

describe('validateAssetGraph', () => {
  it('accepts a sound graph', () => {
    const inner = symbolAsset('inner', [rect('leaf')])
    const outer = symbolAsset('outer', [symbolNode('s', 'inner')])
    expect(validateAssetGraph([outer, inner])).toBeNull()
    expect(validateAssetGraph([])).toBeNull()
  })

  it('ignores image assets and assets without content', () => {
    const image: Asset = { id: 'img', name: 'img', kind: 'image', resourceId: 'r', createdAt: 1 }
    const bare: Asset = { id: 'bare', name: 'bare', kind: 'symbol', createdAt: 1 }
    expect(validateAssetGraph([image, bare])).toBeNull()
  })

  it('reports a self-cycle with the asset name', () => {
    const cyclic = symbolAsset('cyclic', [symbolNode('s', 'cyclic')])
    expect(validateAssetGraph([cyclic])).toBe('Symbol cycle detected: "cyclic" → "cyclic"')
  })

  it('reports a two-asset cycle naming the loop', () => {
    const a = symbolAsset('a', [symbolNode('s', 'b')])
    const b = symbolAsset('b', [symbolNode('s', 'a')])
    const message = validateAssetGraph([a, b])
    expect(message).toBe('Symbol cycle detected: "a" → "b" → "a"')
  })

  it('reports nesting beyond the depth cap', () => {
    const assets: Asset[] = []
    for (let i = 0; i <= MAX_SYMBOL_DEPTH + 1; i++) {
      assets.push(symbolAsset(`asset-${i}`, [symbolNode('s', `asset-${i + 1}`)]))
    }
    const message = validateAssetGraph(assets)
    expect(message).toContain('exceeds the maximum depth of 16')
    expect(message).toContain('"asset-0"')
  })

  it('labels unknown referenced ids by their id', () => {
    const dangling = symbolAsset('a', [symbolNode('s', 'gone')])
    expect(validateAssetGraph([dangling])).toBeNull()
  })
})
