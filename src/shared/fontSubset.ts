import { Font, parse } from 'opentype.js'

import { textChars } from './fontPolicy'
import { isObjectLayer } from './model'
import type { AnimatorDocument, Asset, GroupNode, SceneNode } from './model'

/**
 * Glyph subsetting for font embedding: collects the characters a document
 * actually renders per (family, weight, style) face and packs each face into
 * a minimal standalone TTF through opentype.js. The rebuild drops layout
 * features, so pair kerning is re-attached afterwards — opentype.js reads
 * GPOS `kern` lookups but cannot write GPOS, so the pairs are re-encoded as
 * a legacy `kern` table, which Chromium FontFace and resvg/HarfBuzz alike
 * honor. GSUB (ligatures) is still not embedded; the liga toggle shapes live
 * text only.
 */

/** One font usage of a document: family, weight, style and the distinct
 * characters rendered with it. */
export interface FontUsage {
  family: string
  weight: number
  italic: boolean
  chars: Set<string>
}

function collectNodeChars(node: SceneNode, usages: Map<string, FontUsage>): void {
  if (node.type === 'text') {
    const italic = node.fontStyle === 'italic'
    const key = `${node.fontFamily.toLowerCase()}|${node.fontWeight}|${italic}`
    let usage = usages.get(key)
    if (!usage) {
      usage = { family: node.fontFamily, weight: node.fontWeight, italic, chars: new Set() }
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
 * GPOS kerning structures opentype.js exposes at runtime but omits from its
 * typings (`font.position.*`): only the fields the extractor touches.
 */
interface KerningCoverage {
  format: number
  glyphs?: number[]
  ranges?: { start: number; end: number; index: number }[]
}

interface KerningClassDef {
  format: number
  startGlyph?: number
  classes?: number[]
  ranges?: { start: number; end: number; classId: number }[]
}

interface KerningSubtable {
  posFormat: number
  coverage?: KerningCoverage
  pairSets?: { secondGlyph: number; value1?: { xAdvance?: number } }[][]
  classDef1?: KerningClassDef
  classDef2?: KerningClassDef
  classRecords?: ({ value1?: { xAdvance?: number } } | undefined)[][]
}

interface PositionTables {
  getLookupTables(
    script: string | undefined,
    language: string | undefined,
    feature: string,
    lookupType: number
  ): { subtables?: KerningSubtable[] }[]
  getDefaultScriptName(): string | undefined
  expandCoverage(coverage: KerningCoverage): number[]
  getGlyphClass(classDef: KerningClassDef, glyphIndex: number): number
}

/**
 * Pair kerning of a parsed font as glyph-index pairs (`"left,right"` keys,
 * the key format of opentype.js' `kerningPairs`). Reads the real GPOS `kern`
 * lookups for the Latin script first — opentype.js' own `getKerningValue`
 * consults the default script and reports 0 for many Latin fonts — falls
 * back to the default-script lookups, then to a legacy `kern` table. When
 * `keep` is given, only pairs with both glyphs in it are collected and the
 * class-based enumeration walks the kept glyphs instead of every glyph.
 */
export function extractKerningPairs(font: Font, keep?: ReadonlySet<number>): Map<string, number> {
  const pairs = new Map<string, number>()
  const add = (left: number, right: number, xAdvance: number | undefined): void => {
    if (!xAdvance || left === 0 || right === 0) return
    if (keep && (!keep.has(left) || !keep.has(right))) return
    pairs.set(`${left},${right}`, xAdvance)
  }
  const position = (font as unknown as { position?: PositionTables }).position
  if (position) {
    const latnLookups = position.getLookupTables('latn', undefined, 'kern', 2)
    const defaultScript = latnLookups.length > 0 ? undefined : position.getDefaultScriptName()
    const lookups =
      latnLookups.length > 0
        ? latnLookups
        : defaultScript
          ? position.getLookupTables(defaultScript, undefined, 'kern', 2)
          : []
    for (const lookup of lookups) {
      for (const subtable of lookup.subtables ?? []) {
        if (subtable.posFormat === 1 && subtable.coverage && subtable.pairSets) {
          const lefts = position.expandCoverage(subtable.coverage)
          for (let i = 0; i < lefts.length; i++) {
            const left = lefts[i]
            if (keep && !keep.has(left)) continue
            for (const pair of subtable.pairSets[i] ?? []) {
              add(left, pair.secondGlyph, pair.value1?.xAdvance)
            }
          }
        } else if (
          subtable.posFormat === 2 &&
          subtable.coverage &&
          subtable.classDef1 &&
          subtable.classDef2 &&
          subtable.classRecords
        ) {
          const classDef1 = subtable.classDef1
          const classDef2 = subtable.classDef2
          const classRecords = subtable.classRecords
          const lefts = position
            .expandCoverage(subtable.coverage)
            .filter((left) => !keep || keep.has(left))
          if (keep) {
            for (const left of lefts) {
              const records = classRecords[position.getGlyphClass(classDef1, left)]
              if (!records) continue
              for (const right of keep) {
                add(left, right, records[position.getGlyphClass(classDef2, right)]?.value1?.xAdvance)
              }
            }
          } else {
            // Rights grouped by their class so class-0 records (every glyph
            // without an explicit assignment) enumerate too.
            const rightsByClass = new Map<number, number[]>()
            for (let glyph = 1; glyph < font.numGlyphs; glyph++) {
              const glyphClass = position.getGlyphClass(classDef2, glyph)
              const list = rightsByClass.get(glyphClass)
              if (list) list.push(glyph)
              else rightsByClass.set(glyphClass, [glyph])
            }
            for (const left of lefts) {
              const records = classRecords[position.getGlyphClass(classDef1, left)]
              if (!records) continue
              for (const [glyphClass, rights] of rightsByClass) {
                const xAdvance = records[glyphClass]?.value1?.xAdvance
                if (!xAdvance) continue
                for (const right of rights) add(left, right, xAdvance)
              }
            }
          }
        }
      }
    }
  }
  if (pairs.size === 0) {
    for (const [key, value] of Object.entries(font.kerningPairs)) {
      const [left, right] = key.split(',')
      add(Number(left), Number(right), value)
    }
  }
  return pairs
}

/** Sum of a byte range as big-endian u32 words, zero-padding the tail. */
function computeChecksum(bytes: Uint8Array, start: number, end: number): number {
  let sum = 0
  for (let at = start; at < end; at += 4) {
    const word =
      ((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)
    sum = (sum + (word >>> 0)) % 0x100000000
  }
  return sum
}

/** Legacy `kern` table (version 0, one horizontal format-0 subtable) from
 * glyph-index pairs, records sorted by (left, right) as the format demands. */
function buildKernTable(pairs: ReadonlyMap<string, number>): Uint8Array {
  const records: { left: number; right: number; value: number }[] = []
  for (const [key, value] of pairs) {
    const [left, right] = key.split(',')
    records.push({ left: Number(left), right: Number(right), value })
  }
  records.sort((a, b) => a.left - b.left || a.right - b.right)
  const nPairs = records.length
  const subtableLength = 14 + nPairs * 6
  const bytes = new Uint8Array(4 + subtableLength)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0) // kern version
  view.setUint16(2, 1) // one subtable
  view.setUint16(4, 0) // subtable version
  view.setUint16(6, subtableLength)
  view.setUint16(8, 0x0001) // horizontal, format 0
  view.setUint16(10, nPairs)
  const power = 2 ** Math.floor(Math.log2(nPairs))
  view.setUint16(12, 6 * power) // searchRange
  view.setUint16(14, Math.log2(power)) // entrySelector
  view.setUint16(16, nPairs * 6 - 6 * power) // rangeShift
  records.forEach((record, i) => {
    const at = 18 + i * 6
    view.setUint16(at, record.left)
    view.setUint16(at + 2, record.right)
    view.setInt16(at + 4, record.value)
  })
  return bytes
}

/**
 * Returns `ttf` with a legacy `kern` table built from `pairs` appended: the
 * table directory gains one record (every table offset shifts by one record
 * size, which keeps the 4-byte alignment it started with) and
 * `head.checkSumAdjustment` is recomputed over the final bytes. Returns the
 * input unchanged when there are no pairs.
 */
export function spliceKernTable(ttf: Uint8Array, pairs: ReadonlyMap<string, number>): Uint8Array {
  if (pairs.size === 0) return ttf
  const input = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength)
  const numTables = input.getUint16(4)
  const oldDataStart = 12 + numTables * 16
  const tableData = ttf.subarray(oldDataStart)
  const kern = buildKernTable(pairs)
  const kernOffset = (oldDataStart + 16 + tableData.length + 3) & ~3
  const out = new Uint8Array((kernOffset + kern.length + 3) & ~3)
  out.set(ttf.subarray(0, 4)) // sfnt version, preserved
  out.set(tableData, oldDataStart + 16)
  out.set(kern, kernOffset)
  const view = new DataView(out.buffer)
  const newNumTables = numTables + 1
  const power = 2 ** Math.floor(Math.log2(newNumTables))
  view.setUint16(4, newNumTables)
  view.setUint16(6, 16 * power) // searchRange
  view.setUint16(8, Math.log2(power)) // entrySelector
  view.setUint16(10, 16 * newNumTables - 16 * power) // rangeShift
  const entries: { tag: string; checkSum: number; offset: number; length: number }[] = []
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16
    const tag = String.fromCharCode(ttf[at], ttf[at + 1], ttf[at + 2], ttf[at + 3])
    entries.push({
      tag,
      checkSum: input.getUint32(at + 4),
      offset: input.getUint32(at + 8) + 16,
      length: input.getUint32(at + 12)
    })
  }
  entries.push({ tag: 'kern', checkSum: computeChecksum(kern, 0, kern.length), offset: kernOffset, length: kern.length })
  entries.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
  let headOffset = -1
  entries.forEach((entry, i) => {
    const at = 12 + i * 16
    for (let c = 0; c < 4; c++) out[at + c] = entry.tag.charCodeAt(c)
    view.setUint32(at + 4, entry.checkSum)
    view.setUint32(at + 8, entry.offset)
    view.setUint32(at + 12, entry.length)
    if (entry.tag === 'head') headOffset = entry.offset
  })
  if (headOffset >= 0) {
    // checkSumAdjustment = magic − checksum of the whole font with the field
    // itself zeroed (offset 8 inside the head table).
    view.setUint32(headOffset + 8, 0)
    view.setUint32(headOffset + 8, (0xb1b0afba - computeChecksum(out, 0, out.length)) >>> 0)
  }
  return out
}

/**
 * Packs a minimal TTF containing only `chars` (plus `.notdef`) through the
 * opentype.js rebuild technique: parse the source, take the glyph objects by
 * index and construct a fresh font with the original vertical metrics. Kern
 * pairs between kept glyphs are extracted from the source and re-attached as
 * a legacy `kern` table (glyph indices change in the rebuild, so pairs are
 * remapped along the same packing order). Throws when the source does not
 * parse or contains no requested glyph.
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
  const remap = new Map<number, number>([[0, 0]])
  for (const char of chars) {
    const index = source.charToGlyphIndex(char)
    if (index === 0 || remap.has(index)) continue
    remap.set(index, glyphs.length)
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
  const pairs = extractKerningPairs(source, new Set(remap.keys()))
  const remapped = new Map<string, number>()
  for (const [key, value] of pairs) {
    const [left, right] = key.split(',')
    remapped.set(`${remap.get(Number(left))},${remap.get(Number(right))}`, value)
  }
  return spliceKernTable(new Uint8Array(subset.toArrayBuffer()), remapped)
}
