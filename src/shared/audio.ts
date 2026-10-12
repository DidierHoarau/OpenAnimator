import type { AnimatorDocument } from './model'
import { isAudioLayer } from './model'

/** One scheduled clip of the document's audio mix. */
export interface AudioMixEntry {
  resourceId: string
  /** Absolute timeline frame the clip starts at. */
  startFrame: number
  /** Seconds from the mix start (`fromFrame`) to the clip start; negative
   * when the clip began before the range — callers seek that far into the
   * decoded buffer. */
  startSeconds: number
  /** Playback gain, 0..1. */
  volume: number
}

/**
 * Audio mix plan of a document: one entry per audible audio layer, in layer
 * stack order (topmost first). Muted layers (the `visible` flag is the mute
 * switch) and zero-volume layers are skipped. Frames are converted with the
 * given fps — exports pass the export fps so re-timed video and audio stay
 * in sync; defaults to the document fps.
 */
export function audioMixPlan(
  document: AnimatorDocument,
  options: { fromFrame?: number; fps?: number } = {}
): AudioMixEntry[] {
  const fps = options.fps ?? document.fps
  const fromFrame = options.fromFrame ?? 0
  const entries: AudioMixEntry[] = []
  for (const layer of document.layers) {
    if (!isAudioLayer(layer) || !layer.visible || layer.volume === 0) continue
    entries.push({
      resourceId: layer.resourceId,
      startFrame: layer.startFrame,
      startSeconds: (layer.startFrame - fromFrame) / fps,
      volume: layer.volume
    })
  }
  return entries
}

/** Vertical extent of one waveform bucket: sample minimum and maximum. */
export interface PeakBucket {
  min: number
  max: number
}

/**
 * Downsamples decoded channel data into `buckets` min/max pairs for timeline
 * waveform drawing. Channels are merged per bucket (min of mins, max of
 * maxes); the longest channel drives the sampling grid. Buckets that fall
 * past every channel report `{ min: 0, max: 0 }`.
 */
export function downsamplePeaks(channelData: readonly Float32Array[], buckets: number): PeakBucket[] {
  const count = Math.max(1, Math.floor(buckets))
  const result: PeakBucket[] = Array.from({ length: count }, () => ({ min: 0, max: 0 }))
  const channels = channelData.filter((channel) => channel.length > 0)
  if (channels.length === 0) return result
  const length = Math.max(...channels.map((channel) => channel.length))
  for (let bucket = 0; bucket < count; bucket++) {
    const start = Math.floor((bucket * length) / count)
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * length) / count))
    let min = Infinity
    let max = -Infinity
    for (const channel of channels) {
      const from = Math.min(start, channel.length)
      const to = Math.min(end, channel.length)
      for (let i = from; i < to; i++) {
        const value = channel[i]
        if (value < min) min = value
        if (value > max) max = value
      }
    }
    if (min !== Infinity) result[bucket] = { min, max }
  }
  return result
}
