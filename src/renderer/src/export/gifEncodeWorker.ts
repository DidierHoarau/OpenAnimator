import { createIncrementalGifEncoder } from '@shared/gifEncode'
import type { GifFrame } from '@shared/gifEncode'

/** Minimal worker-global surface (tsconfig.web has no WebWorker lib). */
interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

type IncomingMessage =
  | {
      type: 'frame'
      data: Uint8ClampedArray | Uint8Array
      width: number
      height: number
      delayMs: number
    }
  | { type: 'finish' }

const scope = self as unknown as WorkerScope
const encoder = createIncrementalGifEncoder()
let done = 0

scope.onmessage = (event: MessageEvent): void => {
  const message = event.data as IncomingMessage
  try {
    if (message.type === 'frame') {
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
