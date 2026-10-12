import { Font, parse } from 'opentype.js'

import { textChars } from './fontPolicy'
import { isObjectLayer } from './model'
import type { AnimatorDocument, Asset, GroupNode, SceneNode } from './model'

/**
 * Glyph subsetting for font embedding: collects the characters a document
 * actually renders per (family, weight) pair and packs each pair into a
 * minimal standalone TTF through opentype.js. Layout features (kerning,
 * GSUB) are intentionally dropped by the rebuild — subset size matters more
 * than pair kerning in an animation tool, and the loss is documented.
 */

/** One font usage of a document: family, weight and the distinct characters
 * rendered with it. */
export interface FontUsage {
  family: string
  weight: number
  chars: Set<string>
}

function collectNodeChars(node: SceneNode, usages: Map<string, FontUsage>): void {
  if (node.type === 'text') {
    const key = `${node.fontFamily.toLowerCase()}|${node.fontWeight}`
    let usage = usages.get(key)
    if (!usage) {
      usage = { family: node.fontFamily, weight: node.fontWeight, chars: new Set() }
      usages.set(key, usage)
    }
    for (const char of textChars(node.text)) usage.chars.add(char)
  } else if (node.type === 'group') {
    for (const child of node.children) collectNodeChars(child, usages)
  }
}

function collectAssetChars(
  assetId: string,
  assets: ReadonlyMap<string, Asset>,
  usages: Map<string, FontUsage>,
  visiting: Set<string>
): void {
  if (visiting.has(assetId)) return
  visiting.add(assetId)
  const asset = assets.get(assetId)
  const content: GroupNode | undefined = asset?.kind === 'symbol' ? asset.content : undefined
  if (content) {
    for (const child of content.children) collectSymbolChars(child, assets, usages, visiting)
  }
  visiting.delete(assetId)
}

function collectSymbolChars(
  node: SceneNode,
  assets: ReadonlyMap<string, Asset>,
  usages: Map<string, FontUsage>,
  visiting: Set<string>
): void {
  if (node.type === 'symbol') {
    collectAssetChars(node.assetId, assets, usages, visiting)
    return
  }
  collectNodeChars(node, usages)
}

/**
 * Every font usage of the document: object-layer keyframes (groups recursed)
 * plus text inside asset symbol content, following nested symbol instances
 * with a cycle guard on the asset graph.
 */
export function fontUsage(document: AnimatorDocument): Map<string, FontUsage> {
  const usages = new Map<string, FontUsage>()
  for (const layer of document.layers) {
    if (!isObjectLayer(layer)) continue
    for (const keyframe of layer.keyframes) {
      for (const node of keyframe.nodes) {
        if (node.type === 'symbol') continue
        collectNodeChars(node, usages)
      }
    }
  }
  const assets = new Map(document.assets.map((asset) => [asset.id, asset]))
  const visiting = new Set<string>()
  for (const layer of document.layers) {
    if (!isObjectLayer(layer)) continue
    for (const keyframe of layer.keyframes) {
      for (const node of keyframe.nodes) {
        if (node.type !== 'symbol') continue
        collectAssetChars(node.assetId, assets, usages, visiting)
      }
    }
  }
  return usages
}

/**
 * Packs a minimal TTF containing only `chars` (plus `.notdef`) through the
 * opentype.js rebuild technique: parse the source, take the glyph objects by
 * index and construct a fresh font with the original vertical metrics.
 * Throws when the source does not parse or contains no requested glyph.
 */
export function subsetFont(bytes: Uint8Array, chars: readonly string[], familyName: string): Uint8Array {
  let source: Font
  try {
    source = parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`font could not be parsed: ${message}`, { cause: error })
  }
  const glyphs = [source.glyphs.get(0)]
  const seen = new Set<number>([0])
  for (const char of chars) {
    const index = source.charToGlyphIndex(char)
    if (index === 0 || seen.has(index)) continue
    seen.add(index)
    glyphs.push(source.glyphs.get(index))
  }
  if (glyphs.length === 1) {
    throw new Error(`no glyphs of "${familyName}" cover the requested characters`)
  }
  const subset = new Font({
    familyName,
    styleName: 'Regular',
    unitsPerEm: source.unitsPerEm,
    ascender: source.ascender,
    descender: source.descender,
    glyphs
  })
  return new Uint8Array(subset.toArrayBuffer())
}
