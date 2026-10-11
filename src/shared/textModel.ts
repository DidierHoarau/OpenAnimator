import type { TextNode } from './model'

/**
 * Text layout for `TextNode`: explicit lines (`\n`, no auto-wrap), measured
 * line widths (injected so tests and the CLI run DOM-free) and the shared
 * baseline/anchor math used by both the renderer and the stage.
 */

/** Extra leading between lines, as a multiple of the font size. */
export const TEXT_LINE_HEIGHT = 1.25

/** Approximate ascent of a font, as a multiple of the font size. First-line
 * baselines are placed from it. */
const TEXT_ASCENT = 0.8

/** Measures one rendered line's width in local units. */
export type MeasureLineWidth = (
  line: string,
  fontFamily: string,
  fontSize: number,
  fontWeight: number
) => number

/** Canvas-backed default measurement; falls back to an average-width
 * estimate when no 2D context is available. */
export function measureLineWidthCanvas(
  line: string,
  fontFamily: string,
  fontSize: number,
  fontWeight: number
): number {
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return line.length * fontSize * 0.6
  context.font = `${fontWeight} ${fontSize}px ${fontFamily}`
  return context.measureText(line).width
}

/** Layout of a placed text node: per-line baselines and the text anchor,
 * all in node-local coordinates (origin = the layout box center). */
export interface TextLayout {
  lines: string[]
  lineHeight: number
  baselines: number[]
  anchor: 'start' | 'middle' | 'end'
  anchorX: number
}

export function layoutText(node: Pick<TextNode, 'text' | 'fontSize' | 'align' | 'width' | 'height'>): TextLayout {
  const lines = node.text.split('\n')
  const lineHeight = node.fontSize * TEXT_LINE_HEIGHT
  const firstBaseline = -node.height / 2 + node.fontSize * TEXT_ASCENT
  // Round to 2 decimals so accumulated float noise never leaks into markup.
  const round = (value: number): number => Number(value.toFixed(2))
  return {
    lines,
    lineHeight,
    baselines: lines.map((_, index) => round(firstBaseline + index * lineHeight)),
    anchor: node.align === 'left' ? 'start' : node.align === 'right' ? 'end' : 'middle',
    anchorX: node.align === 'left' ? -node.width / 2 : node.align === 'right' ? node.width / 2 : 0
  }
}

/** Measures the layout box of a text node's content: widest line for the
 * width, `lines × lineHeight` for the height (minimum one line). */
export function measureTextLayout(
  text: string,
  fontSize: number,
  measure: MeasureLineWidth,
  fontFamily = '',
  fontWeight = 400
): { width: number; height: number } {
  const lines = text.length === 0 ? [''] : text.split('\n')
  const width = Math.max(1, ...lines.map((line) => measure(line, fontFamily, fontSize, fontWeight)))
  const height = Math.max(fontSize, lines.length * fontSize * TEXT_LINE_HEIGHT)
  return { width, height }
}

/** Refreshes a text node's placed size from its content; keeps the center. */
export function applyTextMetrics(node: TextNode, measure: MeasureLineWidth): void {
  const { width, height } = measureTextLayout(node.text, node.fontSize, measure, node.fontFamily, node.fontWeight)
  node.width = width
  node.height = height
}
