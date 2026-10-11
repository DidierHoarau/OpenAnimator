import { describe, expect, it } from 'vitest'

import { escapeXmlAttribute, renderLayersToSvgMarkup, shapeToSvgMarkup } from './renderSvg'
import type { RenderLayer } from './render'
import type { Shape } from './model'

function shape(overrides: Partial<Shape> = {}): Shape {
  return {
    id: 's1',
    kind: 'rect',
    center: { x: 120, y: 80 },
    width: 100,
    height: 50,
    rotation: 0,
    fill: '#38bdf8',
    opacity: 1,
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
    expect(shapeToSvgMarkup(shape())).toBe(
      '<rect x="-50" y="-25" width="100" height="50" fill="#38bdf8" ' +
        'transform="translate(120 80) rotate(0)" opacity="1"/>'
    )
  })

  it('renders an ellipse with radii instead of x/y/width/height', () => {
    expect(shapeToSvgMarkup(shape({ kind: 'ellipse' }))).toBe(
      '<ellipse rx="50" ry="25" fill="#38bdf8" transform="translate(120 80) rotate(0)" opacity="1"/>'
    )
  })

  it('includes stroke attributes when present', () => {
    expect(shapeToSvgMarkup(shape({ stroke: '#e6edf3', strokeWidth: 2 }))).toContain(
      'stroke="#e6edf3" stroke-width="2"'
    )
    expect(shapeToSvgMarkup(shape({ stroke: '#e6edf3' }))).toContain('stroke="#e6edf3"')
    expect(shapeToSvgMarkup(shape())).not.toContain('stroke')
  })

  it('renders rotation, fractional sizes and partial opacity', () => {
    const markup = shapeToSvgMarkup(shape({ rotation: 45, width: 10.5, opacity: 0.5 }))
    expect(markup).toContain('transform="translate(120 80) rotate(45)"')
    expect(markup).toContain('width="10.5"')
    expect(markup).toContain('opacity="0.5"')
  })

  it('escapes hostile fill/stroke values so they cannot break out of the attribute', () => {
    const hostile = '"><script>alert(1)</script>'
    const markup = shapeToSvgMarkup(shape({ fill: hostile }))
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('fill="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')
  })

  it('concatenates layers and their shapes in paint order', () => {
    const layers: RenderLayer[] = [
      { layerId: 'l1', name: 'bottom', shapes: [shape({ id: 'a' })] },
      { layerId: 'l2', name: 'top', shapes: [shape({ id: 'b', kind: 'ellipse' }), shape({ id: 'c' })] }
    ]
    const markup = renderLayersToSvgMarkup(layers)
    expect(markup).toBe(
      shapeToSvgMarkup(shape({ id: 'a' })) +
        shapeToSvgMarkup(shape({ id: 'b', kind: 'ellipse' })) +
        shapeToSvgMarkup(shape({ id: 'c' }))
    )
  })

  it('renders an empty layer list and a layer without shapes to empty markup', () => {
    expect(renderLayersToSvgMarkup([])).toBe('')
    expect(renderLayersToSvgMarkup([{ layerId: 'l', name: 'l', shapes: [] }])).toBe('')
  })
})
