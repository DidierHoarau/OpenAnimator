import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { Resvg } from '@resvg/resvg-js'

import { documentToSvgString } from '../shared/exportSvg'
import { exportFrameCount, exportPixelSize } from '../shared/exportOptions'
import type { ExportOptions } from '../shared/exportOptions'
import { embeddedFamilyResolverFor } from '../shared/fontPolicy'
import { encodeGif, gifDelayMs } from '../shared/gifEncode'
import { packPngSequence } from '../shared/pngSequence'
import { migrateDocument } from '../shared/migrate'
import type { ResourceResolver } from '../shared/renderSvg'
import type { AnimatorDocument } from '../shared/model'
import { audioMixPlan } from '../shared/audio'
import type { AudioMixEntry } from '../shared/audio'
import { isZipContainer, parseProject } from '../main/projectContainer'
import type { ProjectResourceMap } from '../main/projectContainer'

/**
 * Headless render pipeline: evaluates a document frame-by-frame through the
 * same shared SVG path as the in-app exporter, rasterizes with resvg and
 * encodes with the shared GIF/PNG-sequence encoders. Video formats fall back
 * to ffmpeg on PATH (WebCodecs is browser-only).
 */

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml'
}

/** Reads a `.oanim` ZIP container or a plain document JSON file. */
export async function loadDocumentAndResources(
  path: string
): Promise<{ document: AnimatorDocument; resources: ProjectResourceMap }> {
  const bytes = new Uint8Array(await readFile(path))
  if (isZipContainer(bytes)) return parseProject(bytes)
  const raw: unknown = JSON.parse(new TextDecoder().decode(bytes))
  return { document: migrateDocument(raw), resources: new Map() }
}

/** Resource lookup over the project container's resources, cached per id. */
export function createResourceResolver(resources: ProjectResourceMap): ResourceResolver {
  const cache = new Map<string, string | null>()
  return (resourceId) => {
    if (!cache.has(resourceId)) {
      const resource = resources.get(resourceId)
      const mime = resource ? MIME_BY_EXT[resource.ext] : undefined
      cache.set(
        resourceId,
        resource && mime
          ? `data:${mime};base64,${Buffer.from(resource.bytes).toString('base64')}`
          : null
      )
    }
    return cache.get(resourceId) ?? null
  }
}

export interface RenderedFrame {
  /** Raw RGBA pixels (GIF encoder input). */
  rgba: Uint8Array
  /** Encoded PNG bytes (sequence encoder input). */
  png: Uint8Array
  width: number
  height: number
}

/**
 * Writes the document's embedded subsets into a temp directory whose files
 * are handed to resvg (`font.fontFiles`): resvg ignores in-SVG `@font-face`
 * sources, it loads faces by path. Runs `run` with an empty list — and
 * without touching the file system — when the document embeds no fonts.
 */
export async function withEmbeddedFontFiles<T>(
  document: AnimatorDocument,
  resources: ProjectResourceMap,
  run: (fontFiles: string[]) => Promise<T>
): Promise<T> {
  const subsets = document.fonts.filter((font) => resources.has(font.resourceId))
  if (subsets.length === 0) return run([])
  const dir = await mkdtemp(join(tmpdir(), 'openanimator-fonts-'))
  try {
    const fontFiles: string[] = []
    for (const font of subsets) {
      const path = join(dir, `${font.id}.ttf`)
      await writeFile(path, resources.get(font.resourceId)!.bytes)
      fontFiles.push(path)
    }
    return await run(fontFiles)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Rasterizes one evaluated frame of the document at the options' pixel size. */
export function renderFrame(
  document: AnimatorDocument,
  frame: number,
  options: ExportOptions,
  resolveResource: ResourceResolver,
  fontFiles: readonly string[] = []
): RenderedFrame {
  const size = exportPixelSize(document, options)
  const svg = documentToSvgString(document, frame, resolveResource, {
    transparent: options.transparent,
    resolveEmbeddedFont: embeddedFamilyResolverFor(document.fonts)
  })
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size.width },
    ...(fontFiles.length > 0
      ? {
          font: {
            fontFiles: [...fontFiles],
            loadSystemFonts: true,
            defaultFontFamily: 'sans-serif'
          }
        }
      : {})
  })
  const rendered = resvg.render()
  if (rendered.width !== size.width || rendered.height !== size.height) {
    throw new Error(
      `resvg produced ${rendered.width}x${rendered.height}, expected ${size.width}x${size.height}`
    )
  }
  return {
    rgba: new Uint8Array(rendered.pixels),
    png: new Uint8Array(rendered.asPng()),
    width: rendered.width,
    height: rendered.height
  }
}

export interface RenderOutcome {
  /** Encoded output bytes (PNG sequence ZIP or GIF); undefined for video. */
  bytes?: Uint8Array
  frames: RenderedFrame[]
}

/** Renders the requested frame range with the format-specific encoder. */
export async function renderDocument(
  document: AnimatorDocument,
  options: ExportOptions,
  resolveResource: ResourceResolver,
  fontFiles: readonly string[] = [],
  onProgress?: (done: number, total: number) => void
): Promise<RenderOutcome> {
  const total = exportFrameCount(options)
  const frames: RenderedFrame[] = []
  for (let frame = options.fromFrame; frame <= options.toFrame; frame += 1) {
    frames.push(renderFrame(document, frame, options, resolveResource, fontFiles))
    onProgress?.(frames.length, total)
  }
  if (options.format === 'png-sequence') {
    return { frames, bytes: packPngSequence(frames.map((entry) => entry.png)) }
  }
  if (options.format === 'gif') {
    const delayMs = gifDelayMs(options)
    return {
      frames,
      bytes: encodeGif(
        frames.map((entry) => ({ data: entry.rgba, width: entry.width, height: entry.height, delayMs }))
      )
    }
  }
  // Video: the rendered frames are handed to ffmpeg by renderToFile.
  return { frames }
}

/** Renders and writes the output to `outPath`; video formats go through
 * ffmpeg (absent on PATH produces a pointed error). Audio layers of `document`
 * are mixed into video outputs from `resources`; PNG/GIF stay silent. */
export async function renderToFile(
  document: AnimatorDocument,
  options: ExportOptions,
  resolveResource: ResourceResolver,
  outPath: string,
  fontFiles: readonly string[] = [],
  onProgress?: (done: number, total: number) => void,
  resources: ProjectResourceMap = new Map()
): Promise<RenderOutcome> {
  const outcome = await renderDocument(document, options, resolveResource, fontFiles, onProgress)
  if (options.format === 'webm' || options.format === 'mp4') {
    await encodeVideoWithFfmpeg(outcome.frames, options, outPath, document, resources)
  } else if (outcome.bytes) {
    await writeFile(outPath, outcome.bytes)
  }
  return outcome
}

export interface FfmpegBuildInputs {
  /** Input 0: the `frame_%04d.png` pattern of the rendered frames. */
  framesPattern: string
  /** One temp file per planned clip, in plan order (inputs 1..N). */
  audioFiles: readonly string[]
  outPath: string
}

function ffmpegSeconds(value: number): string {
  return String(Math.max(0, Math.round(value * 1e6) / 1e6))
}

function ffmpegVolume(value: number): string {
  return String(Math.min(1, Math.max(0, Math.round(value * 1000) / 1000)))
}

/**
 * Builds the ffmpeg argument list for a video export: the rendered PNG
 * sequence plus one input per audible clip. Each clip is bounded to the
 * export window (`atrim` seeks into clips that started before the range),
 * shifted onto the timeline (`adelay`), gain-adjusted and padded (`apad` so
 * `-shortest` ends the output with the video, never early). Several clips sum
 * through `amix` with normalization off; a single clip maps directly. An
 * empty plan keeps the original silent argument list.
 */
export function buildFfmpegArgs(
  plan: readonly AudioMixEntry[],
  options: ExportOptions,
  inputs: FfmpegBuildInputs
): string[] {
  const codec = options.format === 'webm' ? 'libvpx-vp9' : 'libx264'
  const args = ['-y', '-framerate', String(options.fps), '-i', inputs.framesPattern]
  for (const file of inputs.audioFiles) args.push('-i', file)
  if (plan.length === 0) {
    args.push('-c:v', codec, '-pix_fmt', 'yuv420p', inputs.outPath)
    return args
  }
  const windowSeconds = exportFrameCount(options) / options.fps
  const chains: string[] = []
  plan.forEach((entry, index) => {
    const offset = Math.max(0, -entry.startSeconds)
    const delayMs = Math.max(0, Math.round(entry.startSeconds * 1000))
    const end = offset + windowSeconds
    const pad = plan.length === 1 ? ',apad' : ''
    chains.push(
      `[${index + 1}:a]atrim=start=${ffmpegSeconds(offset)}:end=${ffmpegSeconds(end)},` +
        `asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs},` +
        `volume=${ffmpegVolume(entry.volume)}${pad}[a${index}]`
    )
  })
  let audioLabel = 'a0'
  if (plan.length > 1) {
    const labels = plan.map((_, index) => `[a${index}]`).join('')
    chains.push(`${labels}amix=inputs=${plan.length}:normalize=0,apad[amix]`)
    audioLabel = 'amix'
  }
  args.push(
    '-filter_complex',
    chains.join(';'),
    '-map',
    '0:v',
    '-map',
    `[${audioLabel}]`,
    '-c:v',
    codec,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    options.format === 'webm' ? 'libopus' : 'aac',
    '-shortest',
    inputs.outPath
  )
  return args
}

/** Sanitized extension for a clip's temp file (ffmpeg probes content). */
function audioFileExt(ext: string): string {
  return ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin'
}

async function encodeVideoWithFfmpeg(
  frames: RenderedFrame[],
  options: ExportOptions,
  outPath: string,
  document: AnimatorDocument,
  resources: ProjectResourceMap
): Promise<void> {
  if (frames.length === 0) throw new Error('Video export needs at least one frame')
  const dir = await mkdtemp(join(tmpdir(), 'openanimator-render-'))
  try {
    await Promise.all(
      frames.map((frame, index) =>
        writeFile(join(dir, `frame_${String(index).padStart(4, '0')}.png`), frame.png)
      )
    )
    // Clips whose resource is missing from the container are skipped.
    const plan: AudioMixEntry[] = []
    const audioFiles: string[] = []
    for (const entry of audioMixPlan(document, { fromFrame: options.fromFrame, fps: options.fps })) {
      const resource = resources.get(entry.resourceId)
      if (!resource) continue
      const file = join(dir, `audio_${plan.length}.${audioFileExt(resource.ext)}`)
      await writeFile(file, resource.bytes)
      plan.push(entry)
      audioFiles.push(file)
    }
    const args = buildFfmpegArgs(plan, options, {
      framesPattern: join(dir, 'frame_%04d.png'),
      audioFiles,
      outPath
    })
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: 'ignore' })
      child.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('ffmpeg is not on PATH — use png-sequence or gif, or install ffmpeg'))
        } else {
          reject(error)
        }
      })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg exited with code ${code}`))
      })
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
