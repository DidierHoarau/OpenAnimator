import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_EMBEDDING_ALLOWLIST, matchEmbeddingPolicy } from '../shared/fontPolicy'
import { FontPolicyStore, mapFcWeight, parseFcList, pickNearestWeight, SystemFontIndex } from './fonts'
import type { FcFontFace } from './fonts'

const FC_OUTPUT = [
  'DejaVu Sans|Book|80|/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  'DejaVu Sans|Bold|200|/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  'DejaVu Sans|Oblique|80|/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
  'Noto Sans|Regular|80|/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
  'Noto Sans|Italic|80|/usr/share/fonts/truetype/noto/NotoSans-Italic.ttf',
  'Noto Sans|Bold|200|/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf'
].join('\n')

describe('parseFcList', () => {
  it('parses faces with their style and maps fontconfig weights to CSS weights', () => {
    expect(parseFcList(FC_OUTPUT)).toEqual([
      { family: 'DejaVu Sans', weight: 400, italic: false, file: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf' },
      { family: 'DejaVu Sans', weight: 700, italic: false, file: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' },
      { family: 'DejaVu Sans', weight: 400, italic: true, file: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf' },
      { family: 'Noto Sans', weight: 400, italic: false, file: '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf' },
      { family: 'Noto Sans', weight: 400, italic: true, file: '/usr/share/fonts/truetype/noto/NotoSans-Italic.ttf' },
      { family: 'Noto Sans', weight: 700, italic: false, file: '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf' }
    ])
  })

  it('maps nonstandard weights to the nearest CSS bucket', () => {
    expect(mapFcWeight(0)).toBe(100)
    expect(mapFcWeight(100)).toBe(500)
    expect(mapFcWeight(180)).toBe(600)
    expect(mapFcWeight(205)).toBe(800)
    expect(mapFcWeight(210)).toBe(900)
    expect(mapFcWeight(90)).toBe(400)
  })

  it('skips malformed lines, empty families and missing files', () => {
    const output = [
      '',
      '|Regular|80|/fonts/a.ttf',
      'NoFile|Regular|80|',
      'BadWeight|Regular|heavy|/fonts/a.ttf',
      'TooShort|Regular',
      'Ok|Black|210|/fonts/ok.ttf'
    ].join('\n')
    expect(parseFcList(output)).toEqual([{ family: 'Ok', weight: 900, italic: false, file: '/fonts/ok.ttf' }])
  })
})

describe('pickNearestWeight', () => {
  it('picks the nearest available weight, ties picking the lower one', () => {
    expect(pickNearestWeight([400, 700], 700)).toBe(700)
    expect(pickNearestWeight([400, 700], 600)).toBe(700)
    expect(pickNearestWeight([400, 700], 550)).toBe(400)
    expect(pickNearestWeight([300, 800], 550)).toBe(300)
    expect(pickNearestWeight([], 400)).toBeNull()
  })
})

describe('SystemFontIndex', () => {
  const faces: FcFontFace[] = [
    { family: 'DejaVu Sans', weight: 400, italic: false, file: '/fonts/DejaVuSans.ttf' },
    { family: 'DejaVu Sans', weight: 700, italic: false, file: '/fonts/DejaVuSans-Bold.ttf' },
    { family: 'DejaVu Sans', weight: 400, italic: false, file: '/fonts/DejaVuSans-dup.ttf' },
    { family: 'DejaVu Sans', weight: 400, italic: true, file: '/fonts/DejaVuSans-Oblique.ttf' },
    { family: 'Noto Sans', weight: 400, italic: false, file: '/fonts/NotoSans.ttf' }
  ]

  it('lists families with sorted deduplicated weights, loading lazily once', async () => {
    const loadFaces = vi.fn(async () => faces)
    const index = new SystemFontIndex({ loadFaces, readBytes: async () => new Uint8Array() })
    await expect(index.list()).resolves.toEqual([
      { family: 'DejaVu Sans', weights: [400, 700] },
      { family: 'Noto Sans', weights: [400] }
    ])
    await expect(index.list()).resolves.toEqual([
      { family: 'DejaVu Sans', weights: [400, 700] },
      { family: 'Noto Sans', weights: [400] }
    ])
    expect(loadFaces).toHaveBeenCalledTimes(1)
  })

  it('reads the nearest face, matching the family case-insensitively', async () => {
    const readBytes = vi.fn(async (filePath: string) => new Uint8Array([filePath.length]))
    const index = new SystemFontIndex({ loadFaces: async () => faces, readBytes })
    await expect(index.read('dejavu sans', 700)).resolves.toEqual(new Uint8Array(['/fonts/DejaVuSans-Bold.ttf'.length]))
    expect(readBytes).toHaveBeenCalledWith('/fonts/DejaVuSans-Bold.ttf')
    await expect(index.read('DejaVu Sans', 550)).resolves.toBeInstanceOf(Uint8Array)
    expect(readBytes).toHaveBeenLastCalledWith('/fonts/DejaVuSans.ttf')
  })

  it('reads the italic face only when asked for one', async () => {
    const readBytes = vi.fn(async (filePath: string) => new Uint8Array([filePath.length]))
    const index = new SystemFontIndex({ loadFaces: async () => faces, readBytes })
    await expect(index.read('DejaVu Sans', 400, true)).resolves.toBeInstanceOf(Uint8Array)
    expect(readBytes).toHaveBeenLastCalledWith('/fonts/DejaVuSans-Oblique.ttf')
    // No italic face installed → no silent upright fallback.
    await expect(index.read('Noto Sans', 400, true)).resolves.toBeNull()
  })

  it('returns null for unknown families without touching the file system', async () => {
    const readBytes = vi.fn(async () => new Uint8Array())
    const index = new SystemFontIndex({ loadFaces: async () => faces, readBytes })
    await expect(index.read('Missing Sans', 400)).resolves.toBeNull()
    expect(readBytes).not.toHaveBeenCalled()
  })

  it('degrades to an empty index when enumeration or reading fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = new SystemFontIndex({
      loadFaces: async () => {
        throw new Error('fc-list: command not found')
      },
      readBytes: async () => new Uint8Array()
    })
    await expect(failing.list()).resolves.toEqual([])
    await expect(failing.read('Noto Sans', 400)).resolves.toBeNull()

    const unreadable = new SystemFontIndex({
      loadFaces: async () => faces,
      readBytes: async () => {
        throw new Error('EACCES')
      }
    })
    await expect(unreadable.read('Noto Sans', 400)).resolves.toBeNull()
    warn.mockRestore()
  })
})

describe('FontPolicyStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oa-fonts-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('falls back to the built-in allowlist when no file exists', async () => {
    const store = new FontPolicyStore(dir)
    const policy = await store.effective()
    expect(policy.allow).toEqual(DEFAULT_EMBEDDING_ALLOWLIST)
    expect(policy.deny).toEqual([])
  })

  it('reads corrupted or malformed files as the built-in defaults', async () => {
    const store = new FontPolicyStore(dir)
    for (const payload of ['{not json', '[]', '42', '"nope"', '{"allow":"nope","deny":42}', 'null']) {
      await writeFile(join(dir, 'font-embedding.json'), payload, 'utf8')
      const policy = await store.effective()
      expect(policy.allow).toEqual(DEFAULT_EMBEDDING_ALLOWLIST)
      expect(policy.deny).toEqual([])
    }
  })

  it('extends the defaults with user rules and keeps deny patterns', async () => {
    await writeFile(
      join(dir, 'font-embedding.json'),
      JSON.stringify({
        version: 1,
        allow: [{ pattern: 'Kid Font*', license: 'Kid-License-1.0' }],
        deny: ['Roboto*']
      }),
      'utf8'
    )
    const store = new FontPolicyStore(dir)
    const policy = await store.effective()
    expect(policy.allow).toHaveLength(DEFAULT_EMBEDDING_ALLOWLIST.length + 1)
    expect(policy.allow[0]).toEqual({ pattern: 'Kid Font*', license: 'Kid-License-1.0' })
    expect(policy.deny).toEqual(['Roboto*'])
    expect(matchEmbeddingPolicy('Kid Font Pro', policy)).toBe('Kid-License-1.0')
    expect(matchEmbeddingPolicy('Roboto Mono', policy)).toBeNull()
  })

  it('lets a user rule override a built-in license label for the same pattern', async () => {
    await writeFile(
      join(dir, 'font-embedding.json'),
      JSON.stringify({ allow: [{ pattern: 'Noto Sans', license: 'Custom-1.0' }] }),
      'utf8'
    )
    const store = new FontPolicyStore(dir)
    const policy = await store.effective()
    expect(policy.allow).toHaveLength(DEFAULT_EMBEDDING_ALLOWLIST.length)
    expect(matchEmbeddingPolicy('Noto Sans', policy)).toBe('Custom-1.0')
  })

  it('skips invalid allow entries and empty deny patterns', async () => {
    await writeFile(
      join(dir, 'font-embedding.json'),
      JSON.stringify({
        allow: [{ pattern: '', license: 'X' }, { pattern: 'Ok', license: '' }, 'nope', 42, { pattern: ' Ok ', license: ' Fine ' }],
        deny: ['', 42, '  Keep  ']
      }),
      'utf8'
    )
    const store = new FontPolicyStore(dir)
    const policy = await store.effective()
    expect(policy.allow[0]).toEqual({ pattern: 'Ok', license: 'Fine' })
    expect(policy.allow).toHaveLength(DEFAULT_EMBEDDING_ALLOWLIST.length + 1)
    expect(policy.deny).toEqual(['Keep'])
  })
})
