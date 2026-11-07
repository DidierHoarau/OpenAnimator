import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  StreamTarget,
  WebMOutputFormat,
  canEncodeVideo as canEncodeCodec,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec
} from 'mediabunny'
import type { AudioCodec, StreamTargetChunk, Target } from 'mediabunny'
import type { ExportOptions, VideoQuality } from '@shared/exportOptions'

/**
 * Video export through WebCodecs (via mediabunny): frames are drawn onto one
 * canvas and encoded as VP9/WebM (preferred, patent-free) or H.264/MP4.
 * `drawFrame` is called once per frame with the shared canvas and awaits
 * backpressure, so only one rendered frame is held at a time. The container
 * bytes are either collected into memory (`encodeVideo`) or streamed to a
 * sink (`encodeVideoToStream`).
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

/** Receives the container bytes as mediabunny emits them; `position` is the
 * byte offset in the output file, so chunks may arrive out of order. */
export interface VideoStreamSink {
  write(chunk: Uint8Array, position?: number): Promise<void>
}

/** Whether the streamed video kept its requested audio/alpha tracks. */
export interface EncodeVideoStreamResult {
  audioIncluded: boolean
  alphaIncluded: boolean
}

interface VideoSession {
  output: Output
  canvas: HTMLCanvasElement
  source: CanvasSource
  audioSource: AudioBufferSource | null
  alphaIncluded: boolean
}

/** Codec negotiation, output, canvas and track wiring shared by both encode
 * entry points. The only difference is where the container bytes land. */
async function openVideoOutput(
  options: ExportOptions,
  pixelSize: { width: number; height: number },
  audio: { buffer: AudioBuffer } | null,
  target: Target
): Promise<VideoSession> {
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
    target
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
  return {
    output,
    canvas,
    source,
    audioSource,
    alphaIncluded: !wantsAlpha || alphaKept
  }
}

/** Draws and encodes every frame of the export range, then finalizes the
 * container. Cancellation and failures cancel the output (dropping its data). */
async function encodeFrames(
  session: VideoSession,
  options: ExportOptions,
  pixelSize: { width: number; height: number },
  drawFrame: VideoFrameDrawer,
  signal: { canceled: boolean },
  audio: { buffer: AudioBuffer } | null
): Promise<void> {
  const { width, height } = pixelSize
  const frameCount = options.toFrame - options.fromFrame + 1
  const secondsPerFrame = 1 / options.fps
  try {
    if (audio && session.audioSource) {
      await session.audioSource.add(audio.buffer)
      session.audioSource.close()
    }
    for (let index = 0; index < frameCount; index++) {
      if (signal.canceled) throw new CanceledError()
      const canvas2d = session.canvas.getContext('2d')
      canvas2d?.clearRect(0, 0, width, height)
      await drawFrame(session.canvas, options.fromFrame + index)
      await session.source.add(index * secondsPerFrame, secondsPerFrame)
    }
    await session.output.finalize()
  } catch (error) {
    await session.output.cancel().catch(() => {})
    throw error
  }
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
  const target = new BufferTarget()
  const session = await openVideoOutput(options, pixelSize, audio, target)
  await encodeFrames(session, options, pixelSize, drawFrame, signal, audio)
  const buffer = target.buffer
  if (!buffer) throw new Error('Video encoding produced no data')
  return {
    bytes: new Uint8Array(buffer),
    audioIncluded: session.audioSource !== null,
    alphaIncluded: session.alphaIncluded
  }
}

/**
 * Streams the encoded container to `sink` instead of buffering it, keeping
 * memory flat for long exports. Chunks carry their byte offset, so the sink
 * may write them positionally in any order. Audio and alpha negotiation is
 * identical to `encodeVideo`.
 */
export async function encodeVideoToStream(
  options: ExportOptions,
  pixelSize: { width: number; height: number },
  drawFrame: VideoFrameDrawer,
  signal: { canceled: boolean },
  audio: { buffer: AudioBuffer } | null,
  sink: VideoStreamSink
): Promise<EncodeVideoStreamResult> {
  const target = new StreamTarget(
    new WritableStream<StreamTargetChunk>({
      write(chunk) {
        if (chunk.type === 'write') return sink.write(chunk.data, chunk.position)
        return undefined
      }
    }),
    { chunked: true }
  )
  const session = await openVideoOutput(options, pixelSize, audio, target)
  await encodeFrames(session, options, pixelSize, drawFrame, signal, audio)
  return {
    audioIncluded: session.audioSource !== null,
    alphaIncluded: session.alphaIncluded
  }
}

/** Thrown when the user cancels a running export. */
export class CanceledError extends Error {
  constructor() {
    super('Export canceled')
    this.name = 'CanceledError'
  }
}

