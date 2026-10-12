import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrateDocument } from '../shared/migrate'
import type { AnimatorDocument, ImageNode } from '../shared/model'
import type { ProjectResourceMap } from './projectContainer'
import { RecoveryStore } from './recovery'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function imageNode(id: string, resourceId: string): ImageNode {
  return {
    id,
    type: 'image',
    resourceId,
    center: { x: 100, y: 100 },
    width: 320,
    height: 240,
    rotation: 0,
    opacity: 1,
    naturalWidth: 640,
    naturalHeight: 480,
    smoothing: true
  }
}

function documentWithImage(name: string, resourceId: string): AnimatorDocument {
  const document = migrateDocument({
    name,
    width: 320,
    height: 180,
    fps: 12,
    background: '#10151b',
    layers: [
      {
        id: 'layer-1',
        name: 'Layer 1',
        visible: true,
        locked: false,
        keyframes: [{ frame: 0, shapes: [] }]
      }
    ]
  })
  const layer = document.layers[0]
  if (layer.kind !== 'object') throw new Error('expected an object layer')
  layer.keyframes[0].nodes.push(imageNode('img-1', resourceId))
  return document
}

function resources(entries: Array<[string, Uint8Array, string]>): ProjectResourceMap {
  return new Map(entries.map(([id, bytes, ext]) => [id, { bytes, ext }]))
}

describe('RecoveryStore', () => {
  let root: string
  let baseDir: string
  let store: RecoveryStore
  let projectPath: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openanimator-recovery-'))
    baseDir = join(root, 'recovery')
    store = new RecoveryStore(baseDir)
    projectPath = join(root, 'project.oanim')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('round-trips a document and its referenced resources through write → info → read', async () => {
    const document = documentWithImage('recovery-test', 'hash-a')
    await store.write(
      projectPath,
      document,
      resources([
        ['hash-a', PNG_BYTES, 'png'],
        ['hash-b', PNG_BYTES, 'jpg']
      ]),
      1728700000000
    )

    await expect(store.info(projectPath)).resolves.toEqual({
      path: projectPath,
      name: 'recovery-test',
      savedAt: 1728700000000,
      untitled: false
    })

    const snapshot = await store.read(projectPath)
    expect(snapshot.document).toEqual(document)
    expect(snapshot.resources.get('hash-a')).toEqual({ bytes: PNG_BYTES, ext: 'png' })
    // Unreferenced resources are dropped, exactly like a project save.
    expect(snapshot.resources.has('hash-b')).toBe(false)
    // The write is atomic: only the two slot files exist, no temp leftovers.
    await expect(readdir(baseDir)).resolves.toHaveLength(2)
  })

  it('offers a pending snapshot only while it is newer than the project file', async () => {
    const savedAt = Date.now()
    await store.write(projectPath, documentWithImage('recovery-test', 'hash-a'), resources([]), savedAt)
    await writeFile(projectPath, new Uint8Array([1, 2, 3]))
    const before = new Date(savedAt - 60000)
    await utimes(projectPath, before, before)

    await expect(store.pending(projectPath)).resolves.toMatchObject({ savedAt })

    // A manual save after the snapshot makes the file newer: nothing to offer.
    const after = new Date(savedAt + 60000)
    await utimes(projectPath, after, after)
    await expect(store.pending(projectPath)).resolves.toBeNull()
  })

  it('has no pending snapshot when the snapshot or the project file is missing', async () => {
    await expect(store.pending(projectPath)).resolves.toBeNull()

    await store.write(projectPath, documentWithImage('recovery-test', 'hash-a'), resources([]), Date.now())
    // The snapshot exists but the project file (needed for the comparison) does not.
    await expect(store.pending(projectPath)).resolves.toBeNull()
  })

  it('clear removes both the snapshot and its info and is a no-op afterwards', async () => {
    await store.write(projectPath, documentWithImage('recovery-test', 'hash-a'), resources([]), Date.now())
    await store.clear(projectPath)
    await expect(readdir(baseDir)).resolves.toEqual([])
    await expect(store.info(projectPath)).resolves.toBeNull()
    await store.clear(projectPath)
  })

  it('keeps the slots of different project paths independent', async () => {
    const otherPath = join(root, 'other.oanim')
    await store.write(projectPath, documentWithImage('first', 'hash-a'), resources([]), 1)
    await store.write(otherPath, documentWithImage('second', 'hash-b'), resources([]), 2)

    await expect(store.read(projectPath)).resolves.toMatchObject({ document: { name: 'first' } })
    await expect(store.read(otherPath)).resolves.toMatchObject({ document: { name: 'second' } })

    await store.clear(projectPath)
    await expect(store.info(projectPath)).resolves.toBeNull()
    await expect(store.info(otherPath)).resolves.toMatchObject({ name: 'second' })
  })

  it('treats a corrupt info file as absent', async () => {
    await store.write(projectPath, documentWithImage('recovery-test', 'hash-a'), resources([]), 1)
    const infoFile = (await readdir(baseDir)).find((file) => file.endsWith('.json'))!
    await writeFile(join(baseDir, infoFile), '{not json', 'utf8')
    await expect(store.info(projectPath)).resolves.toBeNull()
  })

  it('keeps offering an untitled snapshot without any project file', async () => {
    const key = 'untitled/session-1'
    await store.write(key, documentWithImage('draft', 'hash-a'), resources([]), 5, true)

    // No file exists at the key: an untitled snapshot is pending by definition.
    await expect(store.pending(key)).resolves.toMatchObject({ name: 'draft', untitled: true })
    const snapshot = await store.read(key)
    expect(snapshot.document.name).toBe('draft')

    await store.clear(key)
    await expect(store.pending(key)).resolves.toBeNull()
  })

  it('lists untitled snapshots newest first and never the file-backed ones', async () => {
    await store.write(projectPath, documentWithImage('file-back', 'hash-a'), resources([]), 9)
    await store.write('untitled/a', documentWithImage('older', 'hash-a'), resources([]), 10, true)
    await store.write('untitled/b', documentWithImage('newer', 'hash-a'), resources([]), 20, true)

    const unsaved = await store.listUnsaved()
    expect(unsaved.map((info) => info.name)).toEqual(['newer', 'older'])
  })

  it('prunes untitled slots beyond the cap, keeping the newest and the file-backed ones', async () => {
    await store.write(projectPath, documentWithImage('file-back', 'hash-a'), resources([]), 1)
    for (let index = 1; index <= 4; index++) {
      await store.write(`untitled/${index}`, documentWithImage(`draft-${index}`, 'hash-a'), resources([]), index, true)
    }

    const unsaved = await store.listUnsaved()
    expect(unsaved.map((info) => info.name)).toEqual(['draft-4', 'draft-3', 'draft-2'])
    // The oldest untitled slot is gone; the file-backed slot survives.
    await expect(store.info('untitled/1')).resolves.toBeNull()
    await expect(store.info(projectPath)).resolves.toMatchObject({ name: 'file-back' })
  })

  it('still parses snapshot infos written without the untitled field', async () => {
    await store.write(projectPath, documentWithImage('legacy', 'hash-a'), resources([]), 1)
    const infoFile = (await readdir(baseDir)).find((file) => file.endsWith('.json'))!
    await writeFile(
      join(baseDir, infoFile),
      JSON.stringify({ path: projectPath, name: 'legacy', savedAt: 1 }),
      'utf8'
    )
    await expect(store.info(projectPath)).resolves.toEqual({
      path: projectPath,
      name: 'legacy',
      savedAt: 1
    })
  })
})
