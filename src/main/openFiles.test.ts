import { describe, expect, it } from 'vitest'

import { projectPathFromArgv } from './openFiles'

describe('projectPathFromArgv', () => {
  it('finds a Linux-style absolute path', () => {
    expect(projectPathFromArgv(['/usr/bin/openanimator', '/home/user/animation.oanim'])).toBe(
      '/home/user/animation.oanim'
    )
  })

  it('finds a Windows-style path containing spaces', () => {
    expect(
      projectPathFromArgv([
        'C:\\Program Files\\OpenAnimator\\OpenAnimator.exe',
        'C:\\Users\\me\\My Animation.oanim'
      ])
    ).toBe('C:\\Users\\me\\My Animation.oanim')
  })

  it('matches the extension case-insensitively', () => {
    expect(projectPathFromArgv(['openanimator', 'Scene.OANIM'])).toBe('Scene.OANIM')
  })

  it('ignores flags and unrelated arguments', () => {
    expect(projectPathFromArgv(['openanimator', '--no-sandbox', '.'])).toBeNull()
    expect(projectPathFromArgv(['openanimator', 'notes.txt'])).toBeNull()
    expect(projectPathFromArgv(['openanimator', '-dashed.oanim'])).toBeNull()
  })

  it('never considers the executable path itself', () => {
    expect(projectPathFromArgv(['openanimator.oanim'])).toBeNull()
    expect(projectPathFromArgv([])).toBeNull()
  })

  it('keeps the last candidate when several are passed', () => {
    expect(projectPathFromArgv(['openanimator', 'first.oanim', 'second.oanim'])).toBe(
      'second.oanim'
    )
  })
})
