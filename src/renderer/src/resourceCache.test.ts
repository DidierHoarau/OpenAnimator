// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { ResourceCache, sniffResourceMime } from './resourceCache'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
const UNKNOWN_BYTES = new Uint8Array([1, 2, 3])
const TTF_BYTES = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x10])
const OTF_BYTES = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0x00, 0x10])
const TTC_BYTES = new Uint8Array([0x74, 0x74, 0x63, 0x66, 0x00, 0x01])
const WAV_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45])
const OGG_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02])
const MP3_ID3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00])
const MP3_FRAME_BYTES = new Uint8Array([0xff, 0xfb, 0x90, 0x00])

describe('sniffResourceMime', () => {
  it('recognizes PNG, JPEG, GIF and WebP magic bytes', () => {
    expect(sniffResourceMime(PNG_BYTES)).toBe('image/png')
    expect(sniffResourceMime(JPG_BYTES)).toBe('image/jpeg')
    expect(sniffResourceMime(GIF_BYTES)).toBe('image/gif')
    expect(sniffResourceMime(WEBP_BYTES)).toBe('image/webp')
    expect(sniffResourceMime(UNKNOWN_BYTES)).toBe('application/octet-stream')
  })

  it('recognizes TTF, OTF and TTC font magic bytes', () => {
    expect(sniffResourceMime(TTF_BYTES)).toBe('font/ttf')
    expect(sniffResourceMime(OTF_BYTES)).toBe('font/otf')
    expect(sniffResourceMime(TTC_BYTES)).toBe('font/collection')
  })

  it('recognizes WAV, OGG and MP3 audio magic bytes', () => {
    expect(sniffResourceMime(WAV_BYTES)).toBe('audio/wav')
    expect(sniffResourceMime(OGG_BYTES)).toBe('audio/ogg')
    expect(sniffResourceMime(MP3_ID3_BYTES)).toBe('audio/mpeg')
    // Bare MPEG frame sync, no ID3 tag.
    expect(sniffResourceMime(MP3_FRAME_BYTES)).toBe('audio/mpeg')
    expect(sniffResourceMime(new Uint8Array([0xff, 0x1f]))).toBe('application/octet-stream')
  })
})

describe('ResourceCache', () => {
  function deps() {
    const created: string[] = []
    const revoked: string[] = []
    return {
      created,
      revoked,
      createUrl: vi.fn((_blob: Blob) => {
        const url = `blob:mock-${created.length + 1}`
        created.push(url)
        return url
      }),
      revokeUrl: vi.fn((url: string) => {
        revoked.push(url)
      })
    }
  }

  it('wraps every resource as an object URL with the sniffed type', () => {
    const mocks = deps()
    const cache = new ResourceCache(
      { hashA: PNG_BYTES, hashB: JPG_BYTES },
      { createUrl: mocks.createUrl, revokeUrl: mocks.revokeUrl, decode: () => Promise.resolve({ width: 1, height: 1 }) }
    )
    expect(cache.size).toBe(2)
    expect(mocks.createUrl.mock.calls[0][0].type).toBe('image/png')
    expect(mocks.createUrl.mock.calls[1][0].type).toBe('image/jpeg')
    expect(cache.getUrl('hashA')).toBe('blob:mock-1')
    expect(cache.getUrl('missing')).toBeNull()
  })

  it('revokes all URLs on reset', () => {
    const mocks = deps()
    const cache = new ResourceCache(
      { hashA: PNG_BYTES },
      { createUrl: mocks.createUrl, revokeUrl: mocks.revokeUrl, decode: () => Promise.resolve({ width: 1, height: 1 }) }
    )
    cache.reset({})
    expect(mocks.revoked).toEqual(['blob:mock-1'])
    expect(cache.getUrl('hashA')).toBeNull()
  })

  it('marks resources undecodable as corrupt, drops their URL and notifies', async () => {
    const mocks = deps()
    const decode = vi.fn((blob: Blob) =>
      blob.type === 'image/jpeg' ? Promise.reject(new Error('bad bytes')) : Promise.resolve({ width: 4, height: 4 })
    )
    const listener = vi.fn()
    const cache = new ResourceCache(
      { good: PNG_BYTES, bad: JPG_BYTES },
      { createUrl: mocks.createUrl, revokeUrl: mocks.revokeUrl, decode }
    )
    cache.onChange(listener)
    await vi.waitFor(() => {
      expect(cache.isCorrupt('bad')).toBe(true)
    })
    expect(cache.getUrl('bad')).toBeNull()
    expect(cache.getUrl('good')).toBe('blob:mock-1')
    expect(mocks.revoked).toContain('blob:mock-2')
    expect(listener).toHaveBeenCalled()
  })

  it('recovers when a previously corrupt resource decodes after a reset', async () => {
    let shouldFail = true
    const cache = new ResourceCache(
      { hashA: PNG_BYTES },
      {
        createUrl: () => 'blob:mock',
        revokeUrl: () => undefined,
        decode: () => (shouldFail ? Promise.reject(new Error('nope')) : Promise.resolve({ width: 1, height: 1 }))
      }
    )
    await vi.waitFor(() => expect(cache.isCorrupt('hashA')).toBe(true))
    shouldFail = false
    cache.reset({ hashA: PNG_BYTES })
    await vi.waitFor(() => expect(cache.isCorrupt('hashA')).toBe(false))
    expect(cache.getUrl('hashA')).toBe('blob:mock')
  })

  it('validates all resources against their recorded blob (not a stale reset)', async () => {
    const decode = vi.fn(() => Promise.reject(new Error('always bad')))
    const cache = new ResourceCache(
      { hashA: PNG_BYTES },
      { createUrl: () => 'blob:x', revokeUrl: () => undefined, decode }
    )
    await vi.waitFor(() => expect(cache.isCorrupt('hashA')).toBe(true))
    cache.reset({})
    await Promise.resolve()
    expect(cache.size).toBe(0)
    expect(cache.isCorrupt('hashA')).toBe(false)
  })

  it('works without a decoder (validation skipped)', () => {
    const cache = new ResourceCache(
      { hashA: PNG_BYTES },
      { createUrl: () => 'blob:mock', revokeUrl: () => undefined, decode: null }
    )
    expect(cache.getUrl('hashA')).toBe('blob:mock')
  })

  it('never runs image decoding on font blobs (they would always fail)', async () => {
    const decode = vi.fn(() => Promise.reject(new Error('not an image')))
    const cache = new ResourceCache(
      { fontA: TTF_BYTES, fontB: OTF_BYTES, img: PNG_BYTES },
      { createUrl: () => 'blob:mock', revokeUrl: () => undefined, decode }
    )
    await vi.waitFor(() => expect(cache.isCorrupt('img')).toBe(true))
    expect(decode).toHaveBeenCalledTimes(1)
    expect(cache.isCorrupt('fontA')).toBe(false)
    expect(cache.isCorrupt('fontB')).toBe(false)
    expect(cache.getBlob('fontA')).not.toBeNull()
    expect(cache.getBlob('fontA')!.type).toBe('font/ttf')
  })

  it('keeps audio blobs with their exact sniffed type (decodeAudioData input)', async () => {
    const decode = vi.fn(() => Promise.reject(new Error('not an image')))
    const cache = new ResourceCache(
      { wav: WAV_BYTES, ogg: OGG_BYTES, mp3: MP3_ID3_BYTES, img: PNG_BYTES },
      { createUrl: () => 'blob:mock', revokeUrl: () => undefined, decode }
    )
    await vi.waitFor(() => expect(cache.isCorrupt('img')).toBe(true))
    // Only the image went through the decoder: audio can never decode as one.
    expect(decode).toHaveBeenCalledTimes(1)
    expect(cache.isCorrupt('wav')).toBe(false)
    expect(cache.isCorrupt('ogg')).toBe(false)
    expect(cache.getBlob('wav')?.type).toBe('audio/wav')
    expect(cache.getBlob('ogg')?.type).toBe('audio/ogg')
    expect(cache.getBlob('mp3')?.type).toBe('audio/mpeg')
    expect(cache.getUrl('wav')).not.toBeNull()
  })

  it('put() registers a new resource without touching the others', () => {
    const mocks = deps()
    const cache = new ResourceCache(
      { hashA: PNG_BYTES },
      { createUrl: mocks.createUrl, revokeUrl: mocks.revokeUrl, decode: null }
    )
    cache.put('hashB', JPG_BYTES)
    expect(cache.size).toBe(2)
    expect(cache.getUrl('hashB')).toBe('blob:mock-2')
    expect(mocks.revoked).toEqual([])
  })

  it('put() replaces an existing entry and revokes its old URL', () => {
    const mocks = deps()
    const cache = new ResourceCache(
      { hashA: PNG_BYTES },
      { createUrl: mocks.createUrl, revokeUrl: mocks.revokeUrl, decode: null }
    )
    cache.put('hashA', JPG_BYTES)
    expect(cache.size).toBe(1)
    expect(mocks.revoked).toEqual(['blob:mock-1'])
    expect(cache.getUrl('hashA')).toBe('blob:mock-2')
  })

  it('put() recovers a corrupt resource by re-validating only that entry', async () => {
    let shouldFail = true
    let created = 0
    const cache = new ResourceCache(
      { hashA: PNG_BYTES },
      {
        createUrl: () => `blob:mock-${++created}`,
        revokeUrl: () => undefined,
        decode: () => (shouldFail ? Promise.reject(new Error('nope')) : Promise.resolve({ width: 1, height: 1 }))
      }
    )
    await vi.waitFor(() => expect(cache.isCorrupt('hashA')).toBe(true))
    shouldFail = false
    cache.put('hashA', PNG_BYTES)
    await vi.waitFor(() => expect(cache.isCorrupt('hashA')).toBe(false))
    expect(cache.getUrl('hashA')).not.toBeNull()
  })
})
