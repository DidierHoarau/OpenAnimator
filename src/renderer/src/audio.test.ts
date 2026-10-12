import { describe, expect, it, vi } from 'vitest'

import { createDocument } from '@shared/document'
import type { AnimatorDocument, AudioLayer } from '@shared/model'

import { AudioSystem } from './audio'

class FakeGain {
  readonly gain = { value: 0 }
  connect(): void {}
  disconnect(): void {}
}

class FakeSource {
  buffer: unknown = null
  onended: (() => void) | null = null
  started: { when: number; offset: number } | null = null
  stoppedAt: number | null = null
  connectedGain: FakeGain | null = null

  constructor(private readonly context: FakeAudioContext) {}

  connect(node: FakeGain): void {
    this.connectedGain = node
  }

  disconnect(): void {}

  start(when = 0, offset = 0): void {
    this.started = { when, offset }
  }

  stop(when?: number): void {
    this.stoppedAt = when ?? this.context.currentTime
  }
}

class FakeAudioContext {
  state = 'running'
  currentTime = 0
  readonly destination = {}
  readonly sources: FakeSource[] = []
  readonly resume = vi.fn(() => Promise.resolve())
  decode: (data: ArrayBuffer) => Promise<AudioBuffer> = async () => fakeBuffer(2)

  createBufferSource(): FakeSource {
    const source = new FakeSource(this)
    this.sources.push(source)
    return source
  }

  createGain(): FakeGain {
    return new FakeGain()
  }

  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.decode(data)
  }
}

function fakeBuffer(duration: number, samples = new Float32Array([1, -1, 0.5, -0.25])): AudioBuffer {
  return {
    duration,
    numberOfChannels: 1,
    getChannelData: () => samples
  } as unknown as AudioBuffer
}

function audioDoc(overrides: Partial<AudioLayer> = {}): AnimatorDocument {
  const document = createDocument('test', 960, 540, 24)
  document.layers.push({
    id: 'audio-1',
    kind: 'audio',
    name: 'Score',
    visible: true,
    locked: false,
    resourceId: 'a'.repeat(64),
    startFrame: 0,
    volume: 0.5,
    ...overrides
  })
  return document
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function createSystem(overrides: {
  context?: FakeAudioContext | null
  blob?: Blob | null
  scrubSeconds?: number
} = {}) {
  const context = overrides.context === undefined ? new FakeAudioContext() : overrides.context
  const getBlob = vi.fn(() => (overrides.blob === undefined ? new Blob([new Uint8Array([1, 2, 3])]) : overrides.blob))
  const system = new AudioSystem({
    getBlob,
    createContext: () => context as unknown as AudioContext,
    scrubSeconds: overrides.scrubSeconds
  })
  return { context, system, getBlob }
}

describe('AudioSystem', () => {
  it('schedules the mix on start once the resource decodes', async () => {
    const { context, system } = createSystem()
    const document = audioDoc({ startFrame: 24, volume: 0.5 })

    system.start(document, 0, 24)
    // Still decoding: nothing is scheduled yet.
    expect(context.sources).toHaveLength(0)
    await flush()

    // The decode completion joined the running mix: the clip starts one
    // second in (frame 24 at 24fps).
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].started).toEqual({ when: 1, offset: 0 })
    expect(context.sources[0].connectedGain?.gain.value).toBe(0.5)
  })

  it('offsets the buffer when playback starts inside a clip and re-syncs on seek', async () => {
    const { context, system } = createSystem()
    const document = audioDoc({ startFrame: 24, volume: 1 })
    system.start(document, 0, 24)
    await flush()

    // Seeking to frame 48 lands 24 frames (1s) into the clip: the re-synced
    // source starts immediately with a 1s buffer offset.
    context.currentTime = 0.5
    context.sources.length = 0
    system.sync(document, 48, 24)
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].started).toEqual({ when: 0.5, offset: 1 })
  })

  it('skips a seek past the end of the clip entirely', async () => {
    const { context, system } = createSystem()
    const document = audioDoc({ startFrame: 0, volume: 1 })
    system.start(document, 0, 24)
    await flush()
    context.sources.length = 0

    // The clip is 2s long: frame 96 is 4s in, past its end.
    system.sync(document, 96, 24)
    expect(context.sources).toHaveLength(0)
  })

  it('stop clears the playing clips and sync without a session is a no-op', async () => {
    const { context, system } = createSystem()
    const document = audioDoc()
    system.sync(document, 0, 24)
    expect(context.sources).toHaveLength(0)

    system.start(document, 0, 24)
    await flush()
    const clip = context.sources[0]
    system.stop()
    expect(clip.stoppedAt).toBe(0)
    expect(clip.onended).toBeNull()
    system.stop() // idempotent
  })

  it('stays silent (never throws) without a context or a known resource', async () => {
    const withoutContext = createSystem({ context: null })
    withoutContext.system.start(audioDoc(), 0, 24)
    withoutContext.system.scrub(audioDoc(), 0, 24)
    await flush()
    expect(withoutContext.getBlob).not.toHaveBeenCalled()

    const { context, system } = createSystem({ blob: null })
    system.start(audioDoc(), 0, 24)
    await flush()
    expect(context.sources).toHaveLength(0)
    expect(system.durationSeconds('a'.repeat(64))).toBeNull()
  })

  it('survives undecodable resources with silence', async () => {
    const { context, system } = createSystem()
    context.decode = async () => {
      throw new Error('bad codec')
    }
    system.start(audioDoc(), 0, 24)
    await flush()
    expect(context.sources).toHaveLength(0)
    // The failure is not cached: a later poke retries the decode.
    let attempts = 0
    context.decode = async () => {
      attempts += 1
      throw new Error('still bad')
    }
    system.durationSeconds('a'.repeat(64))
    await flush()
    expect(attempts).toBe(1)
  })

  it('resumes a suspended context on start', async () => {
    const { context, system } = createSystem()
    context.state = 'suspended'
    system.start(audioDoc(), 0, 24)
    expect(context.resume).toHaveBeenCalled()
  })

  it('plays a throttled scrub blip at the clip position while paused', async () => {
    const { context, system } = createSystem({ scrubSeconds: 0.12 })
    const document = audioDoc({ startFrame: 24, volume: 1 })

    // Frame 48 is 1s into the clip; the first scrub only triggers the decode.
    system.scrub(document, 48, 24)
    await flush()
    context.sources.length = 0

    system.scrub(document, 48, 24)
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].started).toEqual({ when: 0, offset: 1 })
    expect(context.sources[0].stoppedAt).toBe(0.12)
    // The blip gain is a fraction of the clip volume.
    expect(context.sources[0].connectedGain?.gain.value).toBeLessThan(1)

    // Throttled: a scrub within the blip length is ignored.
    context.currentTime = 0.05
    system.scrub(document, 48, 24)
    expect(context.sources).toHaveLength(1)

    // After the blip length a new blip fires.
    context.currentTime = 0.2
    system.scrub(document, 48, 24)
    expect(context.sources).toHaveLength(2)

    // Scrubbing before the clip starts plays nothing.
    system.scrub(document, 0, 24)
    expect(context.sources).toHaveLength(2)
  })

  it('reports the decoded duration, memoized peaks, and notifies on decode', async () => {
    const { system } = createSystem()
    const decoded = vi.fn()
    system.onDecoded(decoded)

    expect(system.durationSeconds('a'.repeat(64))).toBeNull()
    await flush()
    expect(decoded).toHaveBeenCalledTimes(1)
    expect(system.durationSeconds('a'.repeat(64))).toBe(2)

    const peaks = system.peaks('a'.repeat(64), 4)
    expect(peaks).toHaveLength(4)
    // Memoized per bucket count, separate grid per count.
    expect(system.peaks('a'.repeat(64), 4)).toBe(peaks)
    expect(system.peaks('a'.repeat(64), 8)).toHaveLength(8)
  })
})
