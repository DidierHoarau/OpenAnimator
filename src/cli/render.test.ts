import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { unzipSync } from 'fflate'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'

import { packProject } from '../main/projectContainer'
import type { AnimatorDocument } from '../shared/model'
import { sanitizeExportOptions } from '../shared/exportOptions'
import { createResourceResolver, loadDocumentAndResources, renderDocument, renderFrame, renderToFile } from './render'

const DOCUMENT: AnimatorDocument = {
  schemaVersion: 5,
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
  assets: []
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
