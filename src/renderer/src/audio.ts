import type { AnimatorDocument } from '@shared/model'
import { downsamplePeaks } from '@shared/audio'
import type { PeakBucket } from '@shared/audio'
import { audioMixPlan } from '@shared/audio'

/** Playback surface the editor drives: play/pause, seeks during playback and
 * the paused scrub preview. The no-op default keeps DOM-free tests green. */
export interface AudioPlaybackBridge {
  start(document: AnimatorDocument, frame: number, fps: number): void
  stop(): void
  sync(document: AnimatorDocument, frame: number, fps: number): void
  scrub(document: AnimatorDocument, frame: number, fps: number): void
  /** Ends the paused scrub session immediately (timeline pointer-up). */
  endScrub(): void
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
  scrub: () => {},
  endScrub: () => {}
}

/** Gain multiplier of the scrub-session clips. */
const SCRUB_GAIN = 0.35
/** Updates closer together than this carry no new velocity information. */
const SCRUB_MIN_STEP_SECONDS = 0.008
/** playbackRate clamp of the scrub session (Web Audio's practical range). */
const SCRUB_MIN_RATE = 0.25
const SCRUB_MAX_RATE = 4
/** Frame-lock slack: beyond one frame behind the playhead, the session snaps. */
const SCRUB_MAX_DRIFT_FRAMES = 1

function clampScrubRate(rate: number): number {
  return Math.min(SCRUB_MAX_RATE, Math.max(SCRUB_MIN_RATE, rate))
}

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

interface ScrubClip extends PlayingClip {
  /** `resourceId@startFrame` of the mix entry this clip plays. */
  key: string
}

interface ScrubSession {
  document: AnimatorDocument
  fps: number
  /** Frame the audible position is locked to, and the audio time it was. */
  frame: number
  at: number
  /** playbackRate currently applied to every session clip. */
  rate: number
  clips: ScrubClip[]
  /** Keys of the started clips; a change means the audible set moved. */
  keys: string
}

export interface AudioSystemDeps {
  /** Blob source for decoding (the renderer resource cache). */
  getBlob?: (resourceId: string) => Blob | null
  /** AudioContext factory; explicit null disables audio (headless tests). */
  createContext?: () => AudioContext | null
  /** Idle window of a scrub session in seconds: it auto-stops this long
   * after the last scrub call (a live pointer refreshes it). */
  scrubIdleSeconds?: number
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
 * frame-locked scrub session while scrubbing paused. Everything degrades to a
 * silent no-op when no AudioContext is available, and missing/undecodable
 * resources are skipped (never an error). The decoded cache also feeds the
 * timeline waveform (`peaks`) and clip spans (`durationSeconds`).
 */
export class AudioSystem implements AudioPlaybackBridge {
  private context: AudioContext | null = null
  private readonly getBlob: (resourceId: string) => Blob | null
  private readonly createContext: () => AudioContext | null
  private readonly scrubIdleSeconds: number
  private readonly decoded = new Map<string, DecodedClip>()
  private readonly decoding = new Set<string>()
  private readonly decodedListeners = new Set<() => void>()
  private playing: PlayingClip[] = []
  private session: PlaybackSession | null = null
  private scrubSession: ScrubSession | null = null
  private scrubIdleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: AudioSystemDeps = {}) {
    this.getBlob = deps.getBlob ?? (() => null)
    this.createContext = deps.createContext ?? defaultCreateContext
    this.scrubIdleSeconds = deps.scrubIdleSeconds ?? 0.2
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

  /** Stops playback (idempotent); a scrub session started earlier ends too
   * so playback always owns the clock alone. */
  stop(): void {
    this.session = null
    this.clearPlaying()
    this.endScrub()
  }

  /** Re-aligns a running playback to `frame` — seeks during playback and
   * loop wraps. No-op while stopped. */
  sync(document: AnimatorDocument, frame: number, fps: number): void {
    if (!this.session || !this.context) return
    this.session = { document, frame, fps, baseTime: this.context.currentTime }
    this.scheduleSession()
  }

  /**
   * Frame-locked scrub preview at `frame` while paused. The first call opens
   * a session playing every audible clip at the frame's offset with rate 1;
   * later calls map the scrub velocity (Δframe / Δt) onto `playbackRate`
   * (clamped to 0.25×–4×). The audible position may not lag more than one
   * frame behind the playhead — when the clamped rate can't keep up, the
   * session snaps by restarting at the exact offset. An idle window ends the
   * session after the last call; `endScrub()` ends it immediately.
   */
  scrub(document: AnimatorDocument, frame: number, fps: number): void {
    // Playback owns the clock; the editor routes playing seeks to sync().
    if (this.session) return
    const context = this.contextFor()
    if (!context) return
    const now = context.currentTime
    const current = this.scrubSession
    if (!current || current.document !== document) {
      this.startScrubClips(context, document, frame, fps, now, 1)
      return
    }
    const dt = now - current.at
    if (dt < SCRUB_MIN_STEP_SECONDS) return
    const rate = clampScrubRate((frame - current.frame) / (fps * dt))
    // Where the running clips have advanced to at `now` (the rate has been
    // constant since the last accepted call).
    const audibleFrame = current.frame + (now - current.at) * fps * current.rate
    const audible = this.audibleScrubEntries(document, frame, fps)
    const keys = audible.map((entry) => entry.key).join('\n')
    if (Math.abs(frame - audibleFrame) > SCRUB_MAX_DRIFT_FRAMES || keys !== current.keys) {
      this.startScrubClips(context, document, frame, fps, now, rate, audible)
      return
    }
    current.frame = frame
    current.at = now
    current.rate = rate
    for (const clip of current.clips) clip.source.playbackRate.value = rate
    this.armScrubIdle()
  }

  /** Ends the paused scrub session immediately (idempotent). */
  endScrub(): void {
    this.clearScrubIdle()
    const session = this.scrubSession
    this.scrubSession = null
    if (!session) return
    for (const clip of session.clips) this.releaseClip(clip)
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
    for (const clip of this.playing) this.releaseClip(clip)
    this.playing = []
  }

  private releaseClip(clip: PlayingClip): void {
    try {
      clip.source.stop()
    } catch {
      // Already ended.
    }
    clip.source.onended = null
    clip.source.disconnect()
    clip.gain.disconnect()
  }

  /** Mix entries audible at `frame` (clip started, position inside it) with
   * their seek offsets; undecoded resources trigger a decode instead. */
  private audibleScrubEntries(
    document: AnimatorDocument,
    frame: number,
    fps: number
  ): Array<{ key: string; buffer: AudioBuffer; offset: number; volume: number }> {
    const audible: Array<{ key: string; buffer: AudioBuffer; offset: number; volume: number }> = []
    for (const entry of audioMixPlan(document, { fromFrame: frame, fps })) {
      const offset = -entry.startSeconds
      if (offset < 0) continue
      const decoded = this.decoded.get(entry.resourceId)
      if (!decoded) {
        this.ensureDecoded(entry.resourceId)
        continue
      }
      if (offset >= decoded.buffer.duration) continue
      audible.push({
        key: `${entry.resourceId}@${entry.startFrame}`,
        buffer: decoded.buffer,
        offset,
        volume: entry.volume
      })
    }
    return audible
  }

  /** (Re)starts the scrub session for `frame`: clips run at `rate` from the
   * exact per-clip offsets, so the audible position is always frame-locked. */
  private startScrubClips(
    context: AudioContext,
    document: AnimatorDocument,
    frame: number,
    fps: number,
    now: number,
    rate: number,
    audible = this.audibleScrubEntries(document, frame, fps)
  ): void {
    this.endScrub()
    const clips: ScrubClip[] = []
    for (const entry of audible) {
      const { source, gain } = this.createClip(context, entry.buffer, entry.volume * SCRUB_GAIN)
      source.playbackRate.value = rate
      source.start(now, entry.offset)
      clips.push({ source, gain, key: entry.key })
    }
    this.scrubSession = {
      document,
      fps,
      frame,
      at: now,
      rate,
      clips,
      keys: clips.map((clip) => clip.key).join('\n')
    }
    this.armScrubIdle()
  }

  private armScrubIdle(): void {
    this.clearScrubIdle()
    this.scrubIdleTimer = setTimeout(() => {
      this.scrubIdleTimer = null
      this.endScrub()
    }, this.scrubIdleSeconds * 1000)
  }

  private clearScrubIdle(): void {
    if (this.scrubIdleTimer === null) return
    clearTimeout(this.scrubIdleTimer)
    this.scrubIdleTimer = null
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
        // A scrub session re-anchors so the freshly decoded clip joins it.
        else if (this.scrubSession) {
          const session = this.scrubSession
          this.startScrubClips(
            context,
            session.document,
            session.frame,
            session.fps,
            context.currentTime,
            session.rate
          )
        }
        for (const listener of this.decodedListeners) listener()
      })
      .catch(() => {
        // Missing or undecodable resource: silence, never an error.
        this.decoding.delete(resourceId)
      })
  }
}
