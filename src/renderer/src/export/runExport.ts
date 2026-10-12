import type { Editor } from '../editor'
import type { ExportOptions } from '@shared/exportOptions'
import { EXPORT_FORMATS, exportExtension, exportFrameCount, exportPixelSize } from '@shared/exportOptions'
import { encodeGif, gifDelayMs } from '@shared/gifEncode'
import { packPngSequence } from '@shared/pngSequence'
import { buildLottieAnimation, packDotLottie, serializeLottie } from '@shared/lottieExport'
import { exportAnimatedSvg } from '@shared/exportSvgAnimation'
import { buildSpritesheetMetadata, computeSpritesheetGrid, packSpritesheet } from '@shared/spritesheet'
import type { ExportPathRequest, ExportWriteResult, SaveAsResult } from '@shared/api'

import { FrameRasterizer, createDefaultFrameRasterDeps } from './frameRaster'
import type { FrameRasterDeps } from './frameRaster'
import { createEditorAudioMixdown } from './audioMixdown'
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
  pickExportPath(request: ExportPathRequest): Promise<SaveAsResult>
  writeExportFile(path: string, bytes: Uint8Array): Promise<ExportWriteResult>
  /** Status-bar feedback (progress milestones, results, errors). */
  showMessage(message: string): void
  onProgress?(progress: ExportProgress): void
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
    showMessage: (message) => editor.showMessage(message),
    reconcileFonts: () => reconcileEmbeddedFonts(editor),
    renderAudioMix: createEditorAudioMixdown(editor),
    outlineText: textNodeOutline,
    appVersion: () => window.api.versions().then((versions) => versions.app)
  }
}

/**
 * Runs one export end to end: asks for the destination, encodes the chosen
 * format — rasterizing frame ranges through the shared pipeline or building
 * vector output directly — and writes the result. Returns true when a file
 * was written; canceling or errors surface through the status bar and return
 * false. `signal.canceled` is polled between frames — the dialog sets it from
 * its Cancel button.
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
    let bytes: Uint8Array
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
      bytes = packSpritesheet(await rasterizer.canvasToPng(atlas), metadata)
    } else if (options.format === 'png-sequence') {
      const pngs: Uint8Array[] = []
      for (let frame = options.fromFrame; frame <= options.toFrame; frame++) {
        throwIfCanceled(signal)
        const canvas = await rasterizer.rasterizeToCanvas(frame)
        pngs.push(await rasterizer.canvasToPng(canvas))
        reportProgress(deps, pngs.length, total)
      }
      bytes = packPngSequence(pngs)
    } else if (options.format === 'gif') {
      const delayMs = gifDelayMs(options)
      const frames = []
      for (let frame = options.fromFrame; frame <= options.toFrame; frame++) {
        throwIfCanceled(signal)
        const canvas = await rasterizer.rasterizeToCanvas(frame)
        frames.push({ data: rasterizer.canvasToRgba(canvas), width, height, delayMs })
        reportProgress(deps, frames.length, total)
      }
      bytes = encodeGif(frames)
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

    const written = await deps.writeExportFile(pick.path, bytes)
    if (!written.ok) throw new Error(written.error)
    deps.showMessage(successMessage(pick.path, { alphaDropped, audioDropped, diagnostics }))
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
