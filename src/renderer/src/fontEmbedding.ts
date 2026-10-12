import { embeddedFontId, matchEmbeddingPolicy } from '@shared/fontPolicy'
import type { FontEmbeddingPolicy } from '@shared/fontPolicy'
import { fontUsage, subsetFont } from '@shared/fontSubset'
import type { AnimatorDocument, EmbeddedFont } from '@shared/model'

import type { Editor } from './editor'
import { loadBundledFontBytes } from './textOutlines'

/**
 * Font embedding pipeline: reconciles `document.fonts` with the document's
 * actual (family, weight, chars) usages — subsets allowed families through
 * opentype.js, stores them in the content-addressed resource store and
 * registers the synthetic families as FontFaces so the stage renders them.
 */

export interface FontEmbeddingDeps {
  getPolicy(): Promise<FontEmbeddingPolicy>
  readFont(family: string, weight: number, italic: boolean): Promise<Uint8Array | null>
  addResource(bytes: Uint8Array, fileName: string): Promise<{ resourceId: string }>
  /** Registers freshly embedded subsets as face; injectable for tests. */
  syncFaces(editor: Editor): Promise<void>
}

function defaultDeps(): FontEmbeddingDeps {
  return {
    getPolicy: () => window.api.getFontEmbeddingPolicy(),
    readFont: async (family, weight, italic) => {
      const result = await window.api.readSystemFont(family, weight, italic)
      return result.ok ? result.bytes : null
    },
    addResource: (bytes, fileName) => window.api.addResource(bytes, fileName),
    syncFaces: syncSessionFonts
  }
}

/** Bundled upright Noto Sans covers the guaranteed fallback family; every
 * other face — including italic Noto Sans, which ships no bundled italic —
 * comes from the installed system fonts. */
async function readSourceFont(
  family: string,
  weight: number,
  italic: boolean,
  deps: FontEmbeddingDeps
): Promise<Uint8Array | null> {
  if (!italic && family.trim().toLowerCase() === 'noto sans') {
    const bundled = await loadBundledFontBytes(weight)
    if (bundled) return bundled
  }
  return deps.readFont(family, weight, italic)
}

function covers(font: EmbeddedFont, chars: ReadonlySet<string>): boolean {
  const glyphs = new Set(font.glyphs)
  for (const char of chars) {
    if (!glyphs.has(char)) return false
  }
  return true
}

function sameFonts(before: readonly EmbeddedFont[], after: readonly EmbeddedFont[]): boolean {
  if (before.length !== after.length) return false
  return after.every((font, index) => {
    const other = before[index]
    return (
      other.id === font.id &&
      other.family === font.family &&
      other.weight === font.weight &&
      (other.italic ?? false) === (font.italic ?? false) &&
      other.resourceId === font.resourceId &&
      other.license === font.license &&
      other.glyphs.length === font.glyphs.length &&
      other.glyphs.every((glyph, glyphIndex) => glyph === font.glyphs[glyphIndex])
    )
  })
}

/**
 * Makes `document.fonts` match the text the document renders: existing
 * subsets are kept while they cover every character (never re-subset), new
 * or outgrown usages are subset from the bundled/system source when the
 * embedding policy allows the family, and entries without any usage are
 * pruned. Returns true when the font list changed. Families that could not
 * be embedded are reported through the status bar.
 */
export async function reconcileEmbeddedFonts(
  editor: Editor,
  deps: FontEmbeddingDeps = defaultDeps()
): Promise<boolean> {
  const usages = fontUsage(editor.document)
  if (usages.size === 0 && editor.document.fonts.length === 0) return false
  const policy = await deps.getPolicy()
  const existingByKey = new Map(
    editor.document.fonts.map((font) => [
      `${font.family.toLowerCase()}|${font.weight}|${font.italic ?? false}`,
      font
    ])
  )
  const next: EmbeddedFont[] = []
  const skipped: string[] = []
  for (const usage of usages.values()) {
    const existing = existingByKey.get(`${usage.family.toLowerCase()}|${usage.weight}|${usage.italic}`)
    if (existing && covers(existing, usage.chars)) {
      next.push(existing)
      continue
    }
    const license = matchEmbeddingPolicy(usage.family, policy)
    if (license === null) {
      if (existing) next.push(existing)
      skipped.push(usage.family)
      continue
    }
    const glyphs = [...new Set([...(existing?.glyphs ?? []), ...usage.chars])].sort()
    const id = embeddedFontId(usage.family, usage.weight, usage.italic)
    const source = await readSourceFont(usage.family, usage.weight, usage.italic, deps)
    let subset: Uint8Array | null = null
    if (source) {
      try {
        subset = subsetFont(source, glyphs, id)
      } catch {
        subset = null
      }
    }
    if (!subset) {
      if (existing) next.push(existing)
      skipped.push(usage.family)
      continue
    }
    const { resourceId } = await deps.addResource(subset, `${id}.ttf`)
    editor.resources.put(resourceId, subset)
    next.push({
      id,
      family: usage.family,
      weight: usage.weight,
      ...(usage.italic ? { italic: true } : {}),
      resourceId,
      glyphs,
      license
    })
  }
  const changed = !sameFonts(editor.document.fonts, next)
  if (changed) editor.applyFontEmbedding(next)
  if (skipped.length > 0) {
    editor.showMessage(`Not embedded (license policy or font unavailable): ${[...new Set(skipped)].join(', ')}`)
  }
  return changed
}

/** Port over the DOM FontFace API, injectable for tests. */
export interface FontFacePort {
  /** Creates, loads and adds a face; resolves to an opaque handle. */
  add(family: string, weight: number, bytes: ArrayBuffer, italic: boolean): Promise<unknown>
  /** Removes a previously added face. */
  remove(handle: unknown): void
}

function defaultFontFacePort(): FontFacePort {
  return {
    add: async (family, weight, bytes, italic) => {
      const face = new FontFace(family, bytes, {
        weight: String(weight),
        style: italic ? 'italic' : 'normal'
      })
      await face.load()
      document.fonts.add(face)
      return face
    },
    remove: (handle) => {
      document.fonts.delete(handle as FontFace)
    }
  }
}

/**
 * Keeps the DOM FontFaceSet aligned with the document's embedded subsets:
 * new subsets register, changed bytes re-register (same synthetic family,
 * fresh content), removed entries unregister. Failures are swallowed — the
 * markup's fallback chain still renders, just without the embedded face.
 */
export class EmbeddedFontSync {
  private readonly registered = new Map<string, { resourceId: string; handle: unknown }>()

  constructor(private readonly port: FontFacePort = defaultFontFacePort()) {}

  async sync(document: AnimatorDocument, readBlob: (resourceId: string) => Blob | null): Promise<void> {
    const alive = new Set(document.fonts.map((font) => font.id))
    for (const [id, entry] of [...this.registered]) {
      if (alive.has(id)) continue
      this.port.remove(entry.handle)
      this.registered.delete(id)
    }
    for (const font of document.fonts) {
      const current = this.registered.get(font.id)
      if (current?.resourceId === font.resourceId) continue
      const blob = readBlob(font.resourceId)
      if (!blob) continue
      try {
        const bytes = await blob.arrayBuffer()
        const handle = await this.port.add(font.id, font.weight, bytes, font.italic ?? false)
        if (current) this.port.remove(current.handle)
        this.registered.set(font.id, { resourceId: font.resourceId, handle })
      } catch {
        // The text falls back to the next family in the chain.
      }
    }
  }
}

const sessionFontSync = new EmbeddedFontSync()

/** Syncs the session's registered font faces with the editor's document and
 * refreshes the views so the stage renders with the faces once they are
 * ready (the initial render races the async face loading). */
export async function syncSessionFonts(editor: Editor): Promise<void> {
  await sessionFontSync.sync(editor.document, (resourceId) => editor.resources.getBlob(resourceId))
  editor.refreshDocViews()
}
