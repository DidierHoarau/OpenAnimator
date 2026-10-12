import type { EmbeddedFont, TextNode } from './model'

/**
 * Font embedding policy: which families may be packed into an `.oanim` file
 * as glyph subsets, and the CSS family-list construction shared by the
 * renderer, the stage and the headless CLI. Pure module — works without
 * Electron, DOM or node builtins.
 */

/** One allowlist entry: a family name pattern (case-insensitive exact match,
 * or a trailing `*` prefix match) and the license label reported when it
 * matches. */
export interface FontEmbeddingRule {
  pattern: string
  license: string
}

/** Effective embedding policy: rules that permit embedding plus deny
 * patterns that always win. */
export interface FontEmbeddingPolicy {
  allow: FontEmbeddingRule[]
  deny: string[]
}

/** Built-in allowlist of redistributable font families. Users add rules for
 * their own licensed fonts through `<userData>/font-embedding.json`. */
export const DEFAULT_EMBEDDING_ALLOWLIST: FontEmbeddingRule[] = [
  { pattern: 'Noto Sans', license: 'OFL-1.1' },
  { pattern: 'DejaVu*', license: 'Bitstream-Vera' },
  { pattern: 'Liberation*', license: 'OFL-1.1' },
  { pattern: 'Ubuntu*', license: 'UFL-1.0' },
  { pattern: 'Cantarell*', license: 'OFL-1.1' },
  { pattern: 'Fira*', license: 'OFL-1.1' },
  { pattern: 'Inter*', license: 'OFL-1.1' },
  { pattern: 'Lato*', license: 'OFL-1.1' },
  { pattern: 'Montserrat*', license: 'OFL-1.1' },
  { pattern: 'Open Sans*', license: 'OFL-1.1' },
  { pattern: 'Roboto*', license: 'Apache-2.0' },
  { pattern: 'Source Sans*', license: 'OFL-1.1' },
  { pattern: 'Source Serif*', license: 'OFL-1.1' },
  { pattern: 'PT Sans*', license: 'OFL-1.1' },
  { pattern: 'PT Serif*', license: 'OFL-1.1' },
  { pattern: 'Raleway*', license: 'OFL-1.1' },
  { pattern: 'Merriweather*', license: 'OFL-1.1' },
  { pattern: 'Oswald*', license: 'OFL-1.1' },
  { pattern: 'Playfair Display*', license: 'OFL-1.1' },
  { pattern: 'IBM Plex*', license: 'OFL-1.1' }
]

/** FNV-1a 32-bit, formatted as 8 lowercase hex digits. Deterministic across
 * platforms, so the same family always maps to the same synthetic id. */
function hash8(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Synthetic CSS family of an embedded subset: lowercase and made only of
 * `[a-z0-9-]`, so it never needs quoting in a family list. Italic subsets
 * append an `i` marker — upright ids keep their exact old string so stored
 * documents resolve unchanged. */
export function embeddedFontId(family: string, weight: number, italic = false): string {
  return `oa-embed-${weight}-${hash8(family.toLowerCase())}${italic ? 'i' : ''}`
}

function matchesPattern(family: string, pattern: string): boolean {
  const normalized = family.trim().toLowerCase()
  const trimmed = pattern.trim().toLowerCase()
  if (trimmed.length === 0) return false
  if (trimmed.endsWith('*')) return normalized.startsWith(trimmed.slice(0, -1))
  return normalized === trimmed
}

/**
 * Resolves the embedding policy for one family: the license label to record
 * when embedding is permitted, or null when it is denied or not allowlisted.
 * Deny patterns always win, matching is case-insensitive.
 */
export function matchEmbeddingPolicy(family: string, policy: FontEmbeddingPolicy): string | null {
  if (policy.deny.some((pattern) => matchesPattern(family, pattern))) return null
  const rule = policy.allow.find((entry) => matchesPattern(family, entry.pattern))
  return rule ? rule.license : null
}

/** CSS family token: single-quoted only when it contains characters outside
 * `[A-Za-z0-9_-]`. */
function formatFamily(family: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(family)) return family
  return `'${family.replace(/'/g, "\\'")}'`
}

/**
 * CSS family list of a text node: the embedded subset first (when one
 * exists), then the requested family, the user's fallbacks, and the final
 * `'Noto Sans', sans-serif` safety net — deduplicated case-insensitively.
 */
export function fontFamilyListFor(
  node: Pick<TextNode, 'fontFamily' | 'fontFallback'>,
  embeddedId?: string | null
): string {
  const families: string[] = []
  const seen = new Set<string>()
  const push = (family: string | undefined): void => {
    if (!family) return
    const trimmed = family.trim()
    if (trimmed.length === 0) return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    families.push(trimmed)
  }
  push(embeddedId ?? undefined)
  push(node.fontFamily)
  for (const family of node.fontFallback ?? []) push(family)
  push('Noto Sans')
  push('sans-serif')
  return families.map(formatFamily).join(', ')
}

/** Distinct characters of a text, excluding explicit line breaks, sorted by
 * code point (the canonical glyph list of an embedded subset). */
export function textChars(text: string): string[] {
  const chars = new Set<string>()
  for (const char of text) {
    if (char === '\n' || char === '\r') continue
    chars.add(char)
  }
  return [...chars].sort((a, b) => (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0))
}

/** Resolver of the embedded-subset family for a (family, weight, style)
 * triple — the `SvgRenderOptions.resolveEmbeddedFont` implementation built
 * from a document's `fonts` list. Weight and style match exactly (embedding
 * records one entry per used face); entries from before the style field
 * existed count as upright. */
export function embeddedFamilyResolverFor(
  fonts: readonly EmbeddedFont[]
): (family: string, weight: number, italic?: boolean) => string | null {
  return (family, weight, italic = false) => {
    const key = family.trim().toLowerCase()
    for (const font of fonts) {
      if (font.weight === weight && (font.italic ?? false) === italic && font.family.toLowerCase() === key) {
        return font.id
      }
    }
    return null
  }
}
