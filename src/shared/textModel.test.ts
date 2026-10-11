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
})

describe('applyTextMetrics', () => {
  it('refreshes the placed size from the content', () => {
    const node = textNode({ width: 1, height: 1 })
    applyTextMetrics(node, measure)
    expect(node.width).toBe(50)
    expect(node.height).toBe(30)
  })
})

describe('measureLineWidthCanvas', () => {
  it('measures a line through the canvas 2D API', () => {
    const width = measureLineWidthCanvas('Hello', 'sans-serif', 24, 400)
    expect(width).toBeGreaterThan(0)
    expect(Number.isFinite(width)).toBe(true)
  })
})
