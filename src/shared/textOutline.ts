import type { Font } from 'opentype.js'

import type { PathNode, TextNode } from './model'
import { normalizePathData, pathDataBounds } from './pathModel'
import { layoutText } from './textModel'

/**
 * Shared text-to-outlines math: converts a laid-out text node into one
 * multi-subpath `PathNode` using a parsed font. Shared by the renderer's
 * Convert-to-Outlines command, the headless CLI, and the Lottie /
 * animated-SVG exporters, which must never embed fonts (licensing) and
 * therefore ship text as outlines.
 */

/** Resolves a text node to its outline path; null when no font is available
 * for it. The Lottie and animated-SVG exporters receive one of these. */
export type TextOutlineProvider = (node: TextNode) => Promise<PathNode | null>

/** Glyph path data for one line; letter spacing widens the advance after
 * every character (including spaces) like the rendered text does. */
export function linePathData(
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
 * Converts a text node into one multi-subpath outline `PathNode` that keeps
 * the text node's id, name, center, rotation and opacity, with `fill` only
 * (a text `stroke` is dropped, matching the Convert-to-Outlines command).
 * Returns null when the layout produces no glyphs at all.
 */
export function textNodeToOutlinePath(node: TextNode, font: Font): PathNode | null {
  const layout = layoutText(node)
  let d = ''
  for (let index = 0; index < layout.lines.length; index++) {
    const line = layout.lines[index]
    if (line.length === 0) continue
    d += linePathData(
      font,
      line,
      layout.anchorX,
      layout.baselines[index],
      node.fontSize,
      layout.letterSpacing
    )
  }
  const bounds = pathDataBounds(d)
  if (!bounds) return null
  return {
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
}
