// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  applyTextMetrics,
  layoutText,
  measureLineWidthCanvas,
  measureTextLayout,
  TEXT_LINE_HEIGHT
} from './textModel'
import type { TextNode } from './model'

/** Deterministic fake: every character is 10 units wide. */
const measure = (line: string): number => line.length * 10

function textNode(overrides: Partial<TextNode> = {}): TextNode {
  return {
    type: 'text',
    id: 't',
    center: { x: 0, y: 0 },
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    text: 'Hello',
    fontFamily: 'Noto Sans',
    fontSize: 24,
    fontWeight: 400,
    fill: '#ffffff',
    align: 'left',
    ...overrides
  }
}

describe('layoutText', () => {
  it('splits explicit lines and lays out baselines from the top of the box', () => {
    const layout = layoutText({ text: 'One\nTwo', fontSize: 20, align: 'left', width: 60, height: 50 })
    expect(layout.lines).toEqual(['One', 'Two'])
    expect(layout.lineHeight).toBe(20 * TEXT_LINE_HEIGHT)
    expect(layout.baselines[0]).toBeCloseTo(-25 + 16)
    expect(layout.baselines[1]).toBeCloseTo(-25 + 16 + 25)
    expect(layout.letterSpacing).toBe(0)
    expect(layout.verticalAlign).toBe('top')
  })

  it('anchors left, center and right within the placed box', () => {
    const left = layoutText({ text: 'a', fontSize: 10, align: 'left', width: 100, height: 12.5 })
    expect(left.anchor).toBe('start')
    expect(left.anchorX).toBe(-50)
    const center = layoutText({ text: 'a', fontSize: 10, align: 'center', width: 100, height: 12.5 })
    expect(center.anchor).toBe('middle')
    expect(center.anchorX).toBe(0)
    const right = layoutText({ text: 'a', fontSize: 10, align: 'right', width: 100, height: 12.5 })
    expect(right.anchor).toBe('end')
    expect(right.anchorX).toBe(50)
  })

  it('honors an explicit lineHeight multiplier', () => {
    const layout = layoutText({ text: 'One\nTwo', fontSize: 20, align: 'left', width: 60, height: 50, lineHeight: 2 })
    expect(layout.lineHeight).toBe(40)
    expect(layout.baselines[1] - layout.baselines[0]).toBeCloseTo(40)
  })

  it('re-places baselines for middle and bottom vertical alignment', () => {
    const base = { text: 'One', fontSize: 20, align: 'left' as const, width: 60, height: 100 }
    const top = layoutText(base)
    expect(top.baselines[0]).toBeCloseTo(-50 + 16)

    const middle = layoutText({ ...base, verticalAlign: 'middle' })
    expect(middle.baselines[0]).toBeCloseTo(-(1 * 20 * TEXT_LINE_HEIGHT) / 2 + 16)
    expect(middle.verticalAlign).toBe('middle')

    const bottom = layoutText({ ...base, verticalAlign: 'bottom' })
    expect(bottom.baselines[0]).toBeCloseTo(50 - 1 * 20 * TEXT_LINE_HEIGHT + 16)

    const bottomTwo = layoutText({ ...base, text: 'One\nTwo', verticalAlign: 'bottom' })
    expect(bottomTwo.baselines[0]).toBeCloseTo(50 - 2 * 20 * TEXT_LINE_HEIGHT + 16)
    expect(bottomTwo.baselines[1] - bottomTwo.baselines[0]).toBeCloseTo(20 * TEXT_LINE_HEIGHT)
  })
})

describe('measureTextLayout', () => {
  it('measures the widest line and counts lines for the height', () => {
    expect(measureTextLayout('short\nmuch longer line', 20, measure)).toEqual({
      width: 160,
      height: 2 * 20 * TEXT_LINE_HEIGHT
    })
  })

  it('degrades gracefully on empty text and tiny sizes', () => {
    expect(measureTextLayout('', 12, measure)).toEqual({ width: 1, height: 15 })
  })

  it('widens lines by one letter-spacing advance per character', () => {
    const result = measureTextLayout('ab\nabcd', 10, measure, 'Noto Sans', 400, 5)
    // 'abcd' = 40 + 4 × 5 = 60; height unchanged by spacing.
    expect(result).toEqual({ width: 60, height: 2 * 10 * TEXT_LINE_HEIGHT })
  })

  it('scales the height by the lineHeight multiplier', () => {
    const result = measureTextLayout('a\nb', 20, measure, '', 400, 0, 1.5)
    expect(result.height).toBe(60)
  })
})

describe('applyTextMetrics', () => {
  it('refreshes the placed size from the content', () => {
    const node = textNode({ width: 1, height: 1 })
    applyTextMetrics(node, measure)
    expect(node.width).toBe(50)
    expect(node.height).toBe(30)
  })

  it('accounts for letterSpacing and lineHeight of the node', () => {
    const node = textNode({ width: 1, height: 1, letterSpacing: 5, lineHeight: 2 })
    applyTextMetrics(node, measure)
    expect(node.width).toBe(50 + 5 * 5)
    expect(node.height).toBe(24 * 2)
  })
})

describe('measureLineWidthCanvas', () => {
  it('measures a line through the canvas 2D API', () => {
    const width = measureLineWidthCanvas('Hello', 'sans-serif', 24, 400)
    expect(width).toBeGreaterThan(0)
    expect(Number.isFinite(width)).toBe(true)
  })
})
