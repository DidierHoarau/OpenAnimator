import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PaletteStore, importPaletteFile } from './palette'
import type { PaletteImportDeps } from './palette'

describe('PaletteStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-palette-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads an empty palette when no file exists', async () => {
    const store = new PaletteStore(dir)
    await expect(store.load()).resolves.toEqual([])
  })

  it('round-trips colors through save/load, normalized on write', async () => {
    const store = new PaletteStore(dir)
    await expect(store.save(['#FF0000', 'bogus', '#ff0000', '#ABC'])).resolves.toBe(true)
    await expect(store.load()).resolves.toEqual(['#ff0000', '#aabbcc'])
  })

  it('caps saved palettes at 48 colors', async () => {
    const store = new PaletteStore(dir)
    const colors = Array.from({ length: 80 }, (_, index) => `#${index.toString(16).padStart(6, '0')}`)
    await store.save(colors)
    const loaded = await store.load()
    expect(loaded).toHaveLength(48)
    expect(loaded[0]).toBe('#000000')
    expect(loaded[47]).toBe(`#${(47).toString(16).padStart(6, '0')}`)
  })

  it('normalizes colors on read too (files may be edited by hand)', async () => {
    await writeFile(
      join(dir, 'palette.json'),
      JSON.stringify({ version: 1, colors: ['#ABC', '#abc', 'nope', 42] }),
      'utf8'
    )
    const store = new PaletteStore(dir)
    await expect(store.load()).resolves.toEqual(['#aabbcc'])
  })

  it('reads a corrupted file as an empty palette', async () => {
    await writeFile(join(dir, 'palette.json'), '{not json', 'utf8')
    const store = new PaletteStore(dir)
    await expect(store.load()).resolves.toEqual([])
  })

  it('reads malformed payload shapes as an empty palette', async () => {
    const store = new PaletteStore(dir)
    for (const payload of ['[]', '42', '"nope"', '{"colors":"nope"}', '{"colors":[1,2]}', 'null']) {
      await writeFile(join(dir, 'palette.json'), payload, 'utf8')
      await expect(store.load()).resolves.toEqual([])
    }
  })

  it('writes a versioned JSON payload atomically, leaving no temp file behind', async () => {
    const nested = join(dir, 'user-data')
    const store = new PaletteStore(nested)
    await store.save(['#123456'])
    const raw = await readFile(join(nested, 'palette.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual({ version: 1, colors: ['#123456'] })
    expect((await readdir(nested)).sort()).toEqual(['palette.json'])
  })
})

describe('importPaletteFile', () => {
  function deps(
    dialogResult: { canceled: boolean; filePaths: string[] },
    file?: { text?: string; error?: Error }
  ): PaletteImportDeps {
    return {
      showOpenDialog: () => Promise.resolve(dialogResult),
      readFile: () => {
        if (file?.error) return Promise.reject(file.error)
        return Promise.resolve(file?.text ?? '')
      }
    }
  }

  it('returns the file name and text for a chosen file', async () => {
    const result = await importPaletteFile(
      deps(
        { canceled: false, filePaths: [join('some', 'dir', 'sunset.gpl')] },
        { text: 'GIMP Palette\n255 0 0\n' }
      )
    )
    expect(result).toEqual({ canceled: false, fileName: 'sunset.gpl', text: 'GIMP Palette\n255 0 0\n' })
  })

  it('reports cancellation', async () => {
    await expect(importPaletteFile(deps({ canceled: true, filePaths: [] }))).resolves.toEqual({
      canceled: true
    })
  })

  it('reports an empty selection as canceled', async () => {
    await expect(importPaletteFile(deps({ canceled: false, filePaths: [] }))).resolves.toEqual({
      canceled: true
    })
  })

  it('reports read failures with the reason', async () => {
    const result = await importPaletteFile(
      deps({ canceled: false, filePaths: ['missing.gpl'] }, { error: new Error('EACCES') })
    )
    expect(result.canceled).toBe(true)
    if (result.canceled) expect(result.error).toContain('EACCES')
  })
})
