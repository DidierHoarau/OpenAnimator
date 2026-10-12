// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ExportOptions } from '@shared/exportOptions'

import { CanceledError, canEncodeVideo, encodeVideo } from './videoEncoder'

interface FakeCanvasSource {
  canvas: unknown
  options: unknown
  added: Array<{ when: number; duration: number }>
  add(when: number, duration: number): Promise<void>
}

interface FakeAudioSource {
  options: unknown
  buffers: unknown[]
  closed: boolean
  add(buffer: unknown): Promise<void>
  close(): void
}

interface FakeOutput {
  format: unknown
  target: { buffer: ArrayBuffer | null }
  videoTracks: Array<{ source: FakeCanvasSource; options: unknown }>
  audioTracks: FakeAudioSource[]
  started: boolean
  finalized: boolean
  canceled: boolean
  addVideoTrack(source: FakeCanvasSource, options: unknown): void
  addAudioTrack(source: FakeAudioSource): void
  start(): Promise<void>
  finalize(): Promise<void>
  cancel(): Promise<void>
}

/**
 * Stubbed mediabunny: the encode pipeline runs against fake container/source
 * classes so the video and audio track wiring can be asserted without any
 * WebCodecs implementation in the test environment.
 */
const mediabunny = vi.hoisted(() => {
  const state = {
    videoCodecs: [] as Array<string | null>,
    audioCodecs: [] as Array<string | null>,
    outputs: [] as FakeOutput[],
    videoCodecQueries: [] as Array<{ codecs: string[]; options: unknown }>,
    audioCodecQueries: [] as string[][],
    alphaProbes: [] as Array<{ codec: string; options: unknown }>,
    alphaProbeResults: [] as boolean[]
  }

  class BufferTarget {
    buffer: ArrayBuffer | null = null
  }

  class CanvasSource implements FakeCanvasSource {
    added: Array<{ when: number; duration: number }> = []
    constructor(
      public canvas: unknown,
      public options: unknown
    ) {}
    async add(when: number, duration: number): Promise<void> {
      this.added.push({ when, duration })
    }
  }

  class AudioBufferSource implements FakeAudioSource {
    buffers: unknown[] = []
    closed = false
    constructor(public options: unknown) {}
    async add(buffer: unknown): Promise<void> {
      this.buffers.push(buffer)
    }
    close(): void {
      this.closed = true
    }
  }

  class Output implements FakeOutput {
    videoTracks: Array<{ source: FakeCanvasSource; options: unknown }> = []
    audioTracks: FakeAudioSource[] = []
    started = false
    finalized = false
    canceled = false
    format: unknown
    target: BufferTarget
    constructor(init: { format: unknown; target: BufferTarget }) {
      this.format = init.format
      this.target = init.target
      state.outputs.push(this)
    }
    addVideoTrack(source: FakeCanvasSource, options: unknown): void {
      this.videoTracks.push({ source, options })
    }
    addAudioTrack(source: FakeAudioSource): void {
      this.audioTracks.push(source)
    }
    async start(): Promise<void> {
      this.started = true
    }
    async finalize(): Promise<void> {
      this.finalized = true
      this.target.buffer = new Uint8Array([1, 2, 3, 4]).buffer
    }
    async cancel(): Promise<void> {
      this.canceled = true
    }
  }

  class WebMOutputFormat {}
  class Mp4OutputFormat {}

  return {
    state,
    BufferTarget,
    CanvasSource,
    AudioBufferSource,
    Output,
    WebMOutputFormat,
    Mp4OutputFormat,
    QUALITY_HIGH: 'high',
    getFirstEncodableVideoCodec: vi.fn(
      async (codecs: string[], options: unknown): Promise<string | null> => {
        state.videoCodecQueries.push({ codecs, options })
        return state.videoCodecs.shift() ?? null
      }
    ),
    getFirstEncodableAudioCodec: vi.fn(async (codecs: string[]): Promise<string | null> => {
      state.audioCodecQueries.push(codecs)
      return state.audioCodecs.shift() ?? null
    }),
    canEncodeVideo: vi.fn(async (codec: string, options: unknown): Promise<boolean> => {
      state.alphaProbes.push({ codec, options })
      return state.alphaProbeResults.shift() ?? false
    })
  }
})

vi.mock('mediabunny', () => mediabunny)

const SIZE = { width: 320, height: 180 }

function options(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return {
    format: 'webm',
    scale: 1,
    fps: 24,
    fromFrame: 0,
    toFrame: 2,
    transparent: false,
    ...overrides
  }
}

const mix = (): AudioBuffer => ({ duration: 0.5 }) as unknown as AudioBuffer

describe('video encoder environment', () => {
  it('reports that video encoding is unavailable without WebCodecs', () => {
    // happy-dom (and the headless CLI) have no WebCodecs; the Electron
    // renderer does. The runner refuses video exports with a clear error
    // instead of failing mid-encode.
    expect(canEncodeVideo()).toBe(false)
  })

  it('exposes a distinct cancellation error', () => {
    const error = new CanceledError()
    expect(error.name).toBe('CanceledError')
    expect(error.message).toContain('canceled')
  })
})

describe('encodeVideo', () => {
  beforeEach(() => {
    mediabunny.state.videoCodecs = ['vp9']
    mediabunny.state.audioCodecs = ['opus']
    mediabunny.state.outputs.length = 0
    mediabunny.state.videoCodecQueries.length = 0
    mediabunny.state.audioCodecQueries.length = 0
    mediabunny.state.alphaProbes.length = 0
    mediabunny.state.alphaProbeResults.length = 0
    mediabunny.getFirstEncodableVideoCodec.mockClear()
    mediabunny.getFirstEncodableAudioCodec.mockClear()
    mediabunny.canEncodeVideo.mockClear()
  })

  it('adds the audio mix as a track and draws every frame of the range', async () => {
    const drawFrame = vi.fn()
    const buffer = mix()
    const result = await encodeVideo(options(), SIZE, drawFrame, { canceled: false }, { buffer })

    expect(result.audioIncluded).toBe(true)
    expect(result.bytes.length).toBeGreaterThan(0)
    const output = mediabunny.state.outputs.at(-1)!
    expect(output.started).toBe(true)
    expect(output.finalized).toBe(true)
    expect(output.videoTracks).toHaveLength(1)
    expect(output.videoTracks[0].options).toEqual({ frameRate: 24 })
    expect(output.videoTracks[0].source.added).toHaveLength(3)
    expect(output.audioTracks).toHaveLength(1)
    expect(output.audioTracks[0].buffers).toEqual([buffer])
    expect(output.audioTracks[0].closed).toBe(true)
    expect(drawFrame.mock.calls.map((call) => call[1])).toEqual([0, 1, 2])
  })

  it('encodes transparent WebM with the VP9 alpha encoder when available', async () => {
    mediabunny.state.alphaProbeResults = [true]
    const result = await encodeVideo(options({ transparent: true }), SIZE, vi.fn(), {
      canceled: false
    })

    expect(result.alphaIncluded).toBe(true)
    expect(mediabunny.state.alphaProbes.at(-1)).toEqual({
      codec: 'vp9',
      options: { width: 320, height: 180, alpha: 'keep' }
    })
    expect(mediabunny.state.outputs.at(-1)!.videoTracks[0].source.options).toEqual({
      codec: 'vp9',
      quality: 'high',
      alpha: 'keep'
    })
  })

  it('falls back to opaque VP9 and reports the dropped alpha when the probe fails', async () => {
    mediabunny.state.alphaProbeResults = [false]
    const result = await encodeVideo(options({ transparent: true }), SIZE, vi.fn(), {
      canceled: false
    })

    expect(result.alphaIncluded).toBe(false)
    // Regular codec negotiation still runs and lands on plain VP9.
    expect(mediabunny.state.videoCodecQueries.at(-1)).toEqual({
      codecs: ['vp9', 'vp8'],
      options: SIZE
    })
    expect(mediabunny.state.outputs.at(-1)!.videoTracks[0].source.options).toEqual({
      codec: 'vp9',
      quality: 'high'
    })
  })

  it('does not probe alpha for opaque exports', async () => {
    const result = await encodeVideo(options(), SIZE, vi.fn(), { canceled: false })

    expect(result.alphaIncluded).toBe(true)
    expect(mediabunny.state.alphaProbes).toHaveLength(0)
  })

  it('stays opaque for MP4 even when transparency was requested', async () => {
    mediabunny.state.videoCodecs = ['avc']
    const result = await encodeVideo(options({ format: 'mp4', transparent: true }), SIZE, vi.fn(), {
      canceled: false
    })

    expect(result.alphaIncluded).toBe(true)
    expect(mediabunny.state.alphaProbes).toHaveLength(0)
    expect(mediabunny.state.outputs.at(-1)!.videoTracks[0].source.options).toEqual({
      codec: 'avc',
      quality: 'high'
    })
  })

  it('writes a silent video when no audio codec is encodable', async () => {
    mediabunny.state.audioCodecs = [null]
    const result = await encodeVideo(options(), SIZE, vi.fn(), { canceled: false }, {
      buffer: mix()
    })

    expect(result.audioIncluded).toBe(false)
    // Negotiation tried the WebM audio candidates before giving up.
    expect(mediabunny.state.audioCodecQueries.at(-1)).toEqual(['opus', 'vorbis'])
    expect(mediabunny.state.outputs.at(-1)!.audioTracks).toHaveLength(0)
  })

  it('stays video-only when no mix is passed (existing behavior)', async () => {
    const result = await encodeVideo(options(), SIZE, vi.fn(), { canceled: false })

    expect(result.audioIncluded).toBe(false)
    expect(mediabunny.state.audioCodecQueries).toHaveLength(0)
    expect(mediabunny.state.outputs.at(-1)!.audioTracks).toHaveLength(0)
  })

  it('negotiates the mp4 container and its audio candidates for mp4 exports', async () => {
    mediabunny.state.audioCodecs = ['aac']
    const result = await encodeVideo(options({ format: 'mp4' }), SIZE, vi.fn(), { canceled: false }, {
      buffer: mix()
    })

    expect(result.audioIncluded).toBe(true)
    expect(mediabunny.state.videoCodecQueries.at(-1)).toEqual({ codecs: ['avc'], options: SIZE })
    expect(mediabunny.state.audioCodecQueries.at(-1)).toEqual(['aac', 'mp3'])
    expect(mediabunny.state.outputs.at(-1)!.format).toBeInstanceOf(mediabunny.Mp4OutputFormat)
  })

  it('refuses to encode when no video codec is available', async () => {
    mediabunny.state.videoCodecs = [null]
    await expect(encodeVideo(options(), SIZE, vi.fn(), { canceled: false })).rejects.toThrow(
      'No supported WEBM video encoder'
    )
  })

  it('cancellation between frames cancels the output and rethrows', async () => {
    const signal = { canceled: false }
    const drawFrame = vi.fn(() => {
      signal.canceled = true
    })
    await expect(encodeVideo(options(), SIZE, drawFrame, signal, null)).rejects.toBeInstanceOf(
      CanceledError
    )
    expect(drawFrame).toHaveBeenCalledTimes(1)
    const output = mediabunny.state.outputs.at(-1)!
    expect(output.canceled).toBe(true)
    expect(output.finalized).toBe(false)
  })

  it('cancels the output when drawing a frame fails', async () => {
    const failure = new Error('draw exploded')
    const drawFrame = vi.fn(() => {
      throw failure
    })
    await expect(encodeVideo(options(), SIZE, drawFrame, { canceled: false })).rejects.toBe(failure)
    expect(mediabunny.state.outputs.at(-1)!.canceled).toBe(true)
  })
})
