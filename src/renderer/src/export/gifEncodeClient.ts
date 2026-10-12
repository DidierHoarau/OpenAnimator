import { createIncrementalGifEncoder } from '@shared/gifEncode'
import type { GifFrame } from '@shared/gifEncode'

/** Frame-at-a-time GIF encoder used by the export runner; `dispose()` frees
 * the worker (or is a no-op for the inline fallback) after finish or a
 * canceled/failed export. */
export interface GifEncodeClient {
  addFrame(frame: GifFrame, onProgress?: (done: number) => void): Promise<void>
  finish(): Promise<Uint8Array>
  dispose(): void
}

type WorkerReply =
  | { type: 'progress'; done: number }
  | { type: 'done'; bytes: Uint8Array }
  | { type: 'error'; error: string }

/**
 * Creates a GIF encoder client: a real worker when the environment provides
 * `Worker` (the export UI — keeps encoding off the render thread), the inline
 * incremental encoder otherwise (unit tests, degraded environments). Calls
 * must be issued sequentially — the runner awaits every frame — so replies
 * need no correlation ids.
 */
export async function createGifEncodeClient(): Promise<GifEncodeClient> {
  if (typeof Worker === 'undefined') return createInlineClient()
  try {
    const { default: GifEncodeWorker } = await import('./gifEncodeWorker?worker')
    return createWorkerClient(new GifEncodeWorker())
  } catch {
    // Worker bundling unavailable (or blocked): encoding still works inline.
    return createInlineClient()
  }
}

function createWorkerClient(worker: Worker): GifEncodeClient {
  let pendingFrame: { resolve: () => void; reject: (error: Error) => void } | null = null
  let pendingDone: { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void } | null =
    null
  let progress: ((done: number) => void) | null = null

  const fail = (message: string): void => {
    const error = new Error(message)
    progress = null
    pendingFrame?.reject(error)
    pendingFrame = null
    pendingDone?.reject(error)
    pendingDone = null
  }

  worker.onmessage = (event: MessageEvent): void => {
    const reply = event.data as WorkerReply
    if (reply.type === 'progress') {
      progress?.(reply.done)
      progress = null
      pendingFrame?.resolve()
      pendingFrame = null
    } else if (reply.type === 'done') {
      pendingDone?.resolve(reply.bytes)
      pendingDone = null
    } else {
      fail(reply.error)
    }
  }
  worker.onerror = (event): void => fail(event.message || 'GIF encoding worker failed')

  return {
    addFrame(frame, onProgress) {
      return new Promise((resolve, reject) => {
        progress = onProgress ?? null
        pendingFrame = { resolve, reject }
        const data = toBytes(frame.data)
        worker.postMessage(
          {
            type: 'frame',
            data,
            width: frame.width,
            height: frame.height,
            delayMs: frame.delayMs
          },
          [data.buffer]
        )
      })
    },
    finish() {
      return new Promise((resolve, reject) => {
        pendingDone = { resolve, reject }
        worker.postMessage({ type: 'finish' })
      })
    },
    dispose() {
      worker.terminate()
      fail('GIF encoding was canceled')
    }
  }
}

function createInlineClient(): GifEncodeClient {
  const encoder = createIncrementalGifEncoder()
  let done = 0
  return {
    async addFrame(frame, onProgress): Promise<void> {
      encoder.addFrame(frame)
      done++
      onProgress?.(done)
    },
    async finish(): Promise<Uint8Array> {
      return encoder.finish()
    },
    dispose(): void {
      // Nothing to release: the inline encoder has no resources of its own.
    }
  }
}

function toBytes(data: Uint8Array | Uint8ClampedArray): Uint8Array {
  if (data instanceof Uint8Array) return data
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}
