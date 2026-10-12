import { describe, expect, it } from 'vitest'

import { shareSnapshot } from './shareSnapshot'

interface TestNode {
  id: string
  center: { x: number; y: number }
}

interface TestLayer {
  id: string
  nodes: TestNode[]
}

interface TestDoc {
  name: string
  layers: TestLayer[]
}

function makeDoc(): TestDoc {
  return {
    name: 'doc-1',
    layers: [
      {
        id: 'l1',
        nodes: [
          { id: 'n1', center: { x: 0, y: 0 } },
          { id: 'n2', center: { x: 1, y: 1 } }
        ]
      },
      { id: 'l2', nodes: [{ id: 'n3', center: { x: 2, y: 2 } }] }
    ]
  }
}

describe('shareSnapshot', () => {
  it('produces a full independent copy without a previous snapshot', () => {
    const live = makeDoc()
    const snapshot = shareSnapshot(live, null)
    expect(snapshot).toEqual(structuredClone(live))
    expect(snapshot).not.toBe(live)
    expect(snapshot.layers).not.toBe(live.layers)
    expect(snapshot.layers[0]).not.toBe(live.layers[0])
    expect(snapshot.layers[0].nodes[0]).not.toBe(live.layers[0].nodes[0])
    expect(snapshot.layers[0].nodes[0].center).not.toBe(live.layers[0].nodes[0].center)
  })

  it('reuses unchanged subtrees and rebuilds only the changed path', () => {
    const v1 = makeDoc()
    const s1 = shareSnapshot(v1, null)
    const v2 = structuredClone(v1)
    v2.layers[0].nodes[0].center.x = 5

    const s2 = shareSnapshot(v2, s1)
    // Oracle: values are exactly a full clone of the live document.
    expect(s2).toEqual(structuredClone(v2))
    // The untouched layer, and the untouched sibling node inside the changed
    // layer, are shared with the previous snapshot by reference.
    expect(s2.layers[1]).toBe(s1.layers[1])
    expect(s2.layers[0].nodes[1]).toBe(s1.layers[0].nodes[1])
    // The changed path is rebuilt and never aliases the live document.
    expect(s2.layers[0]).not.toBe(s1.layers[0])
    expect(s2.layers[0].nodes[0]).not.toBe(v2.layers[0].nodes[0])
    expect(s2.layers[0].nodes[0].center).not.toBe(v2.layers[0].nodes[0].center)
  })

  it('never aliases the live document', () => {
    const live = makeDoc()
    const snapshot = shareSnapshot(live, null)
    live.name = 'renamed'
    live.layers[0].nodes[0].center.x = 999
    live.layers[0].nodes.push({ id: 'n9', center: { x: 9, y: 9 } })

    expect(snapshot.name).toBe('doc-1')
    expect(snapshot.layers[0].nodes[0].center.x).toBe(0)
    expect(snapshot.layers[0].nodes).toHaveLength(2)
  })

  it('shares across a chain of consecutive snapshots', () => {
    const v1 = makeDoc()
    const s1 = shareSnapshot(v1, null)
    const v2 = structuredClone(v1)
    v2.layers[0].nodes[0].center.x = 1
    const s2 = shareSnapshot(v2, s1)
    const v3 = structuredClone(v2)
    v3.layers[1].nodes[0].center.y = 20
    const s3 = shareSnapshot(v3, s2)

    expect(s3).toEqual(structuredClone(v3))
    // Only layer 1 changed in v3: layer 0 (and its unchanged node) is shared
    // all the way back through the chain.
    expect(s3.layers[1]).not.toBe(s2.layers[1])
    expect(s3.layers[0]).toBe(s2.layers[0])
    expect(s3.layers[0].nodes[1]).toBe(s1.layers[0].nodes[1])
    expect(s3.layers[0].nodes[0]).toBe(s2.layers[0].nodes[0])
    // Mutating the live v3 still cannot reach any snapshot.
    v3.layers[0].nodes[1].center.x = 77
    expect(s3.layers[0].nodes[1].center.x).toBe(1)
    expect(s1.layers[0].nodes[1].center.x).toBe(1)
  })

  it('handles grown and shrunk arrays', () => {
    const v1 = makeDoc()
    const s1 = shareSnapshot(v1, null)
    const v2 = structuredClone(v1)
    v2.layers[0].nodes.pop()
    v2.layers.push({ id: 'l3', nodes: [{ id: 'n4', center: { x: 4, y: 4 } }] })

    const s2 = shareSnapshot(v2, s1)
    expect(s2).toEqual(structuredClone(v2))
    // The surviving entry of the changed array is still shared.
    expect(s2.layers[0].nodes[0]).toBe(s1.layers[0].nodes[0])
    expect(s2.layers[1]).toBe(s1.layers[1])
  })

  it('rebuilds when a value changes type', () => {
    const v1 = { v: [1, 2] as unknown }
    const s1 = shareSnapshot(v1, null)
    const v2 = { v: { a: 1 } as unknown }
    const s2 = shareSnapshot(v2, s1)
    expect(s2).toEqual(structuredClone(v2))
    expect(s2.v).not.toBe(s1.v)
  })

  it('keeps a __proto__ data key as an own property without polluting prototypes', () => {
    const live = JSON.parse('{"__proto__": {"polluted": true}, "name": "x"}') as Record<
      string,
      unknown
    >
    const snapshot = shareSnapshot(live, null)
    expect(Object.prototype.hasOwnProperty.call(snapshot, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    expect(snapshot).toEqual(live)
  })
})
