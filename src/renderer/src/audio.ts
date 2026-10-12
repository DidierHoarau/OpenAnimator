import type { AnimatorDocument } from '@shared/model'
import { downsamplePeaks } from '@shared/audio'
import type { PeakBucket } from '@shared/audio'
import { audioMixPlan } from '@shared/audio'

/** Playback surface the editor drives: play/pause, seeks during playback and
 * the paused scrub blip. The no-op default keeps DOM-free tests green. */
export interface AudioPlaybackBridge {
  start(document: AnimatorDocument, frame: number, fps: number): void
  stop(): void
  sync(document: AnimatorDocument, frame: number, fps: number): void
  scrub(document: AnimatorDocument, frame: number, fps: number): void
  /** Decoded clip length in seconds; null until the resource is decoded (the
   * call triggers the decode). Used by the timeline clip spans. */
  durationSeconds?(resourceId: string): number | null
  /** Waveform buckets over the decoded clip; null until decoded (the call
   * triggers the decode). */
  peaks?(resourceId: string, buckets: number): PeakBucket[] | null
  /** Notified when a resource finishes decoding so views re-render. */
  onDecoded?(listener: () => void): () => void
}

export const NOOP_AUDIO: AudioPlaybackBridge = {
  start: () => {},
  stop: () => {},
  sync: () => {},
  scrub: () => {}
}

/** Gain multiplier of the paused scrub blip. */
const SCRUB_GAIN = 0.35

interface DecodedClip {
  buffer: AudioBuffer
  peaks: Map<number, PeakBucket[]>
}

interface PlayingClip {
  source: AudioBufferSourceNode
  gain: GainNode
}

interface PlaybackSession {
  document: AnimatorDocument
  frame: number
  fps: number
  /** Audio-clock time the session frame is at. */
  baseTime: number
}

export interface AudioSystemDeps {
  /** Blob source for decoding (the renderer resource cache). */
  getBlob?: (resourceId: string) => Blob | null
  /** AudioContext factory; explicit null disables audio (headless tests). */
  createContext?: () => AudioContext | null
  /** Paused scrub blip length in seconds (also the scrub throttle). */
  scrubSeconds?: number
}

function defaultCreateContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  try {
    return new AudioContext()
  } catch {
    return null
  }
}

/**
 * Renderer-only audio playback: decodes document audio resources lazily
 * through the resource cache and schedules the document's mix (`audioMixPlan`)
 * on an AudioContext — play/pause, re-sync on seeks and loop wraps, and a
 * short blip while scrubbing paused. Everything degrades to a silent no-op
 * when no AudioContext is available, and missing/undecodable resources are
 * skipped (never an error). The decoded cache also feeds the timeline
 * waveform (`peaks`) and clip spans (`durationSeconds`).
 */
export class AudioSystem implements AudioPlaybackBridge {
  private context: AudioContext | null = null
  private readonly getBlob: (resourceId: string) => Blob | null
  private readonly createContext: () => AudioContext | null
  private readonly scrubSeconds: number
  private readonly decoded = new Map<string, DecodedClip>()
  private readonly decoding = new Set<string>()
  private readonly decodedListeners = new Set<() => void>()
  private playing: PlayingClip[] = []
  private session: PlaybackSession | null = null
  private lastScrubAt = -Infinity

  constructor(deps: AudioSystemDeps = {}) {
    this.getBlob = deps.getBlob ?? (() => null)
    this.createContext = deps.createContext ?? defaultCreateContext
    this.scrubSeconds = deps.scrubSeconds ?? 0.12
  }

  /** Starts playback of the mix from `frame` (aligned with the editor's
   * frame clock at `fps`). */
  start(document: AnimatorDocument, frame: number, fps: number): void {
    this.stop()
    const context = this.contextFor()
    if (!context) return
    if (context.state === 'suspended') void context.resume()
    // No scheduling lead: a lead would accumulate as A/V drift across loop
    // wraps. A late-scheduled start is compensated below instead.
    this.session = { document, frame, fps, baseTime: context.currentTime }
    this.scheduleSession()
  }

  /** Stops playback (idempotent). */
  stop(): void {
    this.session = null
    this.clearPlaying()
  }

  /** Re-aligns a running playback to `frame` — seeks during playback and
   * loop wraps. No-op while stopped. */
  sync(document: AnimatorDocument, frame: number, fps: number): void {
    if (!this.session || !this.context) return
    this.session = { document, frame, fps, baseTime: this.context.currentTime }
    this.scheduleSession()
  }

  /** Short preview blip at `frame` while paused (throttled to the blip
   * length so scrubbing does not machine-gun the context). */
  scrub(document: AnimatorDocument, frame: number, fps: number): void {
    const context = this.contextFor()
    if (!context) return
    const now = context.currentTime
    if (now - this.lastScrubAt < this.scrubSeconds) return
    const plan = audioMixPlan(document, { fromFrame: frame, fps })
    let played = false
    for (const entry of plan) {
      const clipLocal = -entry.startSeconds
      if (clipLocal < 0) continue
      const decoded = this.decoded.get(entry.resourceId)
      if (!decoded) {
        this.ensureDecoded(entry.resourceId)
        continue
      }
      if (clipLocal >= decoded.buffer.duration) continue
      const { source } = this.createClip(context, decoded.buffer, entry.volume * SCRUB_GAIN)
      source.start(now, clipLocal)
      source.stop(now + this.scrubSeconds)
      played = true
    }
    if (played) this.lastScrubAt = now
  }

  /** Decoded clip length in seconds, or null while not decoded yet. */
  durationSeconds(resourceId: string): number | null {
    const decoded = this.decoded.get(resourceId)
    if (!decoded) {
      this.ensureDecoded(resourceId)
      return null
    }
    return decoded.buffer.duration
  }

  /** Waveform buckets over the decoded clip, memoized per bucket count. */
  peaks(resourceId: string, buckets: number): PeakBucket[] | null {
    const decoded = this.decoded.get(resourceId)
    if (!decoded) {
      this.ensureDecoded(resourceId)
      return null
    }
    const count = Math.max(1, Math.floor(buckets))
    let cached = decoded.peaks.get(count)
    if (!cached) {
      const channels: Float32Array[] = []
      for (let i = 0; i < decoded.buffer.numberOfChannels; i++) {
        channels.push(decoded.buffer.getChannelData(i))
      }
      cached = downsamplePeaks(channels, count)
      decoded.peaks.set(count, cached)
    }
    return cached
  }

  /** Notified when a resource finishes decoding (timeline re-render). */
  onDecoded(listener: () => void): () => void {
    this.decodedListeners.add(listener)
    return () => this.decodedListeners.delete(listener)
  }

  private contextFor(): AudioContext | null {
    if (this.context) return this.context
    this.context = this.createContext()
    return this.context
  }

  private scheduleSession(): void {
    const context = this.context
    const session = this.session
    if (!context || !session) return
    this.clearPlaying()
    const plan = audioMixPlan(session.document, { fromFrame: session.frame, fps: session.fps })
    const now = context.currentTime
    for (const entry of plan) {
      const decoded = this.decoded.get(entry.resourceId)
      if (!decoded) {
        this.ensureDecoded(entry.resourceId)
        continue
      }
      // entry.startSeconds is the clip start relative to the session frame:
      // negative means the clip began earlier and is seeked into.
      const desiredStart = session.baseTime + Math.max(0, entry.startSeconds)
      const late = Math.max(0, now - desiredStart)
      const bufferOffset = Math.max(0, -entry.startSeconds) + late
      if (bufferOffset >= decoded.buffer.duration) continue
      const { source, gain } = this.createClip(context, decoded.buffer, entry.volume)
      source.start(Math.max(now, desiredStart), bufferOffset)
      this.playing.push({ source, gain })
    }
  }

  private createClip(
    context: AudioContext,
    buffer: AudioBuffer,
    volume: number
  ): { source: AudioBufferSourceNode; gain: GainNode } {
    const source = context.createBufferSource()
    source.buffer = buffer
    const gain = context.createGain()
    gain.gain.value = Math.min(1, Math.max(0, volume))
    source.connect(gain)
    gain.connect(context.destination)
    source.onended = () => {
      const index = this.playing.findIndex((clip) => clip.source === source)
      if (index !== -1) this.playing.splice(index, 1)
      source.disconnect()
      gain.disconnect()
    }
    return { source, gain }
  }

  private clearPlaying(): void {
    for (const clip of this.playing) {
      try {
        clip.source.stop()
      } catch {
        // Already ended.
      }
      clip.source.onended = null
      clip.source.disconnect()
      clip.gain.disconnect()
    }
    this.playing = []
  }

  private ensureDecoded(resourceId: string): void {
    if (this.decoded.has(resourceId) || this.decoding.has(resourceId)) return
    const context = this.contextFor()
    const blob = this.getBlob(resourceId)
    if (!context || !blob) return
    this.decoding.add(resourceId)
    void blob
      .arrayBuffer()
      .then((buffer) => context.decodeAudioData(buffer))
      .then((audioBuffer) => {
        this.decoding.delete(resourceId)
        this.decoded.set(resourceId, { buffer: audioBuffer, peaks: new Map() })
        // A clip that was skipped at playback start joins the running mix.
        if (this.session) this.scheduleSession()
        for (const listener of this.decodedListeners) listener()
      })
      .catch(() => {
        // Missing or undecodable resource: silence, never an error.
        this.decoding.delete(resourceId)
      })
  }
}
