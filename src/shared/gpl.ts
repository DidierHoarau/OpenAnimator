import { formatHexColor, parseHexColor } from './color'
import type { Rgb } from './color'
import { normalizePaletteColors } from './document'

/**
 * GIMP palette (`.gpl`) interop: parse and serialize the plain-text palette
 * format every GIMP-family editor reads and writes, so the global palette can
 * be exchanged with Inkscape, Krita, GIMP, … without a binary container.
 */

/**
 * Parses a GIMP palette file. The first line must be `GIMP Palette` (a UTF-8
 * BOM and CR/CRLF line endings are tolerated); `#` comment lines, blank lines
 * and `Name:`/`Columns:` metadata are skipped; every other line is an
 * `r g b [name]` triplet with 0–255 channels. The result is normalized like
 * every palette (lowercase `#rrggbb`, deduplicated, capped). Returns null when
 * the text is not a GIMP palette at all.
 */
export function parseGpl(text: string): string[] | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
  if ((lines[0] ?? '').trim() !== 'GIMP Palette') return null
  const colors: string[] = []
  for (const line of lines.slice(1)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (/^(name|columns):/i.test(trimmed)) continue
    const match = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s+.*)?$/.exec(trimmed)
    if (!match) continue
    const channels = [Number(match[1]), Number(match[2]), Number(match[3])]
    if (channels.some((channel) => channel > 255)) continue
    colors.push(formatHexColor(channels as Rgb))
  }
  return normalizePaletteColors(colors)
}

/**
 * Serializes colors as a GIMP palette: the `GIMP Palette` header, a `Name:`
 * and a `Columns:` line, then one `rr gg bb` line per color (normalized
 * first, so invalid entries are dropped).
 */
export function serializeGpl(colors: readonly string[]): string {
  const lines = ['GIMP Palette', 'Name: OpenAnimator', 'Columns: 8', '#']
  for (const color of normalizePaletteColors(colors)) {
    const rgb = parseHexColor(color)
    if (!rgb) continue
    lines.push(`${rgb[0]} ${rgb[1]} ${rgb[2]}`)
  }
  return `${lines.join('\n')}\n`
}
