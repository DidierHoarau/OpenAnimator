import { afterEach, describe, expect, it, vi } from 'vitest'

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
  readonly playbackRate = { value: 1 }
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

/** Systems created by a test; their scrub idle timers are cleared afterwards
 * so no test leaks a pending auto-stop into the next one. */
const systems: AudioSystem[] = []

afterEach(() => {
  for (const system of systems.splice(0)) system.endScrub()
})

function createSystem(overrides: {
  context?: FakeAudioContext | null
  blob?: Blob | null
  scrubIdleSeconds?: number
} = {}) {
  const context = overrides.context === undefined ? new FakeAudioContext() : overrides.context
  const getBlob = vi.fn(() => (overrides.blob === undefined ? new Blob([new Uint8Array([1, 2, 3])]) : overrides.blob))
  const system = new AudioSystem({
    getBlob,
    createContext: () => context as unknown as AudioContext,
    // Effectively disabled by default so only the idle test exercises it.
    scrubIdleSeconds: overrides.scrubIdleSeconds ?? 60
  })
  systems.push(system)
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

  it('opens a scrub session at the clip offset with rate 1', async () => {
    const { context, system } = createSystem()
    const document = audioDoc({ startFrame: 24, volume: 1 })

    // The first call starts the decode; the clip joins the session when it
    // lands (frame 48 is 1s into the clip).
    system.scrub(document, 48, 24)
    await flush()
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].started).toEqual({ when: 0, offset: 1 })
    expect(context.sources[0].playbackRate.value).toBe(1)
    expect(context.sources[0].stoppedAt).toBeNull()
  })

  it('maps scrub velocity onto playbackRate without restarting the clips', async () => {
    const { context, system } = createSystem()
    const document = audioDoc({ startFrame: 0, volume: 1 })
    system.scrub(document, 0, 24)
    await flush()
    expect(context.sources).toHaveLength(1)

    // The first update snaps (rate 1 ran while the pointer was idle): 1 frame
    // in 0.1s at 24fps → 5/12× at the frame's exact offset.
    context.currentTime = 0.1
    system.scrub(document, 1, 24)
    expect(context.sources).toHaveLength(2)
    const clip = context.sources[1]
    expect(clip.playbackRate.value).toBeCloseTo(5 / 12, 6)
    expect(clip.started).toEqual({ when: 0.1, offset: 1 / 24 })

    // From there the running clip tracks the velocity in place — no new
    // sources, just playbackRate.
    context.currentTime = 0.2
    system.scrub(document, 2, 24)
    context.currentTime = 0.3
    system.scrub(document, 3, 24)
    expect(context.sources).toHaveLength(2)
    expect(clip.playbackRate.value).toBeCloseTo(5 / 12, 6)
  })

  it('clamps the mapped rate to 0.25×–4×', async () => {
    const { context, system } = createSystem()
    context.decode = async () => fakeBuffer(30)
    const document = audioDoc({ startFrame: 0, volume: 1 })
    system.scrub(document, 0, 24)
    await flush()

    // 24 frames in 0.5s → 2×.
    context.currentTime = 0.5
    system.scrub(document, 24, 24)
    expect(context.sources.at(-1)?.playbackRate.value).toBe(2)

    // 240 frames in 0.25s → 40× clamps to 4×.
    context.currentTime = 0.75
    system.scrub(document, 264, 24)
    expect(context.sources.at(-1)?.playbackRate.value).toBe(4)

    // 1 frame in 0.5s → ~0.08× clamps to 0.25×.
    context.currentTime = 1.25
    system.scrub(document, 265, 24)
    expect(context.sources.at(-1)?.playbackRate.value).toBe(0.25)
  })

  it('snaps to the exact offset when the audible position drifts over a frame', async () => {
    const { context, system } = createSystem()
    const document = audioDoc({ startFrame: 0, volume: 1 })
    system.scrub(document, 0, 24)
    await flush()
    const first = context.sources[0]

    // Velocity 1× in step with the playhead: no restart, no extra sources.
    context.currentTime = 0.25
    system.scrub(document, 6, 24)
    expect(context.sources).toHaveLength(1)
    expect(first.playbackRate.value).toBe(1)

    // Two seconds later the playhead barely moved: the clamped 0.25× lagged
    // far behind, so the session snaps to frame 7's exact offset.
    context.currentTime = 1.25
    system.scrub(document, 7, 24)
    expect(first.stoppedAt).toBe(1.25)
    const snapped = context.sources.at(-1)!
    expect(snapped.started).toEqual({ when: 1.25, offset: 7 / 24 })
    expect(snapped.playbackRate.value).toBe(0.25)
  })

  it('stays silent outside the clip range', async () => {
    const { context, system } = createSystem()
    const document = audioDoc({ startFrame: 24, volume: 1 })

    system.scrub(document, 0, 24) // before the clip starts
    await flush()
    expect(context.sources).toHaveLength(0)

    context.currentTime = 1
    system.scrub(document, 24 + 48 + 2, 24) // 2 frames past the 2s clip's end
    expect(context.sources).toHaveLength(0)
  })

  it('plays scrub clips at a fraction of the layer volume', async () => {
    const { context, system } = createSystem()
    const document = audioDoc({ startFrame: 0, volume: 0.5 })
    system.scrub(document, 6, 24)
    await flush()
    expect(context.sources[0].connectedGain?.gain.value).toBeCloseTo(0.35 * 0.5, 6)
  })

  it('endScrub stops the session immediately and the next scrub starts fresh', async () => {
    const { context, system } = createSystem()
    const document = audioDoc({ startFrame: 0, volume: 1 })
    system.scrub(document, 12, 24)
    await flush()
    const clip = context.sources[0]
    expect(clip.stoppedAt).toBeNull()

    context.currentTime = 0.3
    system.endScrub()
    expect(clip.stoppedAt).toBe(0.3)
    system.endScrub() // idempotent

    context.sources.length = 0
    system.scrub(document, 12, 24)
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].started).toEqual({ when: 0.3, offset: 0.5 })
  })

  it('auto-stops the session after the idle window', async () => {
    const { context, system } = createSystem({ scrubIdleSeconds: 0.05 })
    const document = audioDoc({ startFrame: 0, volume: 1 })
    system.scrub(document, 6, 24)
    await flush()
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].stoppedAt).toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(context.sources[0].stoppedAt).toBe(0)

    // A later scrub opens a new session from scratch.
    system.scrub(document, 6, 24)
    expect(context.sources).toHaveLength(2)
  })

  it('scrub while playing is ignored, and playback start ends a scrub session', async () => {
    const { context, system } = createSystem()
    const document = audioDoc({ startFrame: 0, volume: 1 })
    system.scrub(document, 6, 24)
    await flush()
    const scrubbed = context.sources[0]

    // Playback start supersedes the paused session.
    context.currentTime = 0.4
    system.start(document, 0, 24)
    expect(scrubbed.stoppedAt).toBe(0.4)

    // While the playback session owns the clock, scrub calls are ignored.
    await flush()
    const playing = context.sources.at(-1)!
    expect(playing.stoppedAt).toBeNull()
    context.currentTime = 1
    system.scrub(document, 24, 24)
    expect(context.sources.at(-1)).toBe(playing)
    expect(playing.stoppedAt).toBeNull()
    expect(playing.playbackRate.value).toBe(1)
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
