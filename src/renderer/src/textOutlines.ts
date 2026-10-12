import { layoutText } from '@shared/textModel'
import { normalizePathData, pathDataBounds } from '@shared/pathModel'
import type { PathNode, TextNode } from '@shared/model'

import type { Editor } from './editor'
import { parse } from 'opentype.js'
import type { Font } from 'opentype.js'
import noto400Url from '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf?url'
import noto700Url from '@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf?url'

/**
 * Converts a selected text node into vector outlines. The node's own family
 * is used when it can be loaded — a system font through the main process, or
 * the bundled Noto Sans for the fallback family — and every line's glyph
 * paths are laid out with the shared text metrics (baselines, anchors and
 * letter spacing) and merged into one multi-subpath `PathNode` that keeps the
 * text node's id, transform and fill. Fonts that cannot be loaded fall back
 * to the bundled Noto Sans so the conversion always yields deterministic
 * outlines.
 */

const FONT_URLS: Record<number, string> = { 400: noto400Url, 700: noto700Url }
const fontBytesCache = new Map<number, Promise<Uint8Array | null>>()
const parsedFontCache = new Map<string, Promise<LoadedFont | null>>()

interface LoadedFont {
  font: Font
  /** True when the bundled Noto Sans stands in for the requested family. */
  bundled: boolean
}

function isBundledFamily(family: string): boolean {
  return family.trim().toLowerCase() === 'noto sans'
}

/** Bundled Noto Sans bytes nearest to `weight` (the bundle ships 400/700). */
export function loadBundledFontBytes(weight: number): Promise<Uint8Array | null> {
  const bucket = weight >= 600 ? 700 : 400
  const cached = fontBytesCache.get(bucket)
  if (cached) return cached
  const promise = fetch(FONT_URLS[bucket])
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.arrayBuffer()
    })
    .then((buffer) => new Uint8Array(buffer))
    .catch((error: unknown) => {
      console.warn('OpenAnimator: failed to load the bundled font', error)
      return null
    })
  fontBytesCache.set(bucket, promise)
  return promise
}

async function parseFontBytes(bytes: Uint8Array): Promise<Font | null> {
  try {
    return parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  } catch (error: unknown) {
    console.warn('OpenAnimator: failed to parse the font', error)
    return null
  }
}

async function readSystemFontBytes(family: string, weight: number): Promise<Uint8Array | null> {
  try {
    const result = await window.api.readSystemFont(family, weight)
    return result.ok ? new Uint8Array(result.bytes) : null
  } catch (error: unknown) {
    console.warn('OpenAnimator: failed to read the system font', error)
    return null
  }
}

function loadFontFor(node: TextNode): Promise<LoadedFont | null> {
  const family = node.fontFamily.trim()
  const key = `${family.toLowerCase()}|${node.fontWeight}`
  const cached = parsedFontCache.get(key)
  if (cached) return cached
  const promise = (async (): Promise<LoadedFont | null> => {
    if (family && !isBundledFamily(family)) {
      const bytes = await readSystemFontBytes(family, node.fontWeight)
      const font = bytes ? await parseFontBytes(bytes) : null
      if (font) return { font, bundled: false }
    }
    const bytes = await loadBundledFontBytes(node.fontWeight)
    const font = bytes ? await parseFontBytes(bytes) : null
    return font ? { font, bundled: true } : null
  })()
  parsedFontCache.set(key, promise)
  return promise
}

/** Glyph path data for one line; letter spacing widens the advance after
 * every character (including spaces) like the rendered text does. */
function linePathData(
  font: Font,
  line: string,
  startX: number,
  baseline: number,
  fontSize: number,
  letterSpacing: number
): string {
  if (letterSpacing === 0) return font.getPath(line, startX, baseline, fontSize).toPathData(2)
  let d = ''
  let x = startX
  const scale = fontSize / font.unitsPerEm
  for (const char of line) {
    const glyph = font.charToGlyph(char)
    d += glyph.getPath(x, baseline, fontSize).toPathData(2)
    x += (glyph.advanceWidth ?? 0) * scale + letterSpacing
  }
  return d
}

/**
 * Replaces the selected text node with its vector outlines. Returns false
 * (with a status message) when nothing text-like is selected or no font can
 * be loaded for it.
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
  const loaded = await loadFontFor(node)
  if (!loaded) {
    editor.showMessage(`No font could be loaded for "${node.fontFamily}"`)
    return false
  }
  const layout = layoutText(node)
  let d = ''
  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i]
    if (line.length === 0) continue
    d += linePathData(loaded.font, line, layout.anchorX, layout.baselines[i], node.fontSize, layout.letterSpacing)
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
      loaded.bundled && !isBundledFamily(node.fontFamily)
        ? 'Converted the text to vector outlines using the bundled Noto Sans font'
        : 'Converted the text to vector outlines'
    )
  }
  return replaced
}
