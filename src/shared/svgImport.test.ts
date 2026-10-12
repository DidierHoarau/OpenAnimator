import { describe, expect, it } from 'vitest'

import type { Asset, GroupNode, PathNode, PrimitiveNode, SymbolNode } from './model'
import { collapseDuplicateShapes, importSvgAsVectors, parseSvgXml } from './svgImport'

function encode(source: string): Uint8Array {
  return new TextEncoder().encode(source)
}

function importOk(source: string): { group: GroupNode; assets: Asset[] } {
  const result = importSvgAsVectors(encode(source))
  if (!result.ok) throw new Error(`expected a successful import, got: ${result.reason}`)
  return { group: result.group, assets: result.assets }
}

function importReason(source: string): string {
  const result = importSvgAsVectors(encode(source))
  if (result.ok) throw new Error('expected the import to fail')
  return result.reason
}

const HEADER = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50">'

describe('parseSvgXml', () => {
  it('tolerates prolog, comments, doctype and trailing comments', () => {
    const parsed = parseSvgXml(
      '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD" [<!ENTITY x "y">]>' +
        '<!-- lead --><svg a="1&amp;2"><rect/></svg><!-- trail -->'
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.name).toBe('svg')
    expect(parsed.value.attributes.get('a')).toBe('1&2')
    expect(parsed.value.children[0].name).toBe('rect')
  })

  it('rejects mismatched closing tags and unterminated markup', () => {
    expect(parseSvgXml('<svg><rect></svg>')).toEqual({
      ok: false,
      reason: 'malformed XML: mismatched closing tag for <rect>'
    })
    expect(parseSvgXml('<svg><rect/>')).toEqual({
      ok: false,
      reason: 'malformed XML: <svg> is never closed'
    })
    expect(parseSvgXml('<svg a="1')).toEqual({
      ok: false,
      reason: 'malformed XML: unterminated attribute "a"'
    })
  })

  it('rejects duplicate attributes and content after the root', () => {
    expect(parseSvgXml('<svg width="1" width="2"/>')).toEqual({
      ok: false,
      reason: 'malformed XML: duplicate attribute "width"'
    })
    expect(parseSvgXml('<svg/><svg/>')).toEqual({
      ok: false,
      reason: 'malformed XML: content after the root element'
    })
  })

  it('decodes numeric entities and rejects unknown ones', () => {
    const parsed = parseSvgXml('<svg a="&#65;&#x42;&quot;"/>')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.attributes.get('a')).toBe('AB"')
    expect(parseSvgXml('<svg a="&bogus;"/>').ok).toBe(false)
  })
})

describe('importSvgAsVectors — shapes', () => {
  it('converts an axis-aligned rect into a primitive with its fill', () => {
    const { group } = importOk(`${HEADER}<rect x="10" y="10" width="30" height="20" fill="#ff0000"/></svg>`)
    expect(group.width).toBe(30)
    expect(group.height).toBe(20)
    expect(group.center).toEqual({ x: 25, y: 20 })
    const rect = group.children[0] as PrimitiveNode
    expect(rect.type).toBe('primitive')
    expect(rect.primitive).toBe('rect')
    expect(rect.center).toEqual({ x: 0, y: 0 })
    expect(rect.width).toBe(30)
    expect(rect.height).toBe(20)
    expect(rect.fill).toBe('#ff0000')
    expect(rect.rotation).toBe(0)
    expect(rect.opacity).toBe(1)
  })

  it('defaults fill to black and expands #rgb colors', () => {
    const { group } = importOk(`${HEADER}<rect width="10" height="10" fill="#ABC"/></svg>`)
    expect((group.children[0] as PrimitiveNode).fill).toBe('#aabbcc')
    const { group: plain } = importOk(`${HEADER}<rect width="10" height="10"/></svg>`)
    expect((plain.children[0] as PrimitiveNode).fill).toBe('#000000')
  })

  it('keeps circles and ellipses as primitives', () => {
    const { group } = importOk(
      `${HEADER}<circle cx="30" cy="40" r="10" fill="#00ff00"/><ellipse cx="70" cy="25" rx="8" ry="4" fill="#0000ff"/></svg>`
    )
    const circle = group.children[0] as PrimitiveNode
    expect(circle.primitive).toBe('ellipse')
    expect(circle.center).toEqual({ x: 30 - group.center.x, y: 40 - group.center.y })
    expect(circle.width).toBe(20)
    expect(circle.height).toBe(20)
    const ellipse = group.children[1] as PrimitiveNode
    expect(ellipse.primitive).toBe('ellipse')
    expect(ellipse.width).toBe(16)
    expect(ellipse.height).toBe(8)
  })

  it('converts rounded rects, lines, polylines and polygons into paths', () => {
    const { group } = importOk(
      HEADER +
        '<rect x="0" y="0" width="20" height="10" rx="4" fill="#ff0000"/>' +
        '<line x1="0" y1="0" x2="10" y2="10" stroke="#000000" stroke-width="2"/>' +
        '<polyline points="0,0 5,5 10,0" fill="none" stroke="#000000"/>' +
        '<polygon points="20,0 30,0 25,10" fill="#00ff00"/>' +
        '</svg>'
    )
    expect(group.children).toHaveLength(4)
    for (const child of group.children) expect(child.type).toBe('path')
    const line = group.children[1] as PathNode
    expect(line.fill).toBeUndefined()
    expect(line.stroke).toBe('#000000')
    expect(line.strokeWidth).toBe(2)
    expect(line.center).toEqual({ x: 5 - group.center.x, y: 5 - group.center.y })
    expect(line.width).toBe(10)
  })

  it('parses every supported path command but rejects arcs', () => {
    const { group } = importOk(
      `${HEADER}<path d="M0 0 H10 V10 S15 15 20 20 T30 30 C30 40 40 40 50 50 Q60 60 70 70 Z" fill="#123456"/></svg>`
    )
    expect(group.children[0].type).toBe('path')
    expect(importReason(`${HEADER}<path d="M0 0 A5 5 0 0 1 10 10"/></svg>`)).toBe(
      'path data uses unsupported or malformed commands (arcs cannot be converted)'
    )
  })

  it('skips degenerate shapes and fails when nothing is drawable', () => {
    const { group } = importOk(
      `${HEADER}<rect width="0" height="10"/><circle r="0"/><line x1="1" y1="1" x2="1" y2="1"/>` +
        '<rect x="5" y="5" width="10" height="10" fill="#ff0000"/></svg>'
    )
    expect(group.children).toHaveLength(1)
    expect(
      importReason(`${HEADER}<rect width="0" height="10"/><polyline points="3,3"/></svg>`)
    ).toBe('no supported drawable shapes were found')
  })
})

describe('importSvgAsVectors — transforms', () => {
  it('bakes translate/scale into primitives', () => {
    const { group } = importOk(
      `${HEADER}<rect x="10" y="10" width="30" height="20" fill="#ff0000" transform="translate(5 7) scale(2)"/></svg>`
    )
    const rect = group.children[0] as PrimitiveNode
    expect(rect.type).toBe('primitive')
    expect(rect.center).toEqual({ x: 55 - group.center.x, y: 47 - group.center.y })
    expect(rect.width).toBe(60)
    expect(rect.height).toBe(40)
  })

  it('converts rotated rects into paths with rotated bounds', () => {
    const { group } = importOk(
      `${HEADER}<rect x="10" y="10" width="30" height="20" fill="#ff0000" transform="rotate(45)"/></svg>`
    )
    const path = group.children[0] as PathNode
    expect(path.type).toBe('path')
    expect(path.width).toBeCloseTo(35.36, 0)
    expect(path.height).toBeCloseTo(35.36, 0)
  })

  it('supports rotate(a cx cy) and matrix(...)', () => {
    const { group } = importOk(
      HEADER +
        '<rect x="40" y="15" width="20" height="20" fill="#ff0000" transform="rotate(90 50 25)"/>' +
        '<rect x="0" y="0" width="10" height="10" fill="#00ff00" transform="matrix(1 0 0 1 5 5)"/>' +
        '</svg>'
    )
    // rotate(90 50 25) about its own center stays a rect-shaped path; the
    // translated matrix rect is axis-aligned.
    const translated = group.children[1] as PrimitiveNode
    expect(translated.type).toBe('primitive')
    expect(translated.center).toEqual({ x: 10 - group.center.x, y: 10 - group.center.y })
  })

  it('inherits transforms and paints through groups', () => {
    const { group } = importOk(
      `${HEADER}<g fill="#ff0000" transform="translate(10 20)"><rect width="10" height="10"/></g></svg>`
    )
    const rect = group.children[0] as PrimitiveNode
    expect(rect.fill).toBe('#ff0000')
    expect(rect.center).toEqual({ x: 0, y: 0 })
    expect(group.center).toEqual({ x: 15, y: 25 })
  })

  it('rejects skew and unknown transforms', () => {
    expect(importReason(`${HEADER}<rect width="5" height="5" transform="skewX(10)"/></svg>`)).toBe(
      'unsupported transform "skewX(10)"'
    )
  })
})

describe('importSvgAsVectors — viewport and style', () => {
  it('maps the viewBox with xMidYMid meet and centers it', () => {
    const { group } = importOk(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 10 5">' +
        '<rect width="10" height="5" fill="#ff0000"/></svg>'
    )
    const rect = group.children[0] as PrimitiveNode
    expect(rect.width).toBe(100)
    expect(rect.height).toBe(50)
    // meet: unscaled 10×5 content lands centered in the 100×100 viewport.
    expect(rect.center).toEqual({ x: 50 - group.center.x, y: 50 - group.center.y })
  })

  it('supports preserveAspectRatio="none" by non-uniform scaling', () => {
    const { group } = importOk(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 10 5" preserveAspectRatio="none">' +
        '<rect width="10" height="5" fill="#ff0000"/></svg>'
    )
    const rect = group.children[0] as PrimitiveNode
    expect(rect.width).toBe(100)
    expect(rect.height).toBe(100)
  })

  it('rejects malformed viewBox values and unsupported preserveAspectRatio', () => {
    expect(importReason('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 10"><rect width="5" height="5"/></svg>')).toBe(
      'malformed viewBox "0 0 0 10"'
    )
    expect(
      importReason(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" preserveAspectRatio="xMinYMin slice"><rect width="5" height="5"/></svg>'
      )
    ).toBe('unsupported preserveAspectRatio "xMinYMin slice"')
  })

  it('resolves style declarations over presentation attributes', () => {
    const { group } = importOk(
      `${HEADER}<rect width="10" height="10" fill="#000000" style="fill:#00ff00;stroke:#123456;stroke-width:3px"/></svg>`
    )
    const rect = group.children[0] as PrimitiveNode
    expect(rect.fill).toBe('#00ff00')
    expect(rect.stroke).toBe('#123456')
    expect(rect.strokeWidth).toBe(3)
  })

  it('rejects unsupported style properties and colors', () => {
    expect(importReason(`${HEADER}<rect width="5" height="5" style="fill-rule:evenodd"/></svg>`)).toBe(
      'unsupported style property "fill-rule"'
    )
    expect(importReason(`${HEADER}<rect width="5" height="5" fill="red"/></svg>`)).toBe(
      'unsupported color "red" (supported: none, #rgb, #rrggbb)'
    )
  })

  it('multiplies opacity down the tree and clamps it', () => {
    const { group } = importOk(
      `${HEADER}<g opacity="0.5"><rect width="10" height="10" opacity="0.5"/></g></svg>`
    )
    expect((group.children[0] as PrimitiveNode).opacity).toBe(0.25)
  })

  it('drops stroke fields for stroke="none" or zero width', () => {
    const { group } = importOk(
      HEADER +
        '<rect width="10" height="10" fill="#ff0000" stroke="none" stroke-width="3"/>' +
        '<rect x="20" width="10" height="10" fill="#ff0000" stroke="#000000" stroke-width="0"/>' +
        '</svg>'
    )
    for (const child of group.children) {
      expect((child as PrimitiveNode).stroke).toBeUndefined()
      expect((child as PrimitiveNode).strokeWidth).toBeUndefined()
    }
  })

  it('scales stroke widths by the accumulated transform', () => {
    const { group } = importOk(
      `${HEADER}<g transform="scale(2)"><line x1="0" y1="0" x2="5" y2="5" stroke="#000000" stroke-width="1"/></g></svg>`
    )
    expect((group.children[0] as PathNode).strokeWidth).toBe(2)
  })
})

describe('importSvgAsVectors — unsupported input', () => {
  it('rejects unsupported elements and attributes', () => {
    expect(importReason(`${HEADER}<filter id="f"/></svg>`)).toBe('unsupported element <filter>')
    expect(importReason(`${HEADER}<path d="M0 0 L1 1" fill-rule="evenodd"/></svg>`)).toBe(
      'unsupported attribute "fill-rule" on <path>'
    )
    expect(
      importReason('<svg xmlns="http://www.w3.org/2000/svg"><svg><rect width="5" height="5"/></svg></svg>')
    ).toBe('nested <svg> elements are not supported')
    expect(importReason(`${HEADER}<rect width="5" height="5"><circle r="5"/></rect></svg>`)).toBe(
      'unexpected content inside <rect>'
    )
  })

  it('ignores title/desc/metadata, namespaced and data-* attributes', () => {
    const { group } = importOk(
      HEADER.replace(
        '>',
        ' data-name="x" xml:space="preserve">'
      ) +
        '<title>t</title><desc><![CDATA[raw]]></desc><metadata/>' +
        '<rect width="10" height="10" fill="#ff0000" data-id="r1"/></svg>'
    )
    expect(group.children).toHaveLength(1)
  })

  it('rejects units other than px, malformed points and negative sizes', () => {
    expect(importReason(`${HEADER}<rect width="10mm" height="10"/></svg>`)).toBe(
      'unsupported value "10mm" for width (only unitless px lengths)'
    )
    expect(importReason(`${HEADER}<polyline points="0,0 5"/></svg>`)).toBe(
      'malformed points list "0,0 5" (odd number of coordinates)'
    )
    expect(importReason(`${HEADER}<rect width="-5" height="5"/></svg>`)).toBe('negative rect size')
  })

  it('rejects non-svg roots, invalid UTF-8 and empty documents', () => {
    expect(importReason('<html></html>')).toBe('the root element is not <svg>')
    const invalid = importSvgAsVectors(new Uint8Array([0xff, 0xff]))
    expect(invalid).toEqual({ ok: false, reason: 'the file is not valid UTF-8 text' })
    const empty = importSvgAsVectors(new Uint8Array(0))
    expect(empty).toEqual({ ok: false, reason: 'malformed XML: the document is empty' })
  })
})

describe('collapseDuplicateShapes', () => {
  function rect(id: string, x: number, fill = '#ff0000'): PrimitiveNode {
    return {
      type: 'primitive',
      primitive: 'rect',
      id,
      center: { x, y: 10 },
      width: 30,
      height: 20,
      rotation: 0,
      opacity: 1,
      fill
    }
  }

  it('collapses ≥2 identical shapes into one symbol asset with per-instance transforms', () => {
    const { nodes, assets } = collapseDuplicateShapes([
      rect('a', 10),
      rect('b', 70),
      rect('c', 130, '#00ff00')
    ])
    expect(assets).toHaveLength(1)
    expect(assets[0].kind).toBe('symbol')
    expect(assets[0].content?.children).toHaveLength(1)
    expect(assets[0].content?.children[0]).toMatchObject({ center: { x: 0, y: 0 } })
    expect(nodes[0].type).toBe('symbol')
    expect(nodes[1].type).toBe('symbol')
    expect(nodes[2].type).toBe('primitive')
    const first = nodes[0] as SymbolNode
    const second = nodes[1] as SymbolNode
    expect(first.assetId).toBe(second.assetId)
    expect(first.center).toEqual({ x: 10, y: 10 })
    expect(second.center).toEqual({ x: 70, y: 10 })
    expect(first.opacity).toBe(1)
  })

  it('recurses into groups and leaves unique shapes untouched', () => {
    const { nodes, assets } = collapseDuplicateShapes([
      { type: 'group', id: 'g', center: { x: 0, y: 0 }, width: 0, height: 0, rotation: 0, opacity: 1, children: [rect('a', 10), rect('b', 70)] },
      rect('c', 5, '#00ff00')
    ])
    expect(assets).toHaveLength(1)
    const group = nodes[0] as GroupNode
    expect(group.children.every((child) => child.type === 'symbol')).toBe(true)
    expect(nodes[1]).toEqual(rect('c', 5, '#00ff00'))
  })

  it('is a no-op when nothing repeats', () => {
    const { nodes, assets } = collapseDuplicateShapes([rect('a', 10), rect('b', 70, '#00ff00')])
    expect(assets).toHaveLength(0)
    expect(nodes.map((node) => node.id)).toEqual(['a', 'b'])
  })
})

describe('importSvgAsVectors — duplicate collapse integration', () => {
  it('collapses repeated shapes into symbol instances inside the imported group', () => {
    const { group, assets } = importOk(
      HEADER +
        '<rect x="10" y="10" width="30" height="20" fill="#ff0000"/>' +
        '<rect x="60" y="10" width="30" height="20" fill="#ff0000"/>' +
        '</svg>'
    )
    expect(assets).toHaveLength(1)
    expect(group.width).toBe(80)
    expect(group.children.every((child) => child.type === 'symbol')).toBe(true)
    expect(group.children.map((child) => child.center.x)).toEqual([-25, 25])
  })
})
