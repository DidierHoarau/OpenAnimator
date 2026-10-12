import { describe, expect, it } from 'vitest'

import {
  DEFAULT_EMBEDDING_ALLOWLIST,
  embeddedFamilyResolverFor,
  embeddedFontId,
  fontFamilyListFor,
  matchEmbeddingPolicy,
  textChars
} from './fontPolicy'
import type { EmbeddedFont } from './model'

describe('embeddedFontId', () => {
  it('is deterministic, lowercase and safe as an unquoted CSS family', () => {
    const id = embeddedFontId('My Font', 400)
    expect(id).toBe(embeddedFontId('My Font', 400))
    expect(id).toMatch(/^oa-embed-400-[0-9a-f]{8}$/)
  })

  it('is case-insensitive on the family and distinct per weight', () => {
    expect(embeddedFontId('Inter', 400)).toBe(embeddedFontId('inter', 400))
    expect(embeddedFontId('Inter', 400)).not.toBe(embeddedFontId('Inter', 700))
  })

  it('keeps old upright ids byte-identical and marks italic distinctly', () => {
    expect(embeddedFontId('Inter', 400, false)).toBe(embeddedFontId('Inter', 400))
    const italic = embeddedFontId('Inter', 400, true)
    expect(italic).toBe(`${embeddedFontId('Inter', 400)}i`)
    expect(italic).toMatch(/^oa-embed-400-[0-9a-f]{8}i$/)
    expect(italic).not.toBe(embeddedFontId('Inter', 400))
  })
})

describe('matchEmbeddingPolicy', () => {
  const policy = {
    allow: [{ pattern: 'Open Sans*', license: 'OFL-1.1' }],
    deny: ['Open Sans Condensed']
  }

  it('returns the license of the matching allow rule', () => {
    expect(matchEmbeddingPolicy('Open Sans', policy)).toBe('OFL-1.1')
    expect(matchEmbeddingPolicy('open sans condensed', policy)).toBeNull()
  })

  it('deny patterns win over allow patterns, case-insensitively', () => {
    expect(matchEmbeddingPolicy('OPEN SANS CONDENSED', policy)).toBeNull()
  })

  it('matches exact patterns without a wildcard only exactly', () => {
    const exact = { allow: [{ pattern: 'Lato', license: 'OFL-1.1' }], deny: [] }
    expect(matchEmbeddingPolicy('Lato', exact)).toBe('OFL-1.1')
    expect(matchEmbeddingPolicy('Lato Black', exact)).toBeNull()
  })

  it('returns null for families no rule covers', () => {
    expect(matchEmbeddingPolicy('Helvetica Neue', policy)).toBeNull()
  })

  it('ships a default allowlist covering the documented families', () => {
    const families = DEFAULT_EMBEDDING_ALLOWLIST.map((rule) => rule.pattern)
    for (const family of ['Noto Sans', 'DejaVu*', 'Roboto*', 'IBM Plex*', 'Inter*']) {
      expect(families).toContain(family)
    }
    expect(matchEmbeddingPolicy('Roboto Mono', { allow: DEFAULT_EMBEDDING_ALLOWLIST, deny: [] })).toBe('Apache-2.0')
    expect(matchEmbeddingPolicy('Roboto', { allow: DEFAULT_EMBEDDING_ALLOWLIST, deny: [] })).toBe('Apache-2.0')
    expect(matchEmbeddingPolicy('Arial', { allow: DEFAULT_EMBEDDING_ALLOWLIST, deny: [] })).toBeNull()
  })
})

describe('fontFamilyListFor', () => {
  it('puts the embedded subset first and appends the safety net', () => {
    expect(fontFamilyListFor({ fontFamily: 'My Font' }, 'oa-embed-400-ab12cd34')).toBe(
      "oa-embed-400-ab12cd34, 'My Font', 'Noto Sans', sans-serif"
    )
  })

  it('deduplicates case-insensitively and skips empty fallbacks', () => {
    expect(fontFamilyListFor({ fontFamily: 'Noto Sans', fontFallback: ['noto sans', ' ', 'Lato'] })).toBe(
      "'Noto Sans', Lato, sans-serif"
    )
  })

  it('quotes only families with characters outside [A-Za-z0-9_-]', () => {
    expect(fontFamilyListFor({ fontFamily: 'Lato' })).toBe("Lato, 'Noto Sans', sans-serif")
    expect(fontFamilyListFor({ fontFamily: "Kid's Font" })).toContain("'Kid\\'s Font'")
  })
})

describe('textChars', () => {
  it('deduplicates, drops line breaks and sorts by code point', () => {
    expect(textChars('b\na b\r\n')).toEqual([' ', 'a', 'b'])
    expect(textChars('😀a')).toEqual(['a', '😀'])
  })
})

describe('embeddedFamilyResolverFor', () => {
  function font(overrides: Partial<EmbeddedFont> = {}): EmbeddedFont {
    return {
      id: 'oa-embed-400-ab12cd34',
      family: 'Noto Sans',
      weight: 400,
      resourceId: 'a'.repeat(64),
      glyphs: ['H', 'i'],
      license: 'OFL-1.1',
      ...overrides
    }
  }

  it('resolves family+weight case-insensitively and exactly', () => {
    const resolve = embeddedFamilyResolverFor([font(), font({ id: 'oa-embed-700-cd34ab12', weight: 700 })])
    expect(resolve('Noto Sans', 400)).toBe('oa-embed-400-ab12cd34')
    expect(resolve('noto sans', 700)).toBe('oa-embed-700-cd34ab12')
    expect(resolve('Noto Sans', 500)).toBeNull()
    expect(resolve('Other', 400)).toBeNull()
  })

  it('matches the style exactly: italic resolves only the italic subset', () => {
    const upright = font()
    const italic = font({ id: 'oa-embed-400-ab12cd34i', italic: true })
    const resolve = embeddedFamilyResolverFor([upright, italic])
    expect(resolve('Noto Sans', 400)).toBe('oa-embed-400-ab12cd34')
    expect(resolve('Noto Sans', 400, true)).toBe('oa-embed-400-ab12cd34i')
    // An old entry without the field counts as upright, never as italic.
    const uprightOnly = embeddedFamilyResolverFor([upright])
    expect(uprightOnly('Noto Sans', 400, true)).toBeNull()
  })
})
