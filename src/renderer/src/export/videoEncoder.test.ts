// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { CanceledError, canEncodeVideo } from './videoEncoder'

describe('video encoder environment', () => {
  it('reports that video encoding is unavailable without WebCodecs', () => {
    // happy-dom (and the headless CLI) have no WebCodecs; the Electron
    // renderer does. The runner refuses video exports with a clear error
    // instead of failing mid-encode.
    expect(canEncodeVideo()).toBe(false)
  })

  it('exposes a distinct cancellation error', () => {
    const error = new CanceledError()
    expect(error.name).toBe('CanceledError')
    expect(error.message).toContain('canceled')
  })
})
