import { createIncrementalGifEncoder } from '@shared/gifEncode'
import type { GifEncodeOptions, GifFrame, IncrementalGifEncoder } from '@shared/gifEncode'

/** Minimal worker-global surface (tsconfig.web has no WebWorker lib). */
interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

type IncomingMessage =
  | { type: 'options'; options?: Partial<GifEncodeOptions> }
  | {
      type: 'frame'
      data: Uint8ClampedArray | Uint8Array
      width: number
      height: number
      delayMs: number
    }
  | { type: 'finish' }

const scope = self as unknown as WorkerScope
// The encoder is constructed lazily on the first options/frame/finish message
// so the client's options (palette mode, dither, loop) are in place before any
// frame is encoded.
let encoder: IncrementalGifEncoder | null = null
let pendingOptions: Partial<GifEncodeOptions> | undefined
let done = 0

scope.onmessage = (event: MessageEvent): void => {
  const message = event.data as IncomingMessage
  try {
    if (message.type === 'options') {
      if (!encoder) pendingOptions = message.options
      return
    }
    if (message.type === 'frame') {
      encoder ??= createIncrementalGifEncoder(pendingOptions)
      const frame: GifFrame = {
        data: message.data,
        width: message.width,
        height: message.height,
        delayMs: message.delayMs
      }
      encoder.addFrame(frame)
      done++
      scope.postMessage({ type: 'progress', done })
    } else {
      encoder ??= createIncrementalGifEncoder(pendingOptions)
      const bytes = encoder.finish()
      scope.postMessage({ type: 'done', bytes }, [bytes.buffer])
    }
  } catch (error) {
    scope.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
