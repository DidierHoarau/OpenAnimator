import { describe, expect, it } from 'vitest'

import { parseGpl, serializeGpl } from './gpl'

describe('parseGpl', () => {
  it('parses triplets, skipping comments, blanks and metadata', () => {
    const text = [
      'GIMP Palette',
      'Name: Test',
      'Columns: 4',
      '# a comment',
      '255 0 0 Red',
      '',
      '0 255 0',
      '  0   0 255   Blue  '
    ].join('\n')
    expect(parseGpl(text)).toEqual(['#ff0000', '#00ff00', '#0000ff'])
  })

  it('tolerates a BOM and CRLF line endings', () => {
    const text = '\uFEFFGIMP Palette\r\nName: X\r\n#\r\n10 20 30\r\n'
    expect(parseGpl(text)).toEqual(['#0a141e'])
  })

  it('rejects files without the header', () => {
    expect(parseGpl('')).toBeNull()
    expect(parseGpl('just text\n255 0 0')).toBeNull()
    expect(parseGpl('Ascii GIMP Palette\n255 0 0')).toBeNull()
  })

  it('skips malformed lines and out-of-range channels', () => {
    const text = ['GIMP Palette', 'not a color', '300 0 0', '1 2', '255 0 0a'].join('\n')
    expect(parseGpl(text)).toEqual([])
  })

  it('normalizes, dedupes and caps the parsed colors', () => {
    const lines = ['GIMP Palette']
    for (let i = 0; i < 60; i++) lines.push(`${i} ${i} ${i}`)
    lines.push('0 0 0')
    const colors = parseGpl(lines.join('\n'))
    expect(colors).toHaveLength(48)
    expect(colors?.[0]).toBe('#000000')
  })
})

describe('serializeGpl', () => {
  it('writes the GIMP header and one line per color, dropping junk', () => {
    const text = serializeGpl(['#FF0000', '#0000ff', 'bogus'])
    expect(text).toBe('GIMP Palette\nName: OpenAnimator\nColumns: 8\n#\n255 0 0\n0 0 255\n')
  })

  it('round-trips through parseGpl', () => {
    const colors = ['#112233', '#aabbcc']
    expect(parseGpl(serializeGpl(colors))).toEqual(colors)
  })
})
