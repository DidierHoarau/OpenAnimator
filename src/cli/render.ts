import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { Resvg } from '@resvg/resvg-js'

import { documentToSvgString } from '../shared/exportSvg'
import { exportFrameCount, exportPixelSize } from '../shared/exportOptions'
import type { ExportOptions } from '../shared/exportOptions'
import { encodeGif, gifDelayMs } from '../shared/gifEncode'
import { packPngSequence } from '../shared/pngSequence'
import { migrateDocument } from '../shared/migrate'
import type { ResourceResolver } from '../shared/renderSvg'
import type { AnimatorDocument } from '../shared/model'
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

/** Rasterizes one evaluated frame of the document at the options' pixel size. */
export function renderFrame(
  document: AnimatorDocument,
  frame: number,
  options: ExportOptions,
  resolveResource: ResourceResolver
): RenderedFrame {
  const size = exportPixelSize(document, options)
  const svg = documentToSvgString(document, frame, resolveResource, {
    transparent: options.transparent
  })
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size.width } })
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
  onProgress?: (done: number, total: number) => void
): Promise<RenderOutcome> {
  const total = exportFrameCount(options)
  const frames: RenderedFrame[] = []
  for (let frame = options.fromFrame; frame <= options.toFrame; frame += 1) {
    frames.push(renderFrame(document, frame, options, resolveResource))
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
 * ffmpeg (absent on PATH produces a pointed error). */
export async function renderToFile(
  document: AnimatorDocument,
  options: ExportOptions,
  resolveResource: ResourceResolver,
  outPath: string,
  onProgress?: (done: number, total: number) => void
): Promise<RenderOutcome> {
  const outcome = await renderDocument(document, options, resolveResource, onProgress)
  if (options.format === 'webm' || options.format === 'mp4') {
    await encodeVideoWithFfmpeg(outcome.frames, options, outPath)
  } else if (outcome.bytes) {
    await writeFile(outPath, outcome.bytes)
  }
  return outcome
}

async function encodeVideoWithFfmpeg(
  frames: RenderedFrame[],
  options: ExportOptions,
  outPath: string
): Promise<void> {
  if (frames.length === 0) throw new Error('Video export needs at least one frame')
  const dir = await mkdtemp(join(tmpdir(), 'openanimator-render-'))
  try {
    await Promise.all(
      frames.map((frame, index) =>
        writeFile(join(dir, `frame_${String(index).padStart(4, '0')}.png`), frame.png)
      )
    )
    const codec = options.format === 'webm' ? 'libvpx-vp9' : 'libx264'
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'ffmpeg',
        [
          '-y',
          '-framerate',
          String(options.fps),
          '-i',
          join(dir, 'frame_%04d.png'),
          '-c:v',
          codec,
          '-pix_fmt',
          'yuv420p',
          outPath
        ],
        { stdio: 'ignore' }
      )
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
