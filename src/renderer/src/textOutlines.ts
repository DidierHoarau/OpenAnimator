import type { TextNode } from '@shared/model'
import type { TextOutlineProvider } from '@shared/textOutline'
import { textNodeToOutlinePath } from '@shared/textOutline'

import type { Editor } from './editor'
import { parse } from 'opentype.js'
import type { Font } from 'opentype.js'
import noto400Url from '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf?url'
import noto700Url from '@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf?url'

/**
 * Converts a selected text node into vector outlines. The node's own face is
 * used when it can be loaded — a system font through the main process, or the
 * bundled Noto Sans for the fallback family — and the glyph outline math
 * (baselines, anchors, letter spacing, multi-subpath merge) lives in the
 * shared `textOutline` module so the exporters build identical outlines.
 * Upright fonts that cannot be loaded fall back to the bundled Noto Sans so
 * the conversion always yields deterministic outlines; italic nodes need an
 * installed italic face (the bundle ships upright faces only).
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

async function readSystemFontBytes(family: string, weight: number, italic: boolean): Promise<Uint8Array | null> {
  try {
    const result = await window.api.readSystemFont(family, weight, italic)
    return result.ok ? new Uint8Array(result.bytes) : null
  } catch (error: unknown) {
    console.warn('OpenAnimator: failed to read the system font', error)
    return null
  }
}

function loadFontFor(node: TextNode): Promise<LoadedFont | null> {
  const family = node.fontFamily.trim()
  const italic = node.fontStyle === 'italic'
  const key = `${family.toLowerCase()}|${node.fontWeight}|${italic}`
  const cached = parsedFontCache.get(key)
  if (cached) return cached
  const promise = (async (): Promise<LoadedFont | null> => {
    if (family !== '' && (italic || !isBundledFamily(family))) {
      const bytes = await readSystemFontBytes(family, node.fontWeight, italic)
      const font = bytes ? await parseFontBytes(bytes) : null
      if (font) return { font, bundled: false }
    }
    // The bundle ships upright faces only, so italic falls through to a
    // system face or fails — upright outlines would misrepresent the style.
    if (!italic) {
      const bytes = await loadBundledFontBytes(node.fontWeight)
      const font = bytes ? await parseFontBytes(bytes) : null
      return font ? { font, bundled: true } : null
    }
    return null
  })()
  parsedFontCache.set(key, promise)
  return promise
}

/** The renderer's text-outline provider for the exporters: loads the node's
 * font like Convert-to-Outlines does, then builds the shared outline path. */
export const textNodeOutline: TextOutlineProvider = async (node) => {
  const loaded = await loadFontFor(node)
  if (!loaded) return null
  return textNodeToOutlinePath(node, loaded.font)
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
  const replacement = textNodeToOutlinePath(node, loaded.font)
  if (!replacement) {
    editor.showMessage('The text has no glyphs to convert')
    return false
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
