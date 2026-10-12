import { audioMixPlan } from '@shared/audio'
import type { ExportOptions } from '@shared/exportOptions'
import { exportFrameCount } from '@shared/exportOptions'
import type { AnimatorDocument } from '@shared/model'

import type { Editor } from '../editor'

/** Fixed mixing format of the export mixdown: 48 kHz stereo. */
export const MIX_SAMPLE_RATE = 48000
export const MIX_CHANNELS = 2

export interface AudioMixdownDeps {
  /** Encoded bytes of a resource, or null when unavailable. */
  getBytes(resourceId: string): Promise<Uint8Array | null>
  /** Decodes encoded audio into raw sample data. */
  decode(bytes: Uint8Array): Promise<AudioBuffer>
  /** Render target: an offline context `seconds` long. */
  createContext(seconds: number): OfflineAudioContext
}

/**
 * Renders the document's audible audio layers (`audioMixPlan`) into one
 * stereo buffer covering the export frame range, or null when nothing is
 * audible. Clips that started before the range are seeked into; the render
 * duration trims clips that extend past the range. Clips whose resource is
 * missing or undecodable are skipped, never failing the export.
 */
export async function renderAudioMixdown(
  document: AnimatorDocument,
  options: ExportOptions,
  deps: AudioMixdownDeps
): Promise<AudioBuffer | null> {
  const plan = audioMixPlan(document, { fromFrame: options.fromFrame, fps: options.fps })
  if (plan.length === 0) return null
  const seconds = exportFrameCount(options) / options.fps
  const context = deps.createContext(seconds)
  let scheduled = false
  for (const entry of plan) {
    const bytes = await deps.getBytes(entry.resourceId).catch(() => null)
    if (!bytes) continue
    let buffer: AudioBuffer
    try {
      buffer = await deps.decode(bytes)
    } catch (error) {
      console.warn('OpenAnimator: skipping undecodable audio clip', entry.resourceId, error)
      continue
    }
    // Clip started before the range: seek that far into the decoded buffer.
    const offset = Math.max(0, -entry.startSeconds)
    if (offset >= buffer.duration) continue
    const source = context.createBufferSource()
    source.buffer = buffer
    const gain = context.createGain()
    gain.gain.value = entry.volume
    source.connect(gain)
    gain.connect(context.destination)
    source.start(Math.max(0, entry.startSeconds), offset)
    scheduled = true
  }
  if (!scheduled) return null
  return context.startRendering()
}

/**
 * Binds the mixdown to a live editor: resources decode through one shared
 * (lazily created) AudioContext, and the mix renders into a 48 kHz stereo
 * OfflineAudioContext spanning exactly the export range.
 */
export function createEditorAudioMixdown(
  editor: Editor
): (options: ExportOptions) => Promise<AudioBuffer | null> {
  return async (options) => {
    let decodeContext: AudioContext | undefined
    try {
      return await renderAudioMixdown(editor.document, options, {
        getBytes: async (resourceId) => {
          const blob = editor.resources.getBlob(resourceId)
          return blob ? new Uint8Array(await blob.arrayBuffer()) : null
        },
        decode: (bytes) => {
          decodeContext ??= new AudioContext()
          return decodeContext.decodeAudioData(bytes.buffer as ArrayBuffer)
        },
        createContext: (seconds) =>
          new OfflineAudioContext(
            MIX_CHANNELS,
            Math.max(1, Math.ceil(seconds * MIX_SAMPLE_RATE)),
            MIX_SAMPLE_RATE
          )
      })
    } finally {
      await decodeContext?.close().catch(() => {})
    }
  }
}
