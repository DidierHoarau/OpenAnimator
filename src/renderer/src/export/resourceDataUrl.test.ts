// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { ResourceCache } from '../resourceCache'

import { createResourceDataUrlResolver } from './resourceDataUrl'

describe('createResourceDataUrlResolver', () => {
  it('converts cached resources to data URLs and caches per id', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const resources = new ResourceCache({ 'res-1': bytes })
    let reads = 0
    const resolve = createResourceDataUrlResolver(resources, async (blob) => {
      reads += 1
      return `data:image/png;base64,${blob.size}`
    })

    const first = await resolve('res-1')
    const second = await resolve('res-1')

    expect(first).toBe('data:image/png;base64,7')
    expect(second).toBe(first)
    expect(reads).toBe(1)
  })

  it('resolves unknown ids to null without reading', async () => {
    const resources = new ResourceCache()
    const resolve = createResourceDataUrlResolver(resources, async () => 'data:x')
    expect(await resolve('missing')).toBeNull()
  })

  it('resolves to null when the read fails', async () => {
    const resources = new ResourceCache({ 'res-1': new Uint8Array([1]) })
    const resolve = createResourceDataUrlResolver(resources, async () => {
      throw new Error('reader failed')
    })
    expect(await resolve('res-1')).toBeNull()
  })
})
