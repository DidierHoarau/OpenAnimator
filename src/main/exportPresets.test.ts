import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDocument } from '../shared/document'
import { defaultExportOptions } from '../shared/exportOptions'
import { emptyExportPresets } from '../shared/exportPresets'
import { ExportPresetsStore } from './exportPresets'

describe('ExportPresetsStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-presets-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const options = (): ReturnType<typeof defaultExportOptions> =>
    defaultExportOptions(createDocument('demo', 320, 180, 12))

  it('reads an empty set when no file exists', async () => {
    const store = new ExportPresetsStore(dir)
    await expect(store.load()).resolves.toEqual(emptyExportPresets())
  })

  it('round-trips presets and last-used through save/load', async () => {
    const store = new ExportPresetsStore(dir)
    const data = {
      version: 1,
      presets: [{ name: 'Hero webm', options: { ...options(), format: 'webm' as const } }],
      lastUsed: { ...options(), format: 'gif' as const }
    }
    await expect(store.save(data)).resolves.toBe(true)
    await expect(store.load()).resolves.toEqual(data)
  })

  it('sanitizes on write: malformed entries never reach the file', async () => {
    const store = new ExportPresetsStore(dir)
    await store.save({
      version: 99,
      presets: [
        { name: 'Keep', options: options() },
        { name: '', options: options() },
        { name: 'Bad', options: { ...options(), format: 'avi' as never } }
      ],
      lastUsed: { ...options(), scale: 99 }
    })
    const raw = JSON.parse(await readFile(join(dir, 'export-presets.json'), 'utf8')) as {
      version: number
      presets: unknown[]
      lastUsed: unknown
    }
    expect(raw.version).toBe(1)
    expect(raw.presets).toEqual([{ name: 'Keep', options: options() }])
    expect(raw.lastUsed).toBeNull()
  })

  it('sanitizes on read too (files may be edited by hand)', async () => {
    await writeFile(
      join(dir, 'export-presets.json'),
      JSON.stringify({ version: 1, presets: [{ name: 'X', options: { format: 'gif' } }], lastUsed: 'nope' }),
      'utf8'
    )
    const store = new ExportPresetsStore(dir)
    await expect(store.load()).resolves.toEqual(emptyExportPresets())
  })

  it('reads corrupted files as empty', async () => {
    await writeFile(join(dir, 'export-presets.json'), '{not json', 'utf8')
    const store = new ExportPresetsStore(dir)
    await expect(store.load()).resolves.toEqual(emptyExportPresets())
  })

  it('writes atomically, leaving no temp file behind', async () => {
    const nested = join(dir, 'user-data')
    const store = new ExportPresetsStore(nested)
    await store.save(emptyExportPresets())
    expect((await readdir(nested)).sort()).toEqual(['export-presets.json'])
  })
})
