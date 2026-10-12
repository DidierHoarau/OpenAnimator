import { describe, expect, it } from 'vitest'

import { escapeXmlAttribute, nodeToSvgMarkup, renderLayersToSvgMarkup } from './renderSvg'
import type { GroupNode, ImageNode, PathNode, PrimitiveNode, SymbolNode, TextNode } from './model'
import type { GradientPaint } from './paint'
import { paintGradientId } from './paint'
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

  it('emits stroke-style attributes after the paint, only when set', () => {
    const styled = nodeToSvgMarkup(
      shape({
        stroke: '#000000',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'bevel',
        strokeDasharray: [6, 4],
        strokeDashoffset: 2
      })
    )
    expect(styled).toContain(
      'stroke="#000000" stroke-linecap="round" stroke-linejoin="bevel" ' +
        'stroke-dasharray="6 4" stroke-dashoffset="2" stroke-width="2"'
    )
    // Fields without a stroke are inert and stay out of the markup.
    const inert = nodeToSvgMarkup(shape({ strokeLinecap: 'round', strokeDasharray: [6, 4], strokeDashoffset: 2 }))
    expect(inert).not.toContain('stroke-linecap')
    expect(inert).not.toContain('stroke-dasharray')
    expect(inert).not.toContain('stroke-dashoffset')
    // Pre-v8 nodes (no fields) keep the exact historical markup.
    expect(nodeToSvgMarkup(shape({ stroke: '#000000', strokeWidth: 2 }))).toBe(
      '<rect x="-50" y="-25" width="100" height="50" fill="#38bdf8" stroke="#000000" stroke-width="2" ' +
        'transform="translate(120 80) rotate(0)" opacity="1"/>'
    )
  })

  it('emits the dash pattern space-joined, including single-value and fractional dashes', () => {
    const single = nodeToSvgMarkup(shape({ stroke: '#000000', strokeDasharray: [6] }))
    expect(single).toContain('stroke-dasharray="6"')
    const fractional = nodeToSvgMarkup(shape({ stroke: '#000000', strokeDasharray: [0.5, 1.25, 2] }))
    expect(fractional).toContain('stroke-dasharray="0.5 1.25 2"')
    const zeroOffset = nodeToSvgMarkup(shape({ stroke: '#000000', strokeDashoffset: 0 }))
    expect(zeroOffset).toContain('stroke-dashoffset="0"')
  })

  it('emits stroke styles on path and text nodes too', () => {
    const path: PathNode = {
      type: 'path',
      id: 'p-styled',
      center: { x: 0, y: 0 },
      width: 40,
      height: 20,
      rotation: 0,
      opacity: 1,
      d: 'M-20 -10L20 10',
      stroke: '#f59e0b',
      strokeWidth: 3,
      strokeLinecap: 'square',
      strokeDasharray: [4, 2],
      strokeDashoffset: 1
    }
    expect(nodeToSvgMarkup(path)).toContain(
      'stroke="#f59e0b" stroke-linecap="square" stroke-dasharray="4 2" stroke-dashoffset="1" stroke-width="3"'
    )

    const node: TextNode = {
      type: 'text',
      id: 't-styled',
      center: { x: 0, y: 0 },
      width: 100,
      height: 30,
      rotation: 0,
      opacity: 1,
      text: 'Hi',
      fontFamily: 'Noto Sans',
      fontSize: 24,
      fontWeight: 400,
      fill: '#e2e8f0',
      align: 'left',
      stroke: '#000000',
      strokeWidth: 1,
      strokeLinejoin: 'bevel',
      strokeDasharray: [2, 2]
    }
    expect(nodeToSvgMarkup(node)).toContain(
      'stroke="#000000" stroke-linejoin="bevel" stroke-dasharray="2 2" stroke-width="1"'
    )
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

  it('renders an image node as <image href> when the resolver yields a URL', () => {
    const resolve = (id: string): string | null => (id === 'res-1' ? 'blob:img-1' : null)
    expect(nodeToSvgMarkup(image(), resolve)).toBe(
      '<image href="blob:img-1" x="-40" y="-30" width="80" height="60" ' +
        'preserveAspectRatio="none" transform="translate(40 30) rotate(0)" opacity="1"/>'
    )
  })

  it('falls back to the placeholder when the resource is missing', () => {
    const resolve = (): string | null => null
    expect(nodeToSvgMarkup(image(), resolve)).toBe(nodeToSvgMarkup(image()))
  })

  it('marks unsmoothed images as pixelated', () => {
    const resolve = (): string | null => 'blob:img-1'
    const markup = nodeToSvgMarkup(image({ smoothing: false }), resolve)
    expect(markup).toContain('style="image-rendering: pixelated"')
    expect(nodeToSvgMarkup(image({ smoothing: true }), resolve)).not.toContain('pixelated')
  })

  it('escapes hostile URLs so they cannot break out of the href attribute', () => {
    const hostile = '" onerror="alert(1)'
    const markup = nodeToSvgMarkup(image(), () => hostile)
    // The quotes are escaped, so the whole string stays one attribute value.
    expect(markup).toContain('href="&quot; onerror=&quot;alert(1)"')
    expect(markup.startsWith('<image href="&quot;')).toBe(true)
  })

  it('threads the resolver into group children', () => {
    const groupWithImage: GroupNode = {
      type: 'group',
      id: 'g2',
      center: { x: 0, y: 0 },
      width: 80,
      height: 60,
      rotation: 0,
      opacity: 1,
      children: [image({ center: { x: 0, y: 0 } })]
    }
    const markup = nodeToSvgMarkup(groupWithImage, () => 'blob:img-1')
    expect(markup).toContain('<image href="blob:img-1"')
    expect(nodeToSvgMarkup(groupWithImage)).toContain('stroke-dasharray')
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

  it('renders a path with its placed scale folded into the transform', () => {
    const path: PathNode = {
      type: 'path',
      id: 'p1',
      center: { x: 100, y: 50 },
      width: 40,
      height: 20,
      rotation: 0,
      opacity: 1,
      d: 'M-20 -10L20 10',
      stroke: '#f59e0b',
      strokeWidth: 3
    }
    const markup = nodeToSvgMarkup(path)
    // Natural bbox of the data is 40×20, so the placed size maps 1:1.
    expect(markup).toBe(
      '<g transform="translate(100 50) rotate(0) scale(1 1)" opacity="1">' +
        '<path d="M-20 -10L20 10" fill="none" stroke="#f59e0b" stroke-width="3"/></g>'
    )
  })

  it('scales path geometry to the placed size and fills when a fill is set', () => {
    const path: PathNode = {
      type: 'path',
      id: 'p2',
      center: { x: 0, y: 0 },
      width: 80,
      height: 40,
      rotation: 0,
      opacity: 0.5,
      d: 'M-20 -10L20 10',
      fill: '#22d3ee'
    }
    const markup = nodeToSvgMarkup(path)
    expect(markup).toContain('scale(2 2)')
    expect(markup).toContain('fill="#22d3ee"')
    expect(markup).toContain('opacity="0.5"')
    expect(markup).not.toContain('stroke=')
  })

  it('escapes hostile path data into the d attribute', () => {
    const path: PathNode = {
      type: 'path',
      id: 'p3',
      center: { x: 0, y: 0 },
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      d: 'M0 0"><script>alert(1)</script>'
    }
    const markup = nodeToSvgMarkup(path)
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('d="M0 0&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')
  })

  it('renders text lines as tspans anchored by alignment', () => {
    const node: TextNode = {
      type: 'text',
      id: 't1',
      center: { x: 100, y: 50 },
      width: 100,
      height: 60,
      rotation: 0,
      opacity: 1,
      text: 'Hello\nWorld',
      fontFamily: 'Noto Sans',
      fontSize: 24,
      fontWeight: 700,
      fill: '#e2e8f0',
      align: 'center'
    }
    const markup = nodeToSvgMarkup(node)
    expect(markup.startsWith('<text font-family="Noto Sans" font-size="24" font-weight="700" fill="#e2e8f0" text-anchor="middle" transform="translate(100 50) rotate(0)" opacity="1">')).toBe(true)
    // Baselines: -30 + 19.2 for the first line, + 30 for the second.
    expect(markup).toContain('<tspan x="0" y="-10.8">Hello</tspan>')
    expect(markup).toContain('<tspan x="0" y="19.2">World</tspan>')
    expect(markup.endsWith('</text>')).toBe(true)
  })

  it('renders left- and right-aligned text anchored to the box edges', () => {
    const base: TextNode = {
      type: 'text',
      id: 't2',
      center: { x: 0, y: 0 },
      width: 100,
      height: 30,
      rotation: 0,
      opacity: 1,
      text: 'Hi',
      fontFamily: 'Noto Sans',
      fontSize: 24,
      fontWeight: 400,
      fill: '#ffffff',
      align: 'left'
    }
    expect(nodeToSvgMarkup(base)).toContain('<tspan x="-50"')
    expect(nodeToSvgMarkup({ ...base, align: 'right' })).toContain('<tspan x="50"')
  })

  it('escapes hostile text content so it cannot inject markup', () => {
    const node: TextNode = {
      type: 'text',
      id: 't3',
      center: { x: 0, y: 0 },
      width: 100,
      height: 30,
      rotation: 0,
      opacity: 1,
      text: '<script>alert(1)</script>',
      fontFamily: 'Noto Sans',
      fontSize: 24,
      fontWeight: 400,
      fill: '#ffffff',
      align: 'left'
    }
    const markup = nodeToSvgMarkup(node)
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('adds letter-spacing and text stroke only when set', () => {
    const node: TextNode = {
      type: 'text',
      id: 't4',
      center: { x: 0, y: 0 },
      width: 100,
      height: 30,
      rotation: 0,
      opacity: 1,
      text: 'Hi',
      fontFamily: 'Noto Sans',
      fontSize: 24,
      fontWeight: 400,
      fill: '#ffffff',
      align: 'left'
    }
    const plain = nodeToSvgMarkup(node)
    expect(plain).not.toContain('letter-spacing')
    expect(plain).not.toContain('stroke')

    const styled = nodeToSvgMarkup({ ...node, letterSpacing: 2.5, stroke: '#111111', strokeWidth: 3 })
    expect(styled).toContain('letter-spacing="2.5"')
    expect(styled).toContain('stroke="#111111"')
    expect(styled).toContain('stroke-width="3"')
    // Attribute order keeps the legacy defaults byte-identical.
    expect(styled.startsWith('<text font-family="Noto Sans" font-size="24" font-weight="400" letter-spacing="2.5" fill="#ffffff" stroke="#111111" stroke-width="3" text-anchor="start"')).toBe(true)
  })

  it('extends the family list only for embedded fonts or explicit fallbacks', () => {
    const node: TextNode = {
      type: 'text',
      id: 't5',
      center: { x: 0, y: 0 },
      width: 100,
      height: 30,
      rotation: 0,
      opacity: 1,
      text: 'Hi',
      fontFamily: 'My Font',
      fontSize: 24,
      fontWeight: 400,
      fill: '#ffffff',
      align: 'left'
    }
    expect(nodeToSvgMarkup(node)).toContain('font-family="My Font"')

    const withFallback = nodeToSvgMarkup({ ...node, fontFallback: ['Lato'] })
    // Single quotes inside the family list are XML-escaped like every other
    // attribute value.
    expect(withFallback).toContain('font-family="&apos;My Font&apos;, Lato, &apos;Noto Sans&apos;, sans-serif"')

    const withEmbedded = nodeToSvgMarkup(node, undefined, {
      resolveEmbeddedFont: (family, weight) => (family === 'My Font' && weight === 400 ? 'oa-embed-400-ab12cd34' : null)
    })
    expect(withEmbedded).toContain('font-family="oa-embed-400-ab12cd34, &apos;My Font&apos;, &apos;Noto Sans&apos;, sans-serif"')

    const resolverMiss = nodeToSvgMarkup(node, undefined, { resolveEmbeddedFont: () => null })
    expect(resolverMiss).toContain('font-family="My Font"')
  })

  it('emits italic and ligature styles only when set', () => {
    const node: TextNode = {
      type: 'text',
      id: 't5b',
      center: { x: 0, y: 0 },
      width: 100,
      height: 30,
      rotation: 0,
      opacity: 1,
      text: 'Hi',
      fontFamily: 'My Font',
      fontSize: 24,
      fontWeight: 400,
      fill: '#ffffff',
      align: 'left'
    }
    expect(nodeToSvgMarkup(node)).not.toContain('style=')
    expect(nodeToSvgMarkup({ ...node, fontStyle: 'normal', ligatures: true })).not.toContain('style=')
    expect(nodeToSvgMarkup({ ...node, fontStyle: 'italic' })).toContain('style="font-style: italic"')
    expect(nodeToSvgMarkup({ ...node, ligatures: false })).toContain('style="font-variant-ligatures: none"')
    expect(nodeToSvgMarkup({ ...node, fontStyle: 'italic', ligatures: false })).toContain(
      'style="font-style: italic; font-variant-ligatures: none"'
    )
  })

  it('passes the node style to the embedded-font resolver', () => {
    const node: TextNode = {
      type: 'text',
      id: 't5c',
      center: { x: 0, y: 0 },
      width: 100,
      height: 30,
      rotation: 0,
      opacity: 1,
      text: 'Hi',
      fontFamily: 'My Font',
      fontSize: 24,
      fontWeight: 400,
      fill: '#ffffff',
      align: 'left'
    }
    const calls: Array<[string, number, boolean | undefined]> = []
    const markup = nodeToSvgMarkup({ ...node, fontStyle: 'italic' }, undefined, {
      resolveEmbeddedFont: (family, weight, italic) => {
        calls.push([family, weight, italic])
        return italic ? 'oa-embed-400-ab12cd34i' : 'oa-embed-400-ab12cd34'
      }
    })
    expect(calls).toEqual([['My Font', 400, true]])
    expect(markup).toContain('font-family="oa-embed-400-ab12cd34i, &apos;My Font&apos;')
  })

  it('re-places baselines for bottom vertical alignment', () => {
    const node: TextNode = {
      type: 'text',
      id: 't6',
      center: { x: 0, y: 0 },
      width: 100,
      height: 60,
      rotation: 0,
      opacity: 1,
      text: 'Hi',
      fontFamily: 'Noto Sans',
      fontSize: 24,
      fontWeight: 400,
      fill: '#ffffff',
      align: 'left',
      verticalAlign: 'bottom'
    }
    // 30 - 1 × 30 + 19.2 = 19.2
    expect(nodeToSvgMarkup(node)).toContain('<tspan x="-50" y="19.2">Hi</tspan>')
  })
})

describe('renderSvg — gradients', () => {
  const linear: GradientPaint = {
    type: 'linear',
    angle: 0,
    stops: [
      { offset: 0, color: '#ff0000' },
      { offset: 1, color: '#0000ff' }
    ]
  }
  const radial: GradientPaint = {
    type: 'radial',
    cx: 0.25,
    cy: 0.75,
    r: 0.5,
    stops: [
      { offset: 0, color: '#ffffff' },
      { offset: 1, color: '#000000' }
    ]
  }

  it('emits a content-hashed linearGradient defs block and references it', () => {
    const id = paintGradientId(linear)
    const markup = nodeToSvgMarkup(shape({ fill: linear }))
    expect(markup.startsWith(`<defs><linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="0" y1="0.5" x2="1" y2="0.5">`)).toBe(true)
    expect(markup).toContain('<stop offset="0" stop-color="#ff0000"/>')
    expect(markup).toContain('<stop offset="1" stop-color="#0000ff"/>')
    expect(markup).toContain('fill="url(#' + id + ')"')
    expect(markup.endsWith('/>')).toBe(true)
  })

  it('maps the gradient angle onto the axis endpoints', () => {
    const id = paintGradientId({ ...linear, angle: 90 })
    const markup = nodeToSvgMarkup(shape({ fill: { ...linear, angle: 90 } }))
    expect(markup).toContain(`<linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="0.5" y1="0" x2="0.5" y2="1">`)
  })

  it('emits radial defs with the paint geometry and rounds stop offsets', () => {
    const paint: GradientPaint = {
      ...radial,
      stops: [
        { offset: 0.33333, color: '#ffffff' },
        { offset: 1, color: '#000000' }
      ]
    }
    const id = paintGradientId(paint)
    const markup = nodeToSvgMarkup(shape({ fill: paint }))
    expect(markup).toContain(
      `<radialGradient id="${id}" gradientUnits="objectBoundingBox" cx="0.25" cy="0.75" r="0.5">`
    )
    expect(markup).toContain('<stop offset="0.3333" stop-color="#ffffff"/>')
  })

  it('emits stop-opacity only for stops whose alpha is set and not 1', () => {
    const paint: GradientPaint = {
      ...linear,
      stops: [
        { offset: 0, color: '#ff0000', alpha: 0.4 },
        { offset: 0.5, color: '#00ff00', alpha: 1 },
        { offset: 1, color: '#0000ff' }
      ]
    }
    const markup = nodeToSvgMarkup(shape({ fill: paint }))
    expect(markup).toContain('<stop offset="0" stop-color="#ff0000" stop-opacity="0.4"/>')
    expect(markup).toContain('<stop offset="0.5" stop-color="#00ff00"/>')
    expect(markup).toContain('<stop offset="1" stop-color="#0000ff"/>')
    expect(markup).toContain(`fill="url(#${paintGradientId(paint)})"`)
  })

  it('shares one defs entry per unique paint across the whole fragment', () => {
    const layers: RenderLayer[] = [
      {
        layerId: 'l',
        name: 'l',
        nodes: [shape({ id: 'a', fill: linear }), shape({ id: 'b', fill: linear }), shape({ id: 'c', fill: radial })]
      }
    ]
    const markup = renderLayersToSvgMarkup(layers)
    expect(markup.match(/<linearGradient/g)).toHaveLength(1)
    expect(markup.match(/<radialGradient/g)).toHaveLength(1)
    expect(markup.match(/<defs>/g)).toHaveLength(1)
  })

  it('references gradient strokes and emits both paints of one node', () => {
    const id = paintGradientId(radial)
    const markup = nodeToSvgMarkup(shape({ fill: linear, stroke: radial, strokeWidth: 4 }))
    expect(markup).toContain('fill="url(#' + paintGradientId(linear) + ')"')
    expect(markup).toContain(`stroke="url(#${id})" stroke-width="4"`)
    expect(markup.match(/<linearGradient/g)).toHaveLength(1)
    expect(markup.match(/<radialGradient/g)).toHaveLength(1)
  })

  it('keeps the placed transform around gradient paths and text', () => {
    const path: PathNode = {
      type: 'path',
      id: 'p1',
      center: { x: 10, y: 20 },
      width: 40,
      height: 20,
      rotation: 0,
      opacity: 1,
      d: 'M-20 -10L20 10',
      fill: linear
    }
    const pathMarkup = nodeToSvgMarkup(path)
    expect(pathMarkup).toContain('transform="translate(10 20) rotate(0) scale(1 1)"')
    expect(pathMarkup).toContain('fill="url(#' + paintGradientId(linear) + ')"')

    const text: TextNode = {
      type: 'text',
      id: 't1',
      center: { x: 0, y: 0 },
      width: 100,
      height: 30,
      rotation: 0,
      opacity: 1,
      text: 'Hi',
      fontFamily: 'Noto Sans',
      fontSize: 24,
      fontWeight: 400,
      fill: linear,
      align: 'left'
    }
    expect(nodeToSvgMarkup(text)).toContain('fill="url(#' + paintGradientId(linear) + ')"')
  })

  it('suppresses gradient paints entirely in outline mode', () => {
    const markup = nodeToSvgMarkup(shape({ fill: linear, stroke: radial }), undefined, {
      outline: { color: '#e05050' }
    })
    expect(markup).not.toContain('<defs>')
    expect(markup).not.toContain('url(#')
    expect(markup).toContain('stroke="#e05050"')
  })

  it('escapes hostile stop colors so defs cannot inject markup', () => {
    const hostile: GradientPaint = {
      type: 'linear',
      angle: 0,
      stops: [
        { offset: 0, color: '"><script>alert(1)</script>' },
        { offset: 1, color: '#000000' }
      ]
    }
    const markup = nodeToSvgMarkup(shape({ fill: hostile }))
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('stop-color="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')
  })
})

describe('renderSvg — outline option', () => {
  const outline = { outline: { color: '#e05050' } }

  it('renders primitives stroke-only in the outline color', () => {
    const markup = nodeToSvgMarkup(shape({ fill: '#38bdf8', stroke: '#ffffff', strokeWidth: 4 }), undefined, outline)
    expect(markup).toContain('fill="none"')
    expect(markup).toContain('stroke="#e05050"')
    expect(markup).toContain('stroke-width="1"')
    expect(markup).toContain('vector-effect="non-scaling-stroke"')
    // The node's own paints are suppressed.
    expect(markup).not.toContain('#38bdf8')
    expect(markup).not.toContain('stroke-width="4"')
    // Placement stays.
    expect(markup).toContain('transform="translate(120 80) rotate(0)"')
  })

  it('renders ellipses stroke-only and paths inside their placed transform', () => {
    const ellipse = nodeToSvgMarkup(shape({ primitive: 'ellipse' }), undefined, outline)
    expect(ellipse.startsWith('<ellipse rx="50" ry="25" fill="none" stroke="#e05050"')).toBe(true)

    const path: PathNode = {
      type: 'path',
      id: 'p1',
      center: { x: 100, y: 50 },
      width: 40,
      height: 20,
      rotation: 0,
      opacity: 1,
      d: 'M-20 -10L20 10',
      fill: '#22d3ee',
      stroke: '#f59e0b',
      strokeWidth: 3
    }
    const markup = nodeToSvgMarkup(path, undefined, outline)
    expect(markup).toContain('<path d="M-20 -10L20 10" fill="none" stroke="#e05050" stroke-width="1" vector-effect="non-scaling-stroke"/>')
    expect(markup).not.toContain('#f59e0b')
    expect(markup).not.toContain('#22d3ee')
  })

  it('threads the option into group children while keeping the normal wrapper', () => {
    const markup = nodeToSvgMarkup(group(), undefined, outline)
    expect(markup.startsWith('<g transform="translate(100 60) rotate(0) scale(1 1)" opacity="1">')).toBe(true)
    expect(markup).toContain('fill="none" stroke="#e05050"')
  })

  it('keeps text, images and symbols on their normal markup', () => {
    const text: TextNode = {
      type: 'text',
      id: 't1',
      center: { x: 0, y: 0 },
      width: 100,
      height: 30,
      rotation: 0,
      opacity: 1,
      text: 'Hi',
      fontFamily: 'Noto Sans',
      fontSize: 24,
      fontWeight: 400,
      fill: '#ffffff',
      align: 'left'
    }
    expect(nodeToSvgMarkup(text, undefined, outline)).toBe(nodeToSvgMarkup(text))
    expect(nodeToSvgMarkup(image(), undefined, outline)).toBe(nodeToSvgMarkup(image()))
    expect(nodeToSvgMarkup(symbol(), undefined, outline)).toBe(nodeToSvgMarkup(symbol()))
  })

  it('leaves the default markup byte-identical when the option is absent', () => {
    const layers: RenderLayer[] = [
      { layerId: 'l1', name: 'l', nodes: [shape(), shape({ primitive: 'ellipse' })] }
    ]
    expect(renderLayersToSvgMarkup(layers)).toBe(renderLayersToSvgMarkup(layers, undefined, undefined))
    // And the outline variant really differs.
    expect(renderLayersToSvgMarkup(layers, undefined, outline)).not.toBe(renderLayersToSvgMarkup(layers))
  })
})
