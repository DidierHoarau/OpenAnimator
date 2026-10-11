import { describe, expect, it } from 'vitest'

import { createDocument, createDrawingLayer } from './document'
import { documentToSvgString } from './exportSvg'

describe('documentToSvgString', () => {
  it('builds a standalone SVG of the evaluated frame with the background', () => {
    const document = createDocument('demo', 320, 180, 12)
    const svg = documentToSvgString(document, 0)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('width="320"')
    expect(svg).toContain('height="180"')
    expect(svg).toContain('viewBox="0 0 320 180"')
    expect(svg).toContain(`fill="${document.background}"`)
    expect(svg.endsWith('</svg>')).toBe(true)
  })

  it('omits the backdrop when transparent', () => {
    const document = createDocument('demo', 320, 180, 12)
    const svg = documentToSvgString(document, 0, undefined, { transparent: true })
    expect(svg).not.toContain('<rect')
  })

  it('renders the nodes of the requested frame', () => {
    const document = createDocument('demo', 320, 180, 12)
    const layer = document.layers[0]
    if (layer.kind !== 'object') throw new Error('expected object layer')
    layer.keyframes[0].nodes.push({
      id: 'r1',
      type: 'primitive',
      primitive: 'rect',
      center: { x: 40, y: 40 },
      width: 20,
      height: 10,
      rotation: 0,
      fill: '#ff0000',
      opacity: 1
    })
    const svg = documentToSvgString(document, 0)
    expect(svg).toContain('<rect')
    expect(svg).toContain('fill="#ff0000"')
  })

  it('resolves drawing cells through the injected resource resolver', () => {
    const document = createDocument('demo', 320, 180, 12)
    const drawing = createDrawingLayer('paint')
    drawing.cells.push({ frame: 0, resourceId: 'res-1' })
    document.layers.push(drawing)
    const svg = documentToSvgString(document, 0, (id) => (id === 'res-1' ? 'data:image/png;base64,AAA' : null))
    expect(svg).toContain('href="data:image/png;base64,AAA"')
  })
})
