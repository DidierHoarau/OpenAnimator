import { describe, expect, it } from 'vitest'

import { evaluateDocumentAtFrame } from './render'
import type { AnimatorDocument, Layer, PrimitiveNode } from './model'

function rect(id: string, x: number, overrides: Partial<PrimitiveNode> = {}): PrimitiveNode {
  return {
    type: 'primitive',
    primitive: 'rect',
    id,
    center: { x, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    fill: '#ff0000',
    opacity: 1,
    ...overrides
  }
}

function layer(id: string, overrides: Partial<Layer>): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    keyframes: [],
    ...overrides
  }
}

describe('evaluateDocumentAtFrame', () => {
  it('returns layers in paint order (bottom of the stack first)', () => {
    const doc: AnimatorDocument = {
      schemaVersion: 2,
      name: 't',
      width: 100,
      height: 100,
      fps: 24,
      background: '#000',
      layers: [
        layer('top', { keyframes: [{ frame: 0, nodes: [rect('a', 0)] }] }),
        layer('mid', { keyframes: [{ frame: 0, nodes: [rect('b', 1)] }] }),
        layer('bottom', { keyframes: [{ frame: 0, nodes: [rect('c', 2)] }] })
      ]
    }
    const rendered = evaluateDocumentAtFrame(doc, 0)
    expect(rendered.map((renderLayer) => renderLayer.layerId)).toEqual([
      'bottom',
      'mid',
      'top'
    ])
    expect(rendered.map((renderLayer) => renderLayer.nodes.map((node) => node.id))).toEqual([
      ['c'],
      ['b'],
      ['a']
    ])
  })

  it('skips hidden layers but keeps empty visible ones', () => {
    const doc: AnimatorDocument = {
      schemaVersion: 2,
      name: 't',
      width: 100,
      height: 100,
      fps: 24,
      background: '#000',
      layers: [
        layer('visible-empty', {}),
        layer('hidden', { visible: false, keyframes: [{ frame: 0, nodes: [rect('a', 0)] }] })
      ]
    }
    const rendered = evaluateDocumentAtFrame(doc, 0)
    expect(rendered).toHaveLength(1)
    expect(rendered[0].layerId).toBe('visible-empty')
    expect(rendered[0].nodes).toEqual([])
    expect(rendered[0].name).toBe('visible-empty')
  })

  it('hides a node after its last keyframe (per-object span)', () => {
    const doc: AnimatorDocument = {
      schemaVersion: 2,
      name: 't',
      width: 100,
      height: 100,
      fps: 24,
      background: '#000',
      layers: [
        layer('l', {
          keyframes: [
            { frame: 0, nodes: [rect('a', 0), rect('b', 1)] },
            { frame: 3, nodes: [rect('a', 2)] }
          ]
        })
      ]
    }
    // b's span ends at its keyframe on frame 0, so it is gone from frame 1 on;
    // a holds through.
    expect(evaluateDocumentAtFrame(doc, 0)[0].nodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(evaluateDocumentAtFrame(doc, 1)[0].nodes.map((node) => node.id)).toEqual(['a'])
    expect(evaluateDocumentAtFrame(doc, 2)[0].nodes.map((node) => node.id)).toEqual(['a'])
  })

  it('interpolates a tweened node toward the next keyframe containing it', () => {
    const doc: AnimatorDocument = {
      schemaVersion: 2,
      name: 't',
      width: 100,
      height: 100,
      fps: 24,
      background: '#000',
      layers: [
        layer('l', {
          keyframes: [
            {
              frame: 0,
              nodes: [rect('a', 0)],
              tween: { easing: 'linear' }
            },
            { frame: 10, nodes: [rect('a', 100)] }
          ]
        })
      ]
    }
    const node = evaluateDocumentAtFrame(doc, 5)[0].nodes[0]
    expect(node.id).toBe('a')
    expect(node.center.x).toBeCloseTo(50)
  })

  it('returns an empty tree for a document without layers', () => {
    const doc: AnimatorDocument = {
      schemaVersion: 2,
      name: 't',
      width: 100,
      height: 100,
      fps: 24,
      background: '#000',
      layers: []
    }
    expect(evaluateDocumentAtFrame(doc, 0)).toEqual([])
  })
})
