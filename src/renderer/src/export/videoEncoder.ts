import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  WebMOutputFormat,
  canEncodeVideo as canEncodeCodec,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec
} from 'mediabunny'
import type { AudioCodec } from 'mediabunny'
import type { ExportOptions, VideoQuality } from '@shared/exportOptions'

/**
 * Video export through WebCodecs (via mediabunny): frames are drawn onto one
 * canvas and encoded as VP9/WebM (preferred, patent-free) or H.264/MP4. The
 * `drawFrame` callback draws frame `index` onto the canvas and awaits back-
 * pressure, which keeps memory flat for long timelines.
 */

export type VideoFrameDrawer = (canvas: HTMLCanvasElement, frame: number) => Promise<void> | void

/** True when the environment can encode video (WebCodecs available). */
export function canEncodeVideo(): boolean {
  return typeof VideoEncoder !== 'undefined'
}

/** Preferred codecs per container, first encodable wins. */
const CODEC_CANDIDATES = {
  webm: ['vp9', 'vp8'],
  mp4: ['avc']
} as const

/** Export quality tiers mapped to mediabunny's encoder quality presets. */
const QUALITY_BY_TIER = {
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH
} as const satisfies Record<VideoQuality, unknown>

/** Preferred audio codecs per container, first encodable wins. */
const AUDIO_CODEC_CANDIDATES: { webm: AudioCodec[]; mp4: AudioCodec[] } = {
  webm: ['opus', 'vorbis'],
  mp4: ['aac', 'mp3']
}

async function codecFor(format: 'webm' | 'mp4', width: number, height: number): Promise<string> {
  const codec = await getFirstEncodableVideoCodec([...CODEC_CANDIDATES[format]], {
    width,
    height
  })
  if (!codec) {
    throw new Error(`No supported ${format.toUpperCase()} video encoder in this environment`)
  }
  return codec
}

/** Rendered video plus whether the requested audio track could be encoded. */
export interface EncodeVideoResult {
  bytes: Uint8Array
  /** False when a requested audio mix was dropped (no encodable codec). */
  audioIncluded: boolean
  /** False when transparent WebM was requested but the environment cannot
   * encode VP9 with alpha (the video is opaque). Always true otherwise. */
  alphaIncluded: boolean
}

/**
 * Renders and encodes the export frame range into a video file. `drawFrame`
 * is called once per frame with a reusable canvas; the caller (export runner)
 * rasterizes through the shared FrameRasterizer. When `audio` is given its
 * mix buffer is encoded as an audio track — except when the environment has
 * no encodable audio codec, in which case the video is written silent and
 * `audioIncluded` reports false. Transparent WebM probes the VP9 alpha
 * encoder; when unavailable the video is encoded opaque and `alphaIncluded`
 * reports false.
 */
export async function encodeVideo(
  options: ExportOptions,
  pixelSize: { width: number; height: number },
  drawFrame: VideoFrameDrawer,
  signal: { canceled: boolean },
  audio: { buffer: AudioBuffer } | null = null
): Promise<EncodeVideoResult> {
  const { width, height } = pixelSize
  const container = options.format === 'mp4' ? 'mp4' : 'webm'
  const wantsAlpha = options.format === 'webm' && options.transparent
  let codec: string
  let alphaKept = false
  if (wantsAlpha && (await canEncodeCodec('vp9', { width, height, alpha: 'keep' }))) {
    codec = 'vp9'
    alphaKept = true
  } else {
    codec = await codecFor(container, width, height)
  }

  const output = new Output({
    format: container === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: new BufferTarget()
  })
  const canvas = globalThis.document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const quality = QUALITY_BY_TIER[options.videoQuality]
  const source = new CanvasSource(canvas, {
    codec: codec as 'vp9',
    quality,
    ...(alphaKept ? { alpha: 'keep' as const } : {})
  })
  output.addVideoTrack(source, { frameRate: options.fps })
  let audioSource: AudioBufferSource | null = null
  if (audio) {
    const audioCodec = await getFirstEncodableAudioCodec(AUDIO_CODEC_CANDIDATES[container])
    if (audioCodec) {
      audioSource = new AudioBufferSource({ codec: audioCodec, quality })
      output.addAudioTrack(audioSource)
    }
  }
  await output.start()

  const frameCount = options.toFrame - options.fromFrame + 1
  const secondsPerFrame = 1 / options.fps
  try {
    if (audio && audioSource) {
      await audioSource.add(audio.buffer)
      audioSource.close()
    }
    for (let index = 0; index < frameCount; index++) {
      if (signal.canceled) throw new CanceledError()
      const canvas2d = canvas.getContext('2d')
      canvas2d?.clearRect(0, 0, width, height)
      await drawFrame(canvas, options.fromFrame + index)
      await source.add(index * secondsPerFrame, secondsPerFrame)
    }
    await output.finalize()
  } catch (error) {
    await output.cancel().catch(() => {})
    throw error
  }
  const buffer = output.target.buffer
  if (!buffer) throw new Error('Video encoding produced no data')
  return {
    bytes: new Uint8Array(buffer),
    audioIncluded: audioSource !== null,
    alphaIncluded: !wantsAlpha || alphaKept
  }
}

/** Thrown when the user cancels a running export. */
export class CanceledError extends Error {
  constructor() {
    super('Export canceled')
    this.name = 'CanceledError'
  }
}

