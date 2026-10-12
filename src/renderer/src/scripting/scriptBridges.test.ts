// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { isAudioLayer, isObjectLayer } from '@shared/model'
import type { SceneNode } from '@shared/model'
import { defaultExportOptions } from '@shared/exportOptions'
import { createStarterDocument } from '@shared/starterDocument'

import { Editor } from '../editor'
import {
  createScriptExportBridge,
  createScriptImportAudioBridge,
  createScriptImportImageBridge
} from './scriptBridges'

const WAV_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
const SVG_SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30" viewBox="0 0 40 30">' +
  '<rect x="0" y="0" width="40" height="30" fill="#336699"/></svg>'

function createEditor(): Editor {
  return new Editor(createStarterDocument(), {
    measureText: (line: string) => line.length * 10
  })
}

function stubApi(api: Record<string, unknown>): () => void {
  const previous = window.api
  window.api = api as unknown as typeof window.api
  return () => {
    window.api = previous
  }
}

function findNode(editor: Editor, nodeId: string): SceneNode | null {
  for (const layer of editor.document.layers) {
    if (!isObjectLayer(layer)) continue
    for (const keyframe of layer.keyframes) {
      const node = keyframe.nodes.find((entry) => entry.id === nodeId)
      if (node) return node
    }
  }
  return null
}

describe('script bridges', () => {
  it('importImage picks a file through the OS dialog and reuses the byte path', async () => {
    const editor = createEditor()
    const pickImageFile = vi.fn(() =>
      Promise.resolve({
        canceled: false as const,
        fileName: 'badge.svg',
        bytes: new TextEncoder().encode(SVG_SOURCE)
      })
    )
    const restore = stubApi({ pickImageFile })
    try {
      const bridge = createScriptImportImageBridge(editor)
      const result = await bridge({
        frame: 3,
        at: { x: 120, y: 90 },
        name: 'Badge',
        width: 80,
        height: 60
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error)
      expect(pickImageFile).toHaveBeenCalledWith('Import image')
      expect(editor.currentFrame).toBe(3)
      // The SVG imports as vectors on the requested layer/frame, then the
      // scripted name/size overrides land in the same undo entry.
      expect(findNode(editor, result.nodeId)).toMatchObject({
        name: 'Badge',
        width: 80,
        height: 60,
        center: { x: 120, y: 90 }
      })

      // A canceled picker and an unusable target layer fail cleanly.
      pickImageFile.mockResolvedValueOnce({ canceled: true as const })
      const canceled = await bridge({})
      expect(canceled).toEqual({ ok: false, error: 'no image file was chosen' })
      const missing = await bridge({ layerId: 'nope' })
      expect(missing.ok).toBe(false)
      if (!missing.ok) expect(missing.error).toContain('nope')
    } finally {
      restore()
    }
  })

  it('importAudio picks a file and reuses the audio import byte path', async () => {
    const editor = createEditor()
    const pickAudioFile = vi.fn(() =>
      Promise.resolve({ canceled: false as const, fileName: 'theme.wav', bytes: WAV_BYTES })
    )
    const addResource = vi.fn(() =>
      Promise.resolve({ resourceId: 'res-audio', deduped: false })
    )
    const restore = stubApi({ pickAudioFile, addResource })
    try {
      const result = await createScriptImportAudioBridge(editor)({ startFrame: 4 })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error)
      expect(addResource).toHaveBeenCalledWith(WAV_BYTES, 'theme.wav')
      const layer = editor.document.layers.find((entry) => entry.id === result.layerId)
      expect(layer && isAudioLayer(layer)).toBe(true)
      expect(layer).toMatchObject({ name: 'theme.wav', startFrame: 4 })

      pickAudioFile.mockResolvedValueOnce({ canceled: true as const })
      const canceled = await createScriptImportAudioBridge(editor)({})
      expect(canceled).toEqual({ ok: false, error: 'no audio file was chosen' })
    } finally {
      restore()
    }
  })

  it('export runs through the app pipeline and reports the destination', async () => {
    const editor = createEditor()
    const written: Array<{ path: string; bytes: Uint8Array }> = []
    const api = {
      pickExportPath: vi.fn(() => Promise.resolve({ canceled: false as const, path: '/tmp/picked.json' })),
      writeExportFile: vi.fn((path: string, bytes: Uint8Array) => {
        written.push({ path, bytes })
        return Promise.resolve({ ok: true as const })
      }),
      openExportStream: vi.fn(),
      writeExportStream: vi.fn(),
      finishExportStream: vi.fn(),
      versions: vi.fn(() => Promise.resolve({ app: '9.9.9', electron: 'e', chrome: 'c', node: 'n' }))
    }
    const restore = stubApi(api)
    try {
      const bridge = createScriptExportBridge(editor)
      const options = defaultExportOptions(editor.document)
      options.format = 'lottie'

      // An explicit `out` skips the native save dialog.
      const scoped = await bridge(options, '/tmp/out.json')
      expect(scoped).toEqual({ ok: true, path: '/tmp/out.json' })
      expect(api.pickExportPath).not.toHaveBeenCalled()
      expect(written).toHaveLength(1)
      expect(written[0].path).toBe('/tmp/out.json')
      expect(String.fromCharCode(written[0].bytes[0])).toBe('{')

      // Without `out` the picker chooses the destination.
      const picked = await bridge(options)
      expect(picked).toEqual({ ok: true, path: '/tmp/picked.json' })
      expect(api.pickExportPath).toHaveBeenCalled()

      // Canceling the picker fails without writing a file.
      api.pickExportPath.mockResolvedValueOnce({ canceled: true as const })
      const canceled = await bridge(options)
      expect(canceled.ok).toBe(false)
      expect(written).toHaveLength(2)

      // Write failures surface their reason and record no successful file.
      api.writeExportFile.mockResolvedValueOnce({ ok: false as const, error: 'disk full' })
      const failed = await bridge(options)
      expect(failed.ok).toBe(false)
      expect(written).toHaveLength(2)
    } finally {
      restore()
    }
  })
})
