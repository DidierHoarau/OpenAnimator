import { readFileSync } from 'node:fs'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { unzipSync } from 'fflate'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'

import { packProject } from '../main/projectContainer'
import { embeddedFontId } from '../shared/fontPolicy'
import { subsetFont } from '../shared/fontSubset'
import type { AnimatorDocument } from '../shared/model'
import { sanitizeExportOptions } from '../shared/exportOptions'
import {
  buildFfmpegArgs,
  createResourceResolver,
  loadDocumentAndResources,
  renderDocument,
  renderFrame,
  renderToFile,
  withEmbeddedFontFiles
} from './render'

const DOCUMENT: AnimatorDocument = {
  schemaVersion: 7,
  name: 'CLI test',
  width: 96,
  height: 64,
  fps: 12,
  frames: 4,
  background: '#223344',
  palette: [],
  layers: [
    {
      kind: 'object',
      id: 'lay1',
      name: 'Box',
      visible: true,
      locked: false,
      keyframes: [
        {
          frame: 0,
          tween: { easing: 'linear' },
          nodes: [
            {
              type: 'primitive',
              id: 'n1',
              primitive: 'rect',
              fill: '#ffaa00',
              center: { x: 24, y: 32 },
              width: 20,
              height: 20,
              rotation: 0,
              opacity: 1
            }
          ]
        },
        {
          frame: 3,
          nodes: [
            {
              type: 'primitive',
              id: 'n1',
              primitive: 'rect',
              fill: '#ffaa00',
              center: { x: 72, y: 32 },
              width: 20,
              height: 20,
              rotation: 0,
              opacity: 1
            }
          ]
        }
      ]
    }
  ],
  assets: [],
  fonts: []
}

describe('loadDocumentAndResources', () => {
  it('reads a plain document JSON file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openanimator-cli-'))
    const path = join(dir, 'doc.json')
    await writeFile(path, JSON.stringify(DOCUMENT))
    const { document, resources } = await loadDocumentAndResources(path)
    expect(document.name).toBe('CLI test')
    expect(resources.size).toBe(0)
  })

  it('reads a .oanim ZIP container with its resources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openanimator-cli-'))
    const path = join(dir, 'project.oanim')
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    // packProject stores only referenced resources, so the fixture must
    // point at res-1 from somewhere.
    const referencing = structuredClone(DOCUMENT)
    const layer = referencing.layers[0]
    if (layer.kind !== 'object') throw new Error('expected an object layer')
    layer.keyframes[0].nodes.push({
      type: 'image',
      id: 'img1',
      resourceId: 'res-1',
      naturalWidth: 4,
      naturalHeight: 4,
      smoothing: true,
      center: { x: 90, y: 58 },
      width: 4,
      height: 4,
      rotation: 0,
      opacity: 1
    })
    const packed = packProject(referencing, new Map([['res-1', { bytes, ext: 'png' }]]))
    await writeFile(path, packed)
    const { document, resources } = await loadDocumentAndResources(path)
    expect(document.name).toBe('CLI test')
    expect(resources.get('res-1')?.bytes).toEqual(bytes)
    expect(resources.get('res-1')?.ext).toBe('png')
  })
})

describe('createResourceResolver', () => {
  it('maps known resources to data URLs and unknown ones to null', () => {
    const resolve = createResourceResolver(
      new Map([['res-1', { bytes: new Uint8Array([9, 9, 9]), ext: 'png' }]])
    )
    expect(resolve('res-1')).toMatch(/^data:image\/png;base64,/)
    expect(resolve('missing')).toBeNull()
  })
})

describe('renderFrame', () => {
  it('rasterizes at the scaled pixel size with the tweened box moving', () => {
    const options = sanitizeExportOptions({ format: 'gif', fromFrame: 0, toFrame: 3 }, DOCUMENT)
    const first = renderFrame(DOCUMENT, 0, options, () => null)
    const last = renderFrame(DOCUMENT, 3, options, () => null)
    expect(first.width).toBe(96)
    expect(first.height).toBe(64)

    const png = PNG.sync.read(Buffer.from(last.png))
    const pixelAt = (x: number, y: number): number[] => {
      const index = (png.width * y + x) << 2
      return [png.data[index], png.data[index + 1], png.data[index + 2]]
    }
    // Frame 3: the box sits near x=72 — its fill appears there but not at
    // frame 0's position.
    expect(pixelAt(72, 32)).toEqual([0xff, 0xaa, 0x00])
    const firstPng = PNG.sync.read(Buffer.from(first.png))
    const firstIndex = (firstPng.width * 32 + 72) << 2
    expect([firstPng.data[firstIndex], firstPng.data[firstIndex + 1]]).not.toEqual([0xff, 0xaa])
  })

  it('keeps the background empty when transparent is set', () => {
    const options = sanitizeExportOptions({ format: 'gif', fromFrame: 0, toFrame: 3, transparent: true }, DOCUMENT)
    const frame = renderFrame(DOCUMENT, 0, options, () => null)
    const png = PNG.sync.read(Buffer.from(frame.png))
    const index = (png.width * 2 + 2) << 2
    expect(png.data[index + 3]).toBe(0)
  })
})

describe('renderDocument', () => {
  it('packs a PNG sequence ZIP with one entry per frame', async () => {
    const options = sanitizeExportOptions({ format: 'png-sequence', fromFrame: 0, toFrame: 3 }, DOCUMENT)
    const outcome = await renderDocument(DOCUMENT, options, () => null)
    expect(outcome.frames).toHaveLength(4)
    const files = unzipSync(outcome.bytes!)
    expect(Object.keys(files)).toEqual([
      'frame_0000.png',
      'frame_0001.png',
      'frame_0002.png',
      'frame_0003.png'
    ])
  })

  it('encodes an animated GIF with the requested fps delay', async () => {
    const options = sanitizeExportOptions({ format: 'gif', fromFrame: 0, toFrame: 3, fps: 25 }, DOCUMENT)
    const outcome = await renderDocument(DOCUMENT, options, () => null)
    const header = Buffer.from(outcome.bytes!.slice(0, 6)).toString('latin1')
    expect(header).toBe('GIF89a')
    expect(options.fps).toBe(25)
  })
})

describe('renderToFile', () => {
  it('writes the encoded bytes to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openanimator-cli-'))
    const outPath = join(dir, 'out.gif')
    const options = sanitizeExportOptions({ format: 'gif', fromFrame: 0, toFrame: 3 }, DOCUMENT)
    const outcome = await renderToFile(DOCUMENT, options, () => null, outPath)
    const written = await readFile(outPath)
    expect(written.byteLength).toBe(outcome.bytes!.byteLength)
    expect(Buffer.from(written.slice(0, 6)).toString('latin1')).toBe('GIF89a')
  })
})

describe('buildFfmpegArgs', () => {
  const framesPattern = 'frames/frame_%04d.png'
  const windowOptions = (format: 'webm' | 'mp4') =>
    sanitizeExportOptions({ format, fromFrame: 0, toFrame: 3, fps: 10 }, DOCUMENT)

  it('keeps the silent argument list when the plan is empty', () => {
    const args = buildFfmpegArgs([], windowOptions('webm'), {
      framesPattern,
      audioFiles: [],
      outPath: 'out.webm'
    })
    expect(args).toEqual([
      '-y', '-framerate', '10', '-i', framesPattern,
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', 'out.webm'
    ])
  })

  it('maps a single clip directly with atrim, adelay and apad', () => {
    const args = buildFfmpegArgs(
      [{ resourceId: 'r1', startFrame: 6, startSeconds: 0.6, volume: 0.5 }],
      windowOptions('webm'),
      { framesPattern, audioFiles: ['audio_0.wav'], outPath: 'out.webm' }
    )
    expect(args).toEqual([
      '-y', '-framerate', '10', '-i', framesPattern,
      '-i', 'audio_0.wav',
      '-filter_complex',
      '[1:a]atrim=start=0:end=0.4,asetpts=PTS-STARTPTS,adelay=600|600,volume=0.5,apad[a0]',
      '-map', '0:v', '-map', '[a0]',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-c:a', 'libopus',
      '-shortest', 'out.webm'
    ])
  })

  it('seeks into clips that started before the export range', () => {
    const args = buildFfmpegArgs(
      [{ resourceId: 'r1', startFrame: 2, startSeconds: -0.2, volume: 1 }],
      windowOptions('mp4'),
      { framesPattern, audioFiles: ['audio_0.mp3'], outPath: 'out.mp4' }
    )
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(filter).toBe(
      '[1:a]atrim=start=0.2:end=0.6,asetpts=PTS-STARTPTS,adelay=0|0,volume=1,apad[a0]'
    )
  })

  it('sums several clips through amix with normalization off', () => {
    const args = buildFfmpegArgs(
      [
        { resourceId: 'r1', startFrame: 0, startSeconds: 0, volume: 1 },
        { resourceId: 'r2', startFrame: 12, startSeconds: 1.2, volume: 0.25 }
      ],
      windowOptions('mp4'),
      { framesPattern, audioFiles: ['audio_0.wav', 'audio_1.mp3'], outPath: 'out.mp4' }
    )
    expect(args[args.indexOf('-filter_complex') + 1]).toBe(
      '[1:a]atrim=start=0:end=0.4,asetpts=PTS-STARTPTS,adelay=0|0,volume=1[a0];' +
        '[2:a]atrim=start=0:end=0.4,asetpts=PTS-STARTPTS,adelay=1200|1200,volume=0.25[a1];' +
        '[a0][a1]amix=inputs=2:normalize=0,apad[amix]'
    )
    // mp4 encodes with libx264/aac; the output length follows the video.
    expect(args).toContain('libx264')
    expect(args).toContain('aac')
    expect(args).toContain('-shortest')
    expect(args[args.indexOf('-map') + 1]).toBe('0:v')
    expect(args[args.indexOf('-map', args.indexOf('-map') + 1) + 1]).toBe('[amix]')
  })
})

const NOTO_400 = 'node_modules/@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf'
function loadSubsetBytes(chars: readonly string[]): Uint8Array {
  const source = new Uint8Array(readFileSync(NOTO_400))
  return subsetFont(source, chars, embeddedFontId('Lato', 400))
}

/** DOCUMENT plus one embedded Lato/400 subset and a text node using it. */
function embeddedDocument(): AnimatorDocument {
  const document = structuredClone(DOCUMENT)
  document.fonts.push({
    id: embeddedFontId('Lato', 400),
    family: 'Lato',
    weight: 400,
    resourceId: 'font-res',
    glyphs: ['I', 'o'],
    license: 'OFL-1.1'
  })
  document.layers.push({
    kind: 'object',
    id: 'lay2',
    name: 'Text',
    visible: true,
    locked: false,
    keyframes: [
      {
        frame: 0,
        nodes: [
          {
            type: 'text',
            id: 'txt1',
            text: 'Io',
            fontFamily: 'Lato',
            fontSize: 24,
            fontWeight: 400,
            fill: '#ffffff',
            align: 'left',
            center: { x: 48, y: 32 },
            width: 40,
            height: 30,
            rotation: 0,
            opacity: 1
          }
        ]
      }
    ]
  })
  return document
}

describe('withEmbeddedFontFiles', () => {
  it('writes the referenced subsets to temp files for the run and removes them after', async () => {
    const document = embeddedDocument()
    const bytes = loadSubsetBytes(document.fonts[0].glyphs)
    const resources = new Map([[document.fonts[0].resourceId, { bytes, ext: 'ttf' }]])
    let seenDir = ''
    let seenBytes: Uint8Array | null = null
    const result = await withEmbeddedFontFiles(document, resources, async (fontFiles) => {
      expect(fontFiles).toHaveLength(1)
      expect(fontFiles[0].endsWith(`${document.fonts[0].id}.ttf`)).toBe(true)
      seenDir = dirname(fontFiles[0])
      seenBytes = new Uint8Array(await readFile(fontFiles[0]))
      return 'done'
    })

    expect(result).toBe('done')
    expect(seenBytes).toEqual(bytes)
    await expect(access(seenDir)).rejects.toThrow()
  })

  it('runs with an empty list without touching the file system when no subset is present', async () => {
    const received: string[][] = []
    await withEmbeddedFontFiles(embeddedDocument(), new Map(), (fontFiles) => {
      received.push(fontFiles)
      return Promise.resolve()
    })
    await withEmbeddedFontFiles(DOCUMENT, new Map(), (fontFiles) => {
      received.push(fontFiles)
      return Promise.resolve()
    })

    expect(received).toEqual([[], []])
  })

  it('renders a frame whose text resolves through the embedded subset family', async () => {
    const document = embeddedDocument()
    const bytes = loadSubsetBytes(document.fonts[0].glyphs)
    const resources = new Map([[document.fonts[0].resourceId, { bytes, ext: 'ttf' }]])
    const options = sanitizeExportOptions({ format: 'gif', fromFrame: 0, toFrame: 0 }, document)
    const frame = await withEmbeddedFontFiles(document, resources, (fontFiles) =>
      Promise.resolve(renderFrame(document, 0, options, createResourceResolver(resources), fontFiles))
    )

    expect(frame.width).toBe(96)
    expect(frame.height).toBe(64)
    const png = PNG.sync.read(Buffer.from(frame.png))
    let whitePixels = 0
    for (let index = 0; index < png.data.length; index += 4) {
      if (png.data[index] === 0xff && png.data[index + 1] === 0xff && png.data[index + 2] === 0xff) {
        whitePixels += 1
      }
    }
    expect(whitePixels).toBeGreaterThan(0)
  })
})
