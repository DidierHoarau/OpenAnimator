import { describe, expect, it } from 'vitest'

import { EvaluationCache } from './renderCache'
import type { EvaluatedFrame } from './render'

function frame(): EvaluatedFrame {
  return { layers: [], camera: null }
}

describe('EvaluationCache', () => {
  it('stores and returns document frames with hit/miss stats', () => {
    const cache = new EvaluationCache()
    const evaluated = frame()
    expect(cache.getDocument(3)).toBeNull()
    cache.setDocument(3, evaluated)
    expect(cache.getDocument(3)).toBe(evaluated)
    expect(cache.stats).toEqual({ hits: 1, misses: 1 })
  })

  it('stores layer entries per (layer, frame) key', () => {
    const cache = new EvaluationCache()
    const nodes = [{ id: 'a' }] as unknown as EvaluatedFrame['layers'][0]['nodes']
    cache.setLayer('layer-1', 0, nodes)
    expect(cache.getLayer('layer-1', 0)).toBe(nodes)
    expect(cache.getLayer('layer-1', 1)).toBeNull()
    expect(cache.getLayer('layer-2', 0)).toBeNull()
  })

  it('replaces the entry when the same key is set again', () => {
    const cache = new EvaluationCache()
    const first = frame()
    const second = frame()
    cache.setDocument(0, first)
    cache.setDocument(0, second)
    expect(cache.getDocument(0)).toBe(second)
  })

  it('evicts the least recently used entries beyond the capacity', () => {
    const cache = new EvaluationCache(3)
    cache.setDocument(0, frame())
    cache.setDocument(1, frame())
    cache.setDocument(2, frame())
    // Touch 0 so 1 becomes the least recently used.
    expect(cache.getDocument(0)).not.toBeNull()
    cache.setDocument(3, frame())
    expect(cache.getDocument(1)).toBeNull()
    expect(cache.getDocument(0)).not.toBeNull()
    expect(cache.getDocument(3)).not.toBeNull()
  })

  it('bounds the layer entries and clears both maps', () => {
    const cache = new EvaluationCache(2)
    const nodes = [] as unknown as EvaluatedFrame['layers'][0]['nodes']
    cache.setLayer('a', 0, nodes)
    cache.setLayer('b', 0, nodes)
    cache.setLayer('c', 0, nodes)
    expect(cache.getLayer('a', 0)).toBeNull()
    expect(cache.getLayer('c', 0)).toBe(nodes)

    cache.setDocument(0, frame())
    cache.clear()
    expect(cache.getLayer('b', 0)).toBeNull()
    expect(cache.getDocument(0)).toBeNull()
  })
})
