import { layoutText } from '@shared/textModel'
import { normalizePathData, pathDataBounds } from '@shared/pathModel'
import type { PathNode, TextNode } from '@shared/model'

import type { Editor } from './editor'
import { parse } from 'opentype.js'
import type { Font } from 'opentype.js'
import noto400Url from '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf?url'
import noto700Url from '@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf?url'

/**
 * Converts a selected text node into vector outlines: the bundled Noto Sans
 * TTFs (regular/bold) are parsed with opentype.js, every line's glyph paths
 * are laid out with the shared text metrics and merged into one multi-subpath
 * `PathNode` that keeps the text node's id, transform and fill.
 */

const FONT_URLS: Record<number, string> = { 400: noto400Url, 700: noto700Url }
const fontCache = new Map<number, Promise<Font | null>>()

function loadFont(weight: number): Promise<Font | null> {
  const cached = fontCache.get(weight)
  if (cached) return cached
  const url = FONT_URLS[weight] ?? FONT_URLS[400]
  const promise = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.arrayBuffer()
    })
    .then((buffer) => parse(buffer))
    .catch((error: unknown) => {
      console.warn('OpenAnimator: failed to load the bundled font', error)
      return null
    })
  fontCache.set(weight, promise)
  return promise
}

/**
 * Replaces the selected text node with its vector outlines. Returns false
 * (with a status message) when nothing text-like is selected or the font
 * cannot be loaded.
 */
export async function convertSelectedTextToOutlines(editor: Editor): Promise<boolean> {
  const layer = editor.currentLayer
  const primary = editor.primarySelectedNodeId
  if (!layer || layer.kind !== 'object' || !primary) {
    editor.showMessage('Select a text object to convert to outlines')
    return false
  }
  const keyframe = [...layer.keyframes]
    .reverse()
    .find((entry) => entry.frame <= editor.currentFrame && entry.nodes.some((node) => node.id === primary))
  const node = keyframe?.nodes.find((candidate): candidate is TextNode => {
    return candidate.id === primary && candidate.type === 'text'
  })
  if (!node) {
    editor.showMessage('Select a text object to convert to outlines')
    return false
  }
  const font = await loadFont(node.fontWeight >= 600 ? 700 : 400)
  if (!font) {
    editor.showMessage('The bundled font could not be loaded')
    return false
  }
  const layout = layoutText(node)
  let d = ''
  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i]
    if (line.length === 0) continue
    d += font.getPath(line, layout.anchorX, layout.baselines[i], node.fontSize).toPathData(2)
  }
  const bounds = pathDataBounds(d)
  if (!bounds) {
    editor.showMessage('The text has no glyphs to convert')
    return false
  }
  const replacement: PathNode = {
    id: node.id,
    ...(node.name !== undefined ? { name: node.name } : {}),
    type: 'path',
    center: { ...node.center },
    width: Math.max(2, bounds.width),
    height: Math.max(2, bounds.height),
    rotation: node.rotation,
    opacity: node.opacity,
    d: normalizePathData(d),
    fill: node.fill
  }
  const replaced = editor.replaceSelectedNode((current) =>
    current.id === node.id && current.type === 'text' ? replacement : current
  )
  if (replaced) {
    editor.showMessage(
      node.fontFamily === 'Noto Sans'
        ? 'Converted the text to vector outlines'
        : 'Converted the text to vector outlines using the bundled Noto Sans font'
    )
  }
  return replaced
}
