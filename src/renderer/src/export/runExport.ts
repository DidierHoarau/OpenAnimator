import { strToU8 } from 'fflate'

import type { Editor } from '../editor'
import type { ExportOptions } from '@shared/exportOptions'
import {
  EXPORT_FORMATS,
  exportExtension,
  exportFrameCount,
  exportPixelSize
} from '@shared/exportOptions'
import { gifDelayMs } from '@shared/gifEncode'
import { buildLottieAnimation, packDotLottie, serializeLottie } from '@shared/lottieExport'
import { exportAnimatedSvg } from '@shared/exportSvgAnimation'
import { buildSpritesheetMetadata, computeSpritesheetGrid } from '@shared/spritesheet'
import { StreamingZip } from '@shared/streamingZip'
import type {
  ExportPathRequest,
  ExportStreamOpenResult,
  ExportWriteResult,
  PickPathResult
} from '@shared/api'

import { FrameRasterizer, createDefaultFrameRasterDeps } from './frameRaster'
import type { FrameRasterDeps } from './frameRaster'
import { createEditorAudioMixdown } from './audioMixdown'
import { createGifEncodeClient } from './gifEncodeClient'
import type { GifEncodeClient } from './gifEncodeClient'
import { reconcileEmbeddedFonts } from '../fontEmbedding'
import { createResourceDataUrlResolver } from './resourceDataUrl'
import { textNodeOutline } from '../textOutlines'
import type { TextOutlineProvider } from '@shared/textOutline'
import { CanceledError, canEncodeVideo, encodeVideo } from './videoEncoder'

export interface ExportProgress {
  done: number
  total: number
}

export interface ExportRunnerDeps extends FrameRasterDeps {
  pickExportPath(request: ExportPathRequest): Promise<PickPathResult>
  writeExportFile(path: string, bytes: Uint8Array): Promise<ExportWriteResult>
  /** Staged write used by the archive formats: bytes stream into `<dest>.tmp`
   * and are renamed onto the destination only when the export completes. */
  openExportStream(path: string): Promise<ExportStreamOpenResult>
  writeExportStream(token: string, chunk: Uint8Array): Promise<ExportWriteResult>
  finishExportStream(token: string, commit: boolean): Promise<ExportWriteResult>
  /** Status-bar feedback (progress milestones, results, errors). */
  showMessage(message: string): void
  onProgress?(progress: ExportProgress): void
  /** Non-fatal export notes (vector placeholders), surfaced in the dialog. */
  onDiagnostics?(diagnostics: string[]): void
  /** GIF encoder factory: a worker in the export UI, the inline encoder in
   * environments without one. */
  createGifEncodeClient?(): Promise<GifEncodeClient>
  /** Embeds the font subsets the document renders (optional; harnesses that
   * rasterize fixtures directly may omit it). */
  reconcileFonts?(): Promise<unknown>
  /** Mixes the document's audible audio layers for the export range, or null
   * when nothing is audible. Only used by the video formats. */
  renderAudioMix?(options: ExportOptions): Promise<AudioBuffer | null>
  /** Outlines text nodes for the vector formats (Lottie, animated SVG);
   * absent or null results degrade to placeholders with a diagnostic. */
  outlineText?: TextOutlineProvider
  /** App version recorded in export metadata (spritesheet, dotLottie). */
  appVersion?(): Promise<string>
}

export function createDefaultExportRunnerDeps(editor: Editor): ExportRunnerDeps {
  return {
    ...createDefaultFrameRasterDeps(),
    resolveResourceDataUrl: createResourceDataUrlResolver(editor.resources),
    pickExportPath: (request) => window.api.pickExportPath(request),
    writeExportFile: (path, bytes) => window.api.writeExportFile(path, bytes),
    openExportStream: (path) => window.api.openExportStream(path),
    writeExportStream: (token, chunk) => window.api.writeExportStream(token, chunk),
    finishExportStream: (token, commit) => window.api.finishExportStream(token, commit),
    createGifEncodeClient,
    showMessage: (message) => editor.showMessage(message),
    reconcileFonts: () => reconcileEmbeddedFonts(editor),
    renderAudioMix: createEditorAudioMixdown(editor),
    outlineText: textNodeOutline,
    appVersion: () => window.api.versions().then((versions) => versions.app)
  }
}

/** The atlas PNG streams to the stage in bounded slices, not one huge chunk. */
const ATLAS_CHUNK_BYTES = 1024 * 1024

/**
 * Runs one export end to end: asks for the destination, encodes the chosen
 * format — rasterizing frame ranges through the shared pipeline or building
 * vector output directly — and writes the result. The archive formats stream
 * through a staged temp file (committed on success, aborted on failure or
 * cancel); the others write atomically in one shot. Returns true when a file
 * was committed; canceling or errors surface through the status bar and
 * return false. `signal.canceled` is polled between frames — the dialog sets
 * it from its Cancel button.
 */
export async function runExport(
  editor: Editor,
  options: ExportOptions,
  deps: ExportRunnerDeps,
  signal: { canceled: boolean }
): Promise<boolean> {
  const document = editor.document
  const total = exportFrameCount(options)
  if (total < 1) {
    deps.showMessage('Nothing to export: the frame range is empty')
    return false
  }

  const formatInfo = EXPORT_FORMATS.find((entry) => entry.format === options.format)
  const pick = await deps.pickExportPath({
    defaultName: `${document.name || 'Untitled'}.${exportExtension(options.format)}`,
    filters: [{ name: formatInfo?.label ?? 'Export', extensions: [exportExtension(options.format)] }]
  })
  if (pick.canceled) return false

  const rasterizer = new FrameRasterizer(document, options, deps)
  const { width, height } = exportPixelSize(document, options)
  let audioDropped = false
  let alphaDropped = false
  let diagnostics: string[] = []
  try {
    // Embed the font subsets the document renders before rasterizing, so the
    // exported frames keep their typography everywhere.
    await deps.reconcileFonts?.()
    let bytes: Uint8Array | null = null
    if (options.format === 'lottie' || options.format === 'dotlottie') {
      const built = await buildLottieAnimation(
        document,
        { fromFrame: options.fromFrame, toFrame: options.toFrame, fps: options.fps },
        {
          resolveResourceDataUrl: (resourceId) => deps.resolveResourceDataUrl(resourceId),
          outlineText: deps.outlineText
        }
      )
      diagnostics = built.diagnostics
      bytes =
        options.format === 'dotlottie'
          ? packDotLottie(built.lottie, await appVersionOf(deps))
          : serializeLottie(built.lottie)
    } else if (options.format === 'svg-animation') {
      const exported = await exportAnimatedSvg(
        document,
        {
          fromFrame: options.fromFrame,
          toFrame: options.toFrame,
          fps: options.fps,
          scale: options.scale,
          transparent: options.transparent
        },
        {
          resolveResourceDataUrl: (resourceId) => deps.resolveResourceDataUrl(resourceId),
          outlineText: deps.outlineText
        }
      )
      diagnostics = exported.diagnostics
      bytes = new TextEncoder().encode(exported.svg)
    } else if (options.format === 'spritesheet') {
      const grid = computeSpritesheetGrid(total, width, height)
      const atlas = deps.createCanvas(grid.width, grid.height)
      const context = atlas.getContext('2d')
      if (!context) throw new Error('Canvas 2D context unavailable')
      for (let index = 0; index < total; index++) {
        throwIfCanceled(signal)
        const canvas = await rasterizer.rasterizeToCanvas(options.fromFrame + index)
        context.drawImage(
          canvas,
          (index % grid.columns) * width,
          Math.floor(index / grid.columns) * height
        )
        reportProgress(deps, index + 1, total)
      }
      const metadata = buildSpritesheetMetadata({
        frameCount: total,
        frameWidth: width,
        frameHeight: height,
        grid,
        fps: options.fps,
        fromFrame: options.fromFrame,
        toFrame: options.toFrame,
        version: await appVersionOf(deps)
      })
      const atlasPng = await rasterizer.canvasToPng(atlas)
      await withExportStream(deps, pick.path, async (zip) => {
        zip.addFile('atlas.png', atlasPng, ATLAS_CHUNK_BYTES)
        zip.addFile('atlas.json', strToU8(JSON.stringify(metadata, null, 2)))
      })
    } else if (options.format === 'png-sequence') {
      // One frame in memory at a time: rasterize, push into the streaming
      // zip, and let the sink write it out before rasterizing the next.
      let rendered = 0
      await withExportStream(deps, pick.path, async (zip) => {
        for (let frame = options.fromFrame; frame <= options.toFrame; frame++) {
          throwIfCanceled(signal)
          const canvas = await rasterizer.rasterizeToCanvas(frame)
          const png = await rasterizer.canvasToPng(canvas)
          zip.addFile(`frame_${String(rendered).padStart(4, '0')}.png`, png)
          rendered++
          reportProgress(deps, rendered, total)
        }
      })
    } else if (options.format === 'gif') {
      const delayMs = gifDelayMs(options)
      const client = deps.createGifEncodeClient
        ? await deps.createGifEncodeClient()
        : await createGifEncodeClient()
      try {
        let done = 0
        for (let frame = options.fromFrame; frame <= options.toFrame; frame++) {
          throwIfCanceled(signal)
          const canvas = await rasterizer.rasterizeToCanvas(frame)
          await client.addFrame({
            data: rasterizer.canvasToRgba(canvas),
            width,
            height,
            delayMs
          })
          done++
          reportProgress(deps, done, total)
        }
        // A cancel that landed while the last frame encoded must not produce
        // a file either.
        throwIfCanceled(signal)
        bytes = await client.finish()
      } finally {
        client.dispose()
      }
    } else {
      if (!canEncodeVideo()) {
        throw new Error('Video export needs WebCodecs, which this environment does not provide')
      }
      // Audio is best-effort: a mixdown failure exports the video silent.
      const audioBuffer = deps.renderAudioMix
        ? await deps.renderAudioMix(options).catch((error: unknown) => {
            console.warn('OpenAnimator: audio mixdown failed', error)
            return null
          })
        : null
      const encoded = await encodeVideo(
        options,
        { width, height },
        async (canvas, frame) => {
          const rasterized = await rasterizer.rasterizeToCanvas(frame)
          const context = canvas.getContext('2d')
          context?.drawImage(rasterized, 0, 0)
          reportProgress(deps, frame - options.fromFrame + 1, total)
        },
        signal,
        audioBuffer ? { buffer: audioBuffer } : null
      )
      bytes = encoded.bytes
      audioDropped = audioBuffer !== null && !encoded.audioIncluded
      alphaDropped = !encoded.alphaIncluded
    }

    // A cancel that landed while the vector/video formats were built must not
    // write a file either (streamed formats abort inside withExportStream).
    throwIfCanceled(signal)
    if (bytes !== null) {
      const written = await deps.writeExportFile(pick.path, bytes)
      if (!written.ok) throw new Error(written.error)
    }
    deps.showMessage(successMessage(pick.path, { alphaDropped, audioDropped, diagnostics }))
    if (diagnostics.length > 0) deps.onDiagnostics?.(diagnostics)
    return true
  } catch (error) {
    if (error instanceof CanceledError || signal.canceled) {
      deps.showMessage('Export canceled')
      return false
    }
    const message = error instanceof Error ? error.message : String(error)
    console.error('OpenAnimator: export failed', error)
    deps.showMessage(`Export failed: ${message}`)
    return false
  }
}

/**
 * Runs one streamed archive export against a staged write: opens the temp,
 * feeds the zip chunks to the sink, commits on success. Any error (including
 * cancellation) aborts the staged write first and rethrows, so a failed or
 * canceled export never creates the destination file.
 */
async function withExportStream(
  deps: ExportRunnerDeps,
  path: string,
  produce: (zip: StreamingZip) => Promise<void>
): Promise<void> {
  const opened = await deps.openExportStream(path)
  if (!opened.ok) throw new Error(opened.error)
  const zip = new StreamingZip(async (chunk) => {
    const result = await deps.writeExportStream(opened.token, chunk)
    if (!result.ok) throw new Error(result.error)
  })
  try {
    await produce(zip)
    await zip.end()
    const finished = await deps.finishExportStream(opened.token, true)
    if (!finished.ok) throw new Error(finished.error)
  } catch (error) {
    zip.terminate()
    await deps.finishExportStream(opened.token, false).catch(() => undefined)
    throw error
  }
}

async function appVersionOf(deps: ExportRunnerDeps): Promise<string> {
  return deps.appVersion ? deps.appVersion() : '0.0.0'
}

function successMessage(
  path: string,
  outcome: { alphaDropped: boolean; audioDropped: boolean; diagnostics: string[] }
): string {
  let message = `Exported to ${path}`
  if (outcome.alphaDropped) {
    message += ' without transparency (no VP9 alpha encoder in this environment)'
  }
  if (outcome.audioDropped) {
    message += ' without audio (no encoder available)'
  }
  if (outcome.diagnostics.length > 0) {
    const count = outcome.diagnostics.length
    message += ` (${count} export diagnostic${count === 1 ? '' : 's'})`
  }
  return message
}

function throwIfCanceled(signal: { canceled: boolean }): void {
  if (signal.canceled) throw new CanceledError()
}

function reportProgress(deps: ExportRunnerDeps, done: number, total: number): void {
  deps.onProgress?.({ done, total })
}
