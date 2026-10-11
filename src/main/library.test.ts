import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Asset, GroupNode, SceneNode } from '../shared/model'
import { resourceStore } from './resources'
import { LibraryStore } from './library'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7])

function imageNode(id: string, resourceId: string): SceneNode {
  return {
    id,
    type: 'image',
    resourceId,
    center: { x: 0, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    naturalWidth: 10,
    naturalHeight: 10,
    smoothing: true
  }
}

function symbolNode(id: string, assetId: string): SceneNode {
  return {
    id,
    type: 'symbol',
    assetId,
    center: { x: 0, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1
  }
}

function symbolContent(children: SceneNode[]): GroupNode {
  return {
    type: 'group',
    id: 'content',
    center: { x: 0, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    children
  }
}

function symbolAsset(id: string, children: SceneNode[]): Asset {
  return { id, name: id, kind: 'symbol', content: symbolContent(children), createdAt: 1 }
}

function imageAsset(id: string, resourceId: string): Asset {
  return { id, name: id, kind: 'image', resourceId, naturalWidth: 4, naturalHeight: 3, createdAt: 1 }
}

describe('LibraryStore', () => {
  let baseDir: string
  let store: LibraryStore

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'openanimator-library-'))
    store = new LibraryStore(baseDir)
  })

  afterEach(async () => {
    resourceStore.reset(new Map())
    await rm(baseDir, { recursive: true, force: true })
  })

  it('lists an empty library when nothing was stored', async () => {
    await expect(store.list()).resolves.toEqual({ assets: [], resources: {} })
  })

  it('round-trips an image asset with its resource bytes', async () => {
    resourceStore.reset(new Map([['hash-a', { bytes: PNG_BYTES, ext: 'png' }]]))
    await store.add(imageAsset('a', 'hash-a'))

    const result = await store.list()
    expect(result.assets).toEqual([imageAsset('a', 'hash-a')])
    expect(result.resources['hash-a']).toEqual({ bytes: PNG_BYTES, ext: 'png' })
    // The resource landed in the resources folder, named by id + ext.
    const files = await readdir(join(baseDir, 'resources'))
    expect(files).toEqual(['hash-a.png'])
  })

  it('round-trips a symbol asset and the resources referenced by its content', async () => {
    resourceStore.reset(
      new Map([
        ['hash-a', { bytes: PNG_BYTES, ext: 'png' }],
        ['hash-b', { bytes: JPG_BYTES, ext: 'jpg' }]
      ])
    )
    await store.add(symbolAsset('s', [imageNode('img', 'hash-a')]))

    const result = await store.list()
    expect(result.assets).toHaveLength(1)
    expect(result.resources['hash-a']).toEqual({ bytes: PNG_BYTES, ext: 'png' })
    expect(result.resources['hash-b']).toBeUndefined()
  })

  it('resolves nested symbol references against the stored context', async () => {
    resourceStore.reset(new Map([['hash-inner', { bytes: PNG_BYTES, ext: 'png' }]]))
    await store.add(symbolAsset('inner', [imageNode('img', 'hash-inner')]))
    await store.add(symbolAsset('outer', [symbolNode('ref', 'inner')]))

    const result = await store.list()
    expect(Object.keys(result.resources)).toEqual(['hash-inner'])
  })

  it('rejects invalid assets without writing the index', async () => {
    const invalid = { id: 'x', name: 'x', kind: 'texture', createdAt: 1 } as unknown as Asset
    await expect(store.add(invalid)).resolves.toBe(false)
    await expect(store.add({ id: 'y', name: 'y' } as unknown as Asset)).resolves.toBe(false)
    await expect(store.list()).resolves.toEqual({ assets: [], resources: {} })
  })

  it('replaces an existing entry with the same id (upsert)', async () => {
    await store.add(imageAsset('a', 'hash-1'))
    const renamed = { ...imageAsset('a', 'hash-1'), name: 'renamed' }
    await store.add(renamed)
    await expect(store.list()).resolves.toMatchObject({ assets: [renamed] })
  })

  it('removes an asset and reports unknown ids', async () => {
    await store.add(imageAsset('a', 'hash-1'))
    await store.add(imageAsset('b', 'hash-1'))
    await expect(store.remove('a')).resolves.toBe(true)
    const result = await store.list()
    expect(result.assets.map((asset) => asset.id)).toEqual(['b'])
    await expect(store.remove('a')).resolves.toBe(false)
  })

  it('keeps resource files when an asset is removed', async () => {
    resourceStore.reset(new Map([['hash-a', { bytes: PNG_BYTES, ext: 'png' }]]))
    await store.add(imageAsset('a', 'hash-a'))
    await store.remove('a')
    const files = await readdir(join(baseDir, 'resources'))
    expect(files).toEqual(['hash-a.png'])
  })

  it('renames an asset and reports unknown ids', async () => {
    await store.add(imageAsset('a', 'hash-1'))
    await expect(store.rename('a', 'Rocket')).resolves.toBe(true)
    const result = await store.list()
    expect(result.assets[0].name).toBe('Rocket')
    await expect(store.rename('gone', 'x')).resolves.toBe(false)
  })

  it('lists an asset whose resource file is missing (placeholder on use)', async () => {
    await store.add(imageAsset('a', 'hash-missing'))
    const result = await store.list()
    expect(result.assets.map((asset) => asset.id)).toEqual(['a'])
    expect(result.resources).toEqual({})
  })

  it('drops invalid entries from the index but keeps valid ones', async () => {
    resourceStore.reset(new Map())
    await store.add(imageAsset('a', 'hash-1'))
    const indexPath = join(baseDir, 'library.json')
    const raw = JSON.parse(await readFile(indexPath, 'utf8'))
    raw.assets.push({ garbage: true })
    await writeFile(indexPath, JSON.stringify(raw), 'utf8')
    const result = await store.list()
    expect(result.assets.map((asset) => asset.id)).toEqual(['a'])
  })

  it('survives an unreadable index file', async () => {
    await writeFile(join(baseDir, 'library.json'), '{not json', 'utf8')
    await expect(store.list()).resolves.toEqual({ assets: [], resources: {} })
  })

  it('writes the index atomically (no leftover temp file)', async () => {
    await store.add(imageAsset('a', 'hash-1'))
    const files = await readdir(baseDir)
    expect(files).toEqual(['library.json', 'resources'])
  })

  it('is independent from the session store contents at list time', async () => {
    resourceStore.reset(new Map([['hash-a', { bytes: PNG_BYTES, ext: 'png' }]]))
    await store.add(imageAsset('a', 'hash-a'))
    resourceStore.reset(new Map())
    const result = await store.list()
    expect(result.resources['hash-a']).toEqual({ bytes: PNG_BYTES, ext: 'png' })
  })

  it('sanitizes hostile resource extensions when writing files', async () => {
    resourceStore.reset(new Map([['hash-a', { bytes: PNG_BYTES, ext: '../../evil' }]]))
    await store.add(imageAsset('a', 'hash-a'))
    // Path separators and dots are stripped, so the write stays inside the
    // resources folder.
    const files = await readdir(join(baseDir, 'resources'))
    expect(files).toEqual(['hash-a.evil'])
  })
})
