import { isDrawingLayer } from '@shared/model'

import type { Editor } from './editor'

/**
 * Warms the browser's image cache with every drawing-cell resource before
 * playback starts, so a flipbook does not stall on the first display of each
 * cell. The object URLs already exist in the session resource cache; decoding
 * is forced through detached `Image` elements. Per-editor and per-resource
 * bookkeeping keeps repeated playbacks free. Canvas compositing is the
 * documented fallback if profiling ever demands it.
 */
const preloaded = new WeakMap<Editor, Set<string>>()

export function preloadDrawingCells(editor: Editor): void {
  if (!editor.playing) return
  const done = preloaded.get(editor) ?? new Set<string>()
  for (const layer of editor.document.layers) {
    if (!isDrawingLayer(layer)) continue
    for (const cell of layer.cells) {
      if (done.has(cell.resourceId)) continue
      done.add(cell.resourceId)
      const url = editor.resources.getUrl(cell.resourceId)
      if (!url) continue
      const image = new Image()
      image.src = url
      void image.decode().catch(() => {})
    }
  }
  preloaded.set(editor, done)
}
