import type { EvaluatedFrame, RenderLayer } from './render'

/**
 * Bounded LRU cache of evaluated render results, keyed by (layer, frame) and
 * by document frame. One staged render pass evaluates the current frame once
 * and reuses the result for onion ghosts, the selection overlay and repeated
 * frames (playback loops, hold steps); the stage clears it on every document
 * change, so a cached value can never be read after an unnotified mutation.
 *
 * Cached items alias the evaluated document nodes exactly like uncached reads
 * within one pass do; callers must treat them as read-only.
 */
export class EvaluationCache {
  private readonly capacity: number
  private readonly documentEntries = new Map<number, EvaluatedFrame>()
  private readonly layerEntries = new Map<string, RenderLayer['nodes']>()
  private hitCount = 0
  private missCount = 0

  constructor(capacity = 24) {
    this.capacity = capacity
  }

  get stats(): { hits: number; misses: number } {
    return { hits: this.hitCount, misses: this.missCount }
  }

  getDocument(frame: number): EvaluatedFrame | null {
    const entry = this.documentEntries.get(frame)
    if (!entry) {
      this.missCount += 1
      return null
    }
    // LRU touch: re-insert so the least recently used entry drops first.
    this.documentEntries.delete(frame)
    this.documentEntries.set(frame, entry)
    this.hitCount += 1
    return entry
  }

  setDocument(frame: number, evaluated: EvaluatedFrame): void {
    this.documentEntries.delete(frame)
    this.documentEntries.set(frame, evaluated)
    this.evictOldest(this.documentEntries)
  }

  getLayer(layerId: string, frame: number): RenderLayer['nodes'] | null {
    const key = `${layerId}:${frame}`
    const entry = this.layerEntries.get(key)
    if (!entry) {
      this.missCount += 1
      return null
    }
    this.layerEntries.delete(key)
    this.layerEntries.set(key, entry)
    this.hitCount += 1
    return entry
  }

  setLayer(layerId: string, frame: number, nodes: RenderLayer['nodes']): void {
    const key = `${layerId}:${frame}`
    this.layerEntries.delete(key)
    this.layerEntries.set(key, nodes)
    this.evictOldest(this.layerEntries)
  }

  clear(): void {
    this.documentEntries.clear()
    this.layerEntries.clear()
  }

  private evictOldest<T>(entries: Map<unknown, T>): void {
    while (entries.size > this.capacity) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) return
      entries.delete(oldest)
    }
  }
}
