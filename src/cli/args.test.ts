import { describe, expect, it } from 'vitest'

import { booleanFlag, numberFlag, parseArgs, stringFlag, stringFlags } from './args'

describe('parseArgs', () => {
  it('keeps the input path positional after a known boolean flag', () => {
    // Regression: the next token used to be consumed as the flag's value,
    // leaving no input path (`transparent="in.oanim"`).
    const args = parseArgs(['--transparent', 'in.oanim', '--out', 'out.gif'])

    expect(args.positional).toEqual(['in.oanim'])
    expect(args.flags.get('transparent')).toBe(true)
    expect(args.flags.get('out')).toBe('out.gif')
  })

  it('never consumes a value for any known boolean flag', () => {
    const args = parseArgs(['--transparent', '--gif-dither', 'document.json', '--out', 'a.gif'])

    expect(args.positional).toEqual(['document.json'])
    expect(args.flags.get('transparent')).toBe(true)
    expect(args.flags.get('gif-dither')).toBe(true)
    expect(args.flags.get('out')).toBe('a.gif')
  })

  it('accumulates repeated value flags in command-line order', () => {
    const args = parseArgs(['--format', 'gif', '--format', 'lottie', '--format', 'webm'])

    expect(stringFlags(args.flags, 'format')).toEqual(['gif', 'lottie', 'webm'])
    expect(stringFlag(args.flags, 'format')).toBeUndefined()
  })

  it('treats a bare trailing flag as boolean', () => {
    const args = parseArgs(['in.oanim', '--out', 'out.gif', '--transparent'])

    expect(args.flags.get('transparent')).toBe(true)
    expect(args.positional).toEqual(['in.oanim'])
  })

  it('keeps legacy value consumption for unknown flags', () => {
    const args = parseArgs(['--custom', 'value', '--custom2', '--out', 'x.gif'])

    expect(args.flags.get('custom')).toBe('value')
    expect(args.flags.get('custom2')).toBe(true)
    expect(args.flags.get('out')).toBe('x.gif')
    expect(args.positional).toEqual([])
  })

  it('reads finite numbers and ignores malformed ones', () => {
    const args = parseArgs(['--fps', '25', '--from', 'abc'])

    expect(numberFlag(args.flags, 'fps')).toBe(25)
    expect(numberFlag(args.flags, 'from')).toBeUndefined()
    expect(numberFlag(args.flags, 'missing')).toBeUndefined()
  })

  it('reports presence for boolean flags and strings only for value flags', () => {
    const args = parseArgs(['--transparent', '--out', 'x.gif'])

    expect(booleanFlag(args.flags, 'transparent')).toBe(true)
    expect(booleanFlag(args.flags, 'missing')).toBe(false)
    expect(stringFlag(args.flags, 'transparent')).toBeUndefined()
    expect(stringFlags(args.flags, 'transparent')).toEqual([])
  })
})
