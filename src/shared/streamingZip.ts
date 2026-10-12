import { Zip, ZipDeflate } from 'fflate'

type Sink = (chunk: Uint8Array) => Promise<void>

/**
 * Incremental ZIP writer: fflate's streaming `Zip` produces chunks as files
 * are added and every chunk is handed to an async `sink` (an IPC write in the
 * renderer, a temp file append elsewhere) as soon as it exists, so a large
 * archive is never buffered in one contiguous buffer. Sink writes are
 * serialized and the first sink error is rethrown by `end()`.
 */
export class StreamingZip {
  private readonly zip: Zip
  private readonly sink: Sink
  private queue: Promise<void> = Promise.resolve()
  private failure: unknown = null
  private terminated = false

  constructor(sink: Sink) {
    this.sink = sink
    this.zip = new Zip((error, chunk) => {
      if (error) {
        this.failure ??= error
        return
      }
      this.enqueue(chunk)
    })
  }

  /** Adds a whole file. Entries larger than `chunkSize` are pushed in slices
   * so a single sink write stays bounded (the atlas PNG). */
  addFile(name: string, bytes: Uint8Array, chunkSize = bytes.byteLength): void {
    const file = new ZipDeflate(name, { level: 0 })
    this.zip.add(file)
    if (bytes.byteLength === 0) {
      file.push(bytes, true)
      return
    }
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      const end = offset + chunkSize
      file.push(bytes.subarray(offset, Math.min(end, bytes.byteLength)), end >= bytes.byteLength)
    }
  }

  /** Ends the archive; resolves once every chunk has reached the sink, then
   * rethrows the first sink (or ZIP) error if there was one. */
  async end(): Promise<void> {
    this.zip.end()
    await this.queue
    if (this.failure !== null && !this.terminated) throw this.failure
  }

  /** Stops delivering further chunks to the sink; in-flight writes finish,
   * but queued ones are dropped and `end()` no longer throws. */
  terminate(): void {
    this.terminated = true
  }

  private enqueue(chunk: Uint8Array): void {
    if (this.failure !== null || this.terminated) return
    this.queue = this.queue
      .then(() => {
        if (this.terminated || this.failure !== null) return
        return this.sink(chunk)
      })
      .catch((error: unknown) => {
        this.failure ??= error
      })
  }
}
