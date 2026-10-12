import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { StreamingZip } from './streamingZip'

function collector(): { chunks: Uint8Array[]; sink: (chunk: Uint8Array) => Promise<void> } {
  const chunks: Uint8Array[] = []
  return {
    chunks,
    sink: async (chunk) => {
      chunks.push(chunk)
    }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

describe('StreamingZip', () => {
  it('streams a valid zip whose entries unzip to the added bytes', async () => {
    const { chunks, sink } = collector()
    const zip = new StreamingZip(sink)
    zip.addFile('a.txt', new TextEncoder().encode('alpha'))
    zip.addFile('b.bin', new Uint8Array([1, 2, 3, 4]))
    await zip.end()

    const files = unzipSync(concat(chunks))
    expect(new TextDecoder().decode(files['a.txt'])).toBe('alpha')
    expect([...files['b.bin']]).toEqual([1, 2, 3, 4])
  })

  it('produces the same entries when a file is pushed in slices', async () => {
    const payload = new Uint8Array(1000).map((_, index) => index % 251)
    const oneShot = collector()
    const sliced = collector()
    const zipA = new StreamingZip(oneShot.sink)
    zipA.addFile('data.bin', payload)
    await zipA.end()
    const zipB = new StreamingZip(sliced.sink)
    zipB.addFile('data.bin', payload, 64)
    await zipB.end()

    expect(unzipSync(concat(sliced.chunks))['data.bin']).toEqual(
      unzipSync(concat(oneShot.chunks))['data.bin']
    )
  })

  it('round-trips an empty file entry', async () => {
    const { chunks, sink } = collector()
    const zip = new StreamingZip(sink)
    zip.addFile('empty', new Uint8Array(0))
    await zip.end()

    expect(unzipSync(concat(chunks))['empty']).toEqual(new Uint8Array(0))
  })

  it('serializes slow sink writes in chunk order', async () => {
    const written: number[] = []
    let inFlight = 0
    let overlapped = false
    const zip = new StreamingZip(async (chunk) => {
      if (inFlight > 0) overlapped = true
      inFlight++
      await new Promise((resolve) => setTimeout(resolve, 1))
      written.push(chunk.byteLength)
      inFlight--
    })
    zip.addFile('one', new Uint8Array(10))
    zip.addFile('two', new Uint8Array(20))
    await zip.end()

    expect(overlapped).toBe(false)
    expect(written.length).toBeGreaterThan(2)
  })

  it('rethrows the first sink error from end()', async () => {
    let calls = 0
    const zip = new StreamingZip(async () => {
      calls++
      if (calls === 2) throw new Error('disk full')
    })
    zip.addFile('one', new Uint8Array(10))
    zip.addFile('two', new Uint8Array(10))

    await expect(zip.end()).rejects.toThrow('disk full')
    // Chunks enqueued before the failure are delivered; later ones are dropped.
    expect(calls).toBe(2)
  })

  it('terminate() drops queued chunks and end() stops throwing', async () => {
    const written: number[] = []
    const zip = new StreamingZip(async (chunk) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      written.push(chunk.byteLength)
      throw new Error('broken pipe')
    })
    zip.addFile('one', new Uint8Array(10))
    zip.terminate()
    await zip.end()

    expect(written).toEqual([])
  })
})
