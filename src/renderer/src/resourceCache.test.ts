// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { ResourceCache, sniffImageMime } from './resourceCache'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
const UNKNOWN_BYTES = new Uint8Array([1, 2, 3])

describe('sniffImageMime', () => {
  it('recognizes PNG, JPEG, GIF and WebP magic bytes', () => {
    expect(sniffImageMime(PNG_BYTES)).toBe('image/png')
    expect(sniffImageMime(JPG_BYTES)).toBe('image/jpeg')
    expect(sniffImageMime(GIF_BYTES)).toBe('image/gif')
    expect(sniffImageMime(WEBP_BYTES)).toBe('image/webp')
    expect(sniffImageMime(UNKNOWN_BYTES)).toBe('application/octet-stream')
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
