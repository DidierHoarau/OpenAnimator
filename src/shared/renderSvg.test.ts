import { describe, expect, it } from 'vitest'

import { escapeXmlAttribute, nodeToSvgMarkup, renderLayersToSvgMarkup } from './renderSvg'
import type { GroupNode, ImageNode, PrimitiveNode, SymbolNode } from './model'
import type { RenderLayer } from './render'

function shape(overrides: Partial<PrimitiveNode> = {}): PrimitiveNode {
  return {
    type: 'primitive',
    primitive: 'rect',
    id: 's1',
    center: { x: 120, y: 80 },
    width: 100,
    height: 50,
    rotation: 0,
    fill: '#38bdf8',
    opacity: 1,
    ...overrides
  }
}

function group(overrides: Partial<GroupNode> = {}): GroupNode {
  return {
    type: 'group',
    id: 'g1',
    center: { x: 100, y: 60 },
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    children: [shape({ id: 'child', center: { x: 0, y: 0 }, width: 100, height: 50 })],
    ...overrides
  }
}

function image(overrides: Partial<ImageNode> = {}): ImageNode {
  return {
    type: 'image',
    id: 'i1',
    center: { x: 40, y: 30 },
    width: 80,
    height: 60,
    rotation: 0,
    opacity: 1,
    resourceId: 'res-1',
    naturalWidth: 640,
    naturalHeight: 480,
    smoothing: true,
    ...overrides
  }
}

function symbol(overrides: Partial<SymbolNode> = {}): SymbolNode {
  return {
    type: 'symbol',
    id: 'y1',
    center: { x: 10, y: 20 },
    width: 60,
    height: 40,
    rotation: 0,
    opacity: 1,
    assetId: 'asset-1',
    ...overrides
  }
}

describe('renderSvg', () => {
  it('escapes XML-sensitive characters in attribute values', () => {
    expect(escapeXmlAttribute('a & b < c > d " e \' f')).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &apos; f'
    )
    expect(escapeXmlAttribute('plain')).toBe('plain')
  })

  it('renders a rect with the same markup the DOM builder produced', () => {
    expect(nodeToSvgMarkup(shape())).toBe(
      '<rect x="-50" y="-25" width="100" height="50" fill="#38bdf8" ' +
        'transform="translate(120 80) rotate(0)" opacity="1"/>'
    )
  })

  it('renders an ellipse with radii instead of x/y/width/height', () => {
    expect(nodeToSvgMarkup(shape({ primitive: 'ellipse' }))).toBe(
      '<ellipse rx="50" ry="25" fill="#38bdf8" transform="translate(120 80) rotate(0)" opacity="1"/>'
    )
  })

  it('includes stroke attributes when present', () => {
    expect(nodeToSvgMarkup(shape({ stroke: '#e6edf3', strokeWidth: 2 }))).toContain(
      'stroke="#e6edf3" stroke-width="2"'
    )
    expect(nodeToSvgMarkup(shape({ stroke: '#e6edf3' }))).toContain('stroke="#e6edf3"')
    expect(nodeToSvgMarkup(shape())).not.toContain('stroke')
  })

  it('renders rotation, fractional sizes and partial opacity', () => {
    const markup = nodeToSvgMarkup(shape({ rotation: 45, width: 10.5, opacity: 0.5 }))
    expect(markup).toContain('transform="translate(120 80) rotate(45)"')
    expect(markup).toContain('width="10.5"')
    expect(markup).toContain('opacity="0.5"')
  })

  it('escapes hostile fill/stroke values so they cannot break out of the attribute', () => {
    const hostile = '"><script>alert(1)</script>'
    const markup = nodeToSvgMarkup(shape({ fill: hostile }))
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('fill="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')
  })

  it('renders a group as a nested <g> with the placed scale in the transform', () => {
    const markup = nodeToSvgMarkup(group())
    expect(markup.startsWith('<g transform="translate(100 60) rotate(0) scale(1 1)" opacity="1">')).toBe(true)
    expect(markup.endsWith('</g>')).toBe(true)
    // Children render inside the group transform, unmodified.
    expect(markup).toContain(nodeToSvgMarkup(group().children[0]))
  })

  it('folds a resized group into scale(x y) instead of re-encoding children', () => {
    const resized = group({ width: 400 })
    const markup = nodeToSvgMarkup(resized)
    expect(markup).toContain('scale(4 1)')
    // Children keep their natural (local) geometry.
    expect(markup).toContain(nodeToSvgMarkup(resized.children[0]))
  })

  it('guards zero-size groups with a unit scale', () => {
    const empty = group({ children: [] })
    expect(nodeToSvgMarkup(empty)).toContain('scale(1 1)')
  })

  it('renders rotated and translucent groups', () => {
    const markup = nodeToSvgMarkup(group({ rotation: 30, opacity: 0.5 }))
    expect(markup).toContain('rotate(30) scale(1 1)')
    expect(markup).toContain('opacity="0.5"')
  })

  it('renders image and symbol nodes as dashed placeholder boxes', () => {
    const imageMarkup = nodeToSvgMarkup(image())
    expect(imageMarkup).toBe(
      '<rect x="-40" y="-30" width="80" height="60" fill="none" stroke="#94a3b8" ' +
        'stroke-dasharray="4 4" transform="translate(40 30) rotate(0)" opacity="1"/>'
    )
    const symbolMarkup = nodeToSvgMarkup(symbol({ rotation: 10, opacity: 0.25 }))
    expect(symbolMarkup).toContain('stroke-dasharray="4 4"')
    expect(symbolMarkup).toContain('rotate(10)')
    expect(symbolMarkup).toContain('opacity="0.25"')
  })

  it('concatenates layers and their nodes in paint order', () => {
    const layers: RenderLayer[] = [
      { layerId: 'l1', name: 'bottom', nodes: [shape({ id: 'a' })] },
      { layerId: 'l2', name: 'top', nodes: [shape({ id: 'b', primitive: 'ellipse' }), shape({ id: 'c' })] }
    ]
    const markup = renderLayersToSvgMarkup(layers)
    expect(markup).toBe(
      nodeToSvgMarkup(shape({ id: 'a' })) +
        nodeToSvgMarkup(shape({ id: 'b', primitive: 'ellipse' })) +
        nodeToSvgMarkup(shape({ id: 'c' }))
    )
  })

  it('renders an empty layer list and a layer without nodes to empty markup', () => {
    expect(renderLayersToSvgMarkup([])).toBe('')
    expect(renderLayersToSvgMarkup([{ layerId: 'l', name: 'l', nodes: [] }])).toBe('')
  })
})
