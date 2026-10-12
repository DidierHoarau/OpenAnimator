import { describe, expect, it } from 'vitest'

import { createCameraLayer, createDocument, createDrawingLayer, insertCameraKeyframe } from './document'
import { cameraTransform, documentToSvgString } from './exportSvg'

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

  it('carries gradient defs into the standalone SVG', () => {
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
      fill: {
        type: 'radial',
        cx: 0.5,
        cy: 0.5,
        r: 0.5,
        stops: [
          { offset: 0, color: '#ff0000' },
          { offset: 1, color: '#0000ff' }
        ]
      },
      opacity: 1
    })
    const svg = documentToSvgString(document, 0)
    // The defs block sits inside the svg root, ahead of the painted node.
    expect(svg).toContain('<defs><radialGradient ')
    expect(svg).toContain('stop-color="#ff0000"')
    expect(svg).toMatch(/<rect [^>]*fill="url\(#oa-grad-[0-9a-z]+\)"/)
  })
})

describe('documentToSvgString — camera', () => {
  it('formats the camera transform around the stage center', () => {
    expect(cameraTransform({ center: { x: 100, y: 80 }, zoom: 2, rotation: 30 }, 320, 180)).toBe(
      'translate(160 90) rotate(-30) scale(2) translate(-100 -80)'
    )
    // -0 and floating noise are normalized away.
    expect(cameraTransform({ center: { x: 160, y: 90 }, zoom: 1, rotation: -0 }, 320, 180)).toBe(
      'translate(160 90) rotate(0) scale(1) translate(-160 -90)'
    )
  })

  it('wraps the layer markup in one <g transform> when a camera is active', () => {
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
    const camera = createCameraLayer('Camera')
    document.layers.push(camera)
    insertCameraKeyframe(document, 0)
    const svg = documentToSvgString(document, 0)
    expect(svg).toContain('<g transform="translate(160 90) rotate(0) scale(1) translate(-160 -90)">')
    // The wrapper encloses the painted node and closes right before </svg>.
    expect(svg).toMatch(/<g transform="[^"]*">.*<rect[^>]*fill="#ff0000"[^>]*\/><\/g><\/svg>/)
  })

  it('applies the tween-sampled pose at the frame', () => {
    const document = createDocument('demo', 320, 180, 12)
    const camera = createCameraLayer('Camera')
    document.layers.push(camera)
    const first = insertCameraKeyframe(document, 0)!
    first.tween = { easing: 'linear' }
    insertCameraKeyframe(document, 10, { center: { x: 160, y: 90 }, zoom: 2, rotation: 0 })
    const svg = documentToSvgString(document, 5)
    expect(svg).toContain('<g transform="translate(160 90) rotate(0) scale(1.5) translate(-160 -90)">')
  })

  it('keeps camera-less markup byte-identical (no camera, empty or hidden camera)', () => {
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
    const baseline = documentToSvgString(document, 0)

    const emptyCamera = createCameraLayer('Camera')
    document.layers.push(emptyCamera)
    expect(documentToSvgString(document, 0)).toBe(baseline)

    // A keyed but hidden camera is switched off: still byte-identical.
    insertCameraKeyframe(document, 0, { center: { x: 10, y: 10 }, zoom: 2, rotation: 45 })
    emptyCamera.visible = false
    expect(documentToSvgString(document, 0)).toBe(baseline)
  })
})
