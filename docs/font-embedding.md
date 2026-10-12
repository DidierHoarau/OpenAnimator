# Fonts and font embedding

OpenAnimator renders text with the fonts installed on the machine, and can
pack the fonts a project actually uses into the `.oanim` file as compact
glyph subsets so a shared project looks the same everywhere. This document
describes the system-font picker, the fallback chain and the embedding
policy.

## System fonts

The font family field in the properties panel suggests the fonts installed
on the machine. The Electron main process enumerates them with fontconfig
(`fc-list`) and exposes them through the preload API:

```ts
window.api.listSystemFonts(): Promise<{ family: string; weights: number[] }[]>
window.api.readSystemFont(family, weight): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }>
```

Enumeration groups faces by family, maps fontconfig weights onto the
`100`–`900` CSS scale (nearest bucket, ties toward the lower weight) and
skips italic/oblique faces. Typing any family name still works — the
suggestions are a convenience, not a whitelist. On systems without
fontconfig, enumeration degrades to an empty list.

## The fallback chain

A text node renders through a CSS family list:

1. the node's embedded subset (when one exists, see below),
2. `fontFamily` — the requested family,
3. every entry of `fontFallback` in order (up to 8, edited in the
   properties panel as a comma-separated list),
4. `'Noto Sans', sans-serif` — the safety net.

The list is deduplicated case-insensitively. Documents that use neither
embedded subsets nor fallbacks keep their historical single-family markup
byte for byte.

## Glyph-subset embedding

When a project is saved (and before every export), OpenAnimator reconciles
the document's `fonts` list against the text the document actually
contains:

1. **Usage walk** — every text node of every object-layer keyframe and of
   every symbol asset (cycle- and depth-guarded) contributes its
   `(family, weight)` pair and its distinct characters (`\n`/`\r`
   excluded, sorted by code point).
2. **Policy check** — the family must match the license allowlist (below).
   Families that are denied or unreadable are skipped and reported in the
   status bar; the document still saves.
3. **Source bytes** — the font is read through the main process
   (`readSystemFont`); the bundled Noto Sans stands in for its own family
   so the guaranteed fallback never depends on the installation.
4. **Subset** — opentype.js parses the font and re-serializes only the used
   glyphs (`.notdef` plus one glyph per character, original metrics),
   typically a few kilobytes.
5. **Resource + entry** — the subset is stored as a content-addressed
   resource (`resources/<sha256>.ttf`, shared with images and drawings) and
   recorded in `document.fonts` as an `EmbeddedFont`:

```json
{
  "id": "oa-embed-400-ab12cd34",
  "family": "Lato",
  "weight": 400,
  "resourceId": "<sha256 of the subset bytes>",
  "glyphs": ["H", "e", "l", "o"],
  "license": "OFL-1.1"
}
```

The synthetic family `id` is deterministic (`oa-embed-<weight>-<FNV-1a
hash of the lowercased family>`), so repeated saves of the same document
reuse one `@font-face` entry. On re-save the subset grows by **union**:
glyphs of previous versions are kept, so text retyped back to an earlier
state never loses coverage. Entries whose family/weight pair is no longer
used anywhere are pruned, and their resources become unreferenced (removable
with `Purge Unused`).

## How the subsets render

- **Stage (in-app)**: the renderer registers each subset as a `FontFace`
  and swaps the text node's family list to put the subset first, so the
  timeline, onion skins and stage preview render embedded typography even
  when the original font is not installed.
- **In-app export (PNG/GIF/WebM)**: the SVG handed to the rasterizer
  carries `@font-face` rules over `data:` URLs; Chromium's SVG-in-`<img>`
  decoder renders them.
- **CLI (`render`)**: resvg ignores in-SVG `@font-face` sources, so the
  subset files are written to a temporary directory and passed as
  `font.fontFiles`; the directory is removed after the render.
- **Convert to Outlines** uses the node's own font (system or bundled) so
  outlines match the rendered text; letter spacing, line height and
  vertical alignment are baked into the vector paths.

## License policy

Only families that are known to be redistributable are embedded by
default. The built-in allowlist ships 20 families — Noto Sans, DejaVu\*,
Liberation\*, Ubuntu\*, Cantarell\*, Fira\*, Inter\*, Lato\*, Montserrat\*,
Open Sans\*, Roboto\* (Apache-2.0), Source Sans\*, Source Serif\*, PT
Sans\*, PT Serif\*, Raleway\*, Merriweather\*, Oswald\*, Playfair
Display\* and IBM Plex\* — most under OFL-1.1. A trailing `*` is a prefix
match (case-insensitive); other patterns match the exact family name.

Users add rules for their own licensed fonts in
`<userData>/font-embedding.json`:

```json
{
  "allow": [{ "pattern": "My Corporate Sans", "license": "internal-2026" }],
  "deny": ["Helvetica*"]
}
```

- `allow` entries are merged **before** the built-in list, so a user rule
  can override a built-in license label; duplicate patterns are dropped.
- `deny` patterns always win, even over a user `allow`.
- Invalid entries are skipped and a missing or corrupted file reads as the
  built-in defaults — the policy store never throws.

The effective policy is resolved over IPC
(`window.api.getFontEmbeddingPolicy()`), and the license label recorded in
each `EmbeddedFont` comes from the matching rule. Embedding is best-effort
by design: a failed subset or an unreadable font never blocks saving.

## Privacy

Everything happens locally: fonts are read from the machine, subset and
stored inside the project file. Nothing is uploaded and no network access
is involved (the bundled Noto Sans TTFs ship with the application).
