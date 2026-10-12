import { describe, expect, it } from 'vitest'

import { audioMixPlan, downsamplePeaks } from './audio'
import type { AnimatorDocument, AudioLayer } from './model'

function audioLayer(id: string, overrides: Partial<AudioLayer> = {}): AudioLayer {
  return {
    kind: 'audio',
    id,
    name: id,
    visible: true,
    locked: false,
    resourceId: `res-${id}`,
    startFrame: 0,
    volume: 1,
    ...overrides
  }
}

function doc(layers: AnimatorDocument['layers'], fps = 24): AnimatorDocument {
  return {
    schemaVersion: 7,
    name: 't',
    width: 100,
    height: 100,
    fps,
    background: '#000',
    palette: [],
    assets: [],
    fonts: [],
    layers
  }
}

describe('audioMixPlan', () => {
  it('plans every audible clip in layer order', () => {
    const document = doc([
      audioLayer('a', { startFrame: 0, volume: 1 }),
      {
        kind: 'object',
        id: 'o',
        name: 'o',
        visible: true,
        locked: false,
        keyframes: []
      },
      audioLayer('b', { startFrame: 12, volume: 0.5 })
    ])
    expect(audioMixPlan(document)).toEqual([
      { resourceId: 'res-a', startFrame: 0, startSeconds: 0, volume: 1 },
      { resourceId: 'res-b', startFrame: 12, startSeconds: 0.5, volume: 0.5 }
    ])
  })

  it('skips muted (hidden) and zero-volume layers', () => {
    const document = doc([
      audioLayer('a', { visible: false }),
      audioLayer('b', { volume: 0 }),
      audioLayer('c', { volume: 0.25 })
    ])
    expect(audioMixPlan(document).map((entry) => entry.resourceId)).toEqual(['res-c'])
  })

  it('converts frames with the passed fps (exports may retime)', () => {
    const document = doc([audioLayer('a', { startFrame: 30 })], 30)
    expect(audioMixPlan(document)[0].startSeconds).toBe(1)
    // The export fps wins over the document fps.
    expect(audioMixPlan(document, { fps: 15 })[0].startSeconds).toBe(2)
  })

  it('measures startSeconds from the range start and goes negative for earlier clips', () => {
    const document = doc([audioLayer('a', { startFrame: 48 })])
    expect(audioMixPlan(document, { fromFrame: 24 })[0].startSeconds).toBe(1)
    // A clip that began before the range reports the seek offset as negative.
    const early = doc([audioLayer('b', { startFrame: 12 })])
    expect(audioMixPlan(early, { fromFrame: 24 })[0].startSeconds).toBe(-0.5)
  })

  it('returns an empty plan without audio layers', () => {
    expect(audioMixPlan(doc([]))).toEqual([])
  })
})

describe('downsamplePeaks', () => {
  it('reports one min/max pair per bucket over the channel', () => {
    const channel = new Float32Array([1, -1, 0.5, -0.25, 0, 0.75, -0.5, 0.125])
    const buckets = downsamplePeaks([channel], 4)
    expect(buckets).toEqual([
      { min: -1, max: 1 },
      { min: -0.25, max: 0.5 },
      { min: 0, max: 0.75 },
      { min: -0.5, max: 0.125 }
    ])
  })

  it('merges channels per bucket (min of mins, max of maxes)', () => {
    const left = new Float32Array([0.5, 0.5])
    const right = new Float32Array([-0.5, -0.5])
    expect(downsamplePeaks([left, right], 2)).toEqual([
      { min: -0.5, max: 0.5 },
      { min: -0.5, max: 0.5 }
    ])
  })

  it('uses the longest channel as the sampling grid', () => {
    const long = new Float32Array([1, 1, 1, 1])
    const short = new Float32Array([-1, -1])
    // Buckets 3–4 fall past the short channel: only the long one contributes.
    expect(downsamplePeaks([long, short], 4)).toEqual([
      { min: -1, max: 1 },
      { min: -1, max: 1 },
      { min: 1, max: 1 },
      { min: 1, max: 1 }
    ])
  })

  it('returns flat zero buckets for empty input', () => {
    expect(downsamplePeaks([], 3)).toEqual([
      { min: 0, max: 0 },
      { min: 0, max: 0 },
      { min: 0, max: 0 }
    ])
    expect(downsamplePeaks([new Float32Array()], 2)).toEqual([
      { min: 0, max: 0 },
      { min: 0, max: 0 }
    ])
  })

  it('coerces at least one bucket', () => {
    expect(downsamplePeaks([new Float32Array([0.5, -0.5])], 0)).toEqual([
      { min: -0.5, max: 0.5 }
    ])
  })
})
