// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { ResourceCache } from '../resourceCache'

import { createResourceBytesResolver } from './resourceBytes'

const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3])

describe('createResourceBytesResolver', () => {
  it('resolves cached resources to bytes plus extension and caches per id', async () => {
    const resources = new ResourceCache({ 'res-song': MP3_BYTES })
    let reads = 0
    const resolve = createResourceBytesResolver(resources, async (blob) => {
      reads += 1
      return new Uint8Array(await blob.arrayBuffer())
    })

    const first = await resolve('res-song')
    const second = await resolve('res-song')

    expect(first).toEqual({ bytes: MP3_BYTES, ext: 'mp3' })
    expect(second).toBe(first)
    expect(reads).toBe(1)
  })

  it('maps WAV and Ogg resources to their extensions', async () => {
    const wav = new Uint8Array(16)
    wav.set([0x52, 0x49, 0x46, 0x46], 0)
    wav.set([0x57, 0x41, 0x56, 0x45], 8)
    const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0])
    const resources = new ResourceCache({ wav, ogg })

    const resolve = createResourceBytesResolver(resources)
    expect((await resolve('wav'))?.ext).toBe('wav')
    expect((await resolve('ogg'))?.ext).toBe('ogg')
  })

  it('falls back to a bin extension for unrecognized audio types', async () => {
    const resources = new ResourceCache({ 'res-x': new Uint8Array([9, 9, 9, 9, 9]) })
    const resolve = createResourceBytesResolver(resources)
    const resolved = await resolve('res-x')
    expect(resolved?.ext).toBe('bin')
    expect(Array.from(resolved!.bytes)).toEqual([9, 9, 9, 9, 9])
  })

  it('resolves unknown ids to null without reading', async () => {
    const resources = new ResourceCache()
    const resolve = createResourceBytesResolver(resources, async () => {
      throw new Error('should not read')
    })
    expect(await resolve('missing')).toBeNull()
  })

  it('resolves to null when the read fails', async () => {
    const resources = new ResourceCache({ 'res-song': MP3_BYTES })
    const resolve = createResourceBytesResolver(resources, async () => {
      throw new Error('reader failed')
    })
    expect(await resolve('res-song')).toBeNull()
  })
})
