import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  abortStagedExports,
  commitExportStream,
  openExportStream,
  writeExportStream
} from './exports'

describe('staged export writes', () => {
  let root: string
  let dest: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openanimator-export-'))
    dest = join(root, 'out.zip')
  })

  afterEach(async () => {
    await abortStagedExports()
    await rm(root, { recursive: true, force: true })
  })

  it('open/write/commit produces the destination and removes the temp', async () => {
    const opened = await openExportStream(dest)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return

    // Staged: nothing at the destination yet, the temp starts empty.
    expect(existsSync(dest)).toBe(false)
    expect((await stat(`${dest}.tmp`)).size).toBe(0)

    await writeExportStream(opened.token, new Uint8Array([1, 2]))
    const staged = await stat(`${dest}.tmp`)
    expect(staged.size).toBe(2)

    await writeExportStream(opened.token, new Uint8Array([3]))
    const committed = await commitExportStream(opened.token, true)

    expect(committed).toEqual({ ok: true })
    expect([...new Uint8Array(await readFile(dest))]).toEqual([1, 2, 3])
    expect(existsSync(`${dest}.tmp`)).toBe(false)
  })

  it('abort removes the temp and never creates the destination', async () => {
    const opened = await openExportStream(dest)
    if (!opened.ok) throw new Error(opened.error)
    await writeExportStream(opened.token, new Uint8Array([1]))

    const aborted = await commitExportStream(opened.token, false)

    expect(aborted).toEqual({ ok: true })
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.tmp`)).toBe(false)
  })

  it('reports unknown tokens instead of writing anything', async () => {
    expect(await writeExportStream('missing', new Uint8Array([1]))).toEqual({
      ok: false,
      error: 'Export stream is no longer open'
    })
    expect(await commitExportStream('missing', true)).toEqual({
      ok: false,
      error: 'Export stream is no longer open'
    })
    expect(existsSync(dest)).toBe(false)
  })

  it('rejects writes after the stream was committed', async () => {
    const opened = await openExportStream(dest)
    if (!opened.ok) throw new Error(opened.error)
    await commitExportStream(opened.token, true)

    const late = await writeExportStream(opened.token, new Uint8Array([9]))
    expect(late.ok).toBe(false)
  })

  it('reports commit errors and removes the temp', async () => {
    // A directory at the destination makes the final rename fail.
    await mkdir(dest)
    const opened = await openExportStream(dest)
    if (!opened.ok) throw new Error(opened.error)
    await writeExportStream(opened.token, new Uint8Array([1, 2]))

    const committed = await commitExportStream(opened.token, true)

    expect(committed.ok).toBe(false)
    expect(existsSync(`${dest}.tmp`)).toBe(false)
  })

  it('abortStagedExports cleans up leftover sessions', async () => {
    const first = await openExportStream(dest)
    const secondDest = join(root, 'other.zip')
    const second = await openExportStream(secondDest)
    if (!first.ok || !second.ok) throw new Error('open failed')
    await writeExportStream(first.token, new Uint8Array([1]))
    await writeExportStream(second.token, new Uint8Array([2]))

    await abortStagedExports()

    expect(existsSync(`${dest}.tmp`)).toBe(false)
    expect(existsSync(`${secondDest}.tmp`)).toBe(false)
    expect(existsSync(dest)).toBe(false)
    // Sessions are gone: a late commit reports the closed stream.
    expect((await commitExportStream(first.token, true)).ok).toBe(false)
  })
})
