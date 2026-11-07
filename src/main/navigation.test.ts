import { describe, expect, it } from 'vitest'

import { isAllowedExternalUrl, isAllowedNavigationTarget } from './navigation'

describe('isAllowedExternalUrl', () => {
  it('allows https links on the allowlisted hosts', () => {
    expect(isAllowedExternalUrl('https://github.com/DidierHoarau/OpenAnimator')).toBe(true)
    expect(isAllowedExternalUrl('https://didierhoarau.github.io/docs')).toBe(true)
  })

  it('rejects other protocols, hosts and malformed URLs', () => {
    expect(isAllowedExternalUrl('http://github.com/x')).toBe(false)
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('https://github.com.evil.example/x')).toBe(false)
    expect(isAllowedExternalUrl('https://evil.example/github.com')).toBe(false)
    expect(isAllowedExternalUrl('https://user:pass@github.com/x')).toBe(true)
    expect(isAllowedExternalUrl('not a url')).toBe(false)
    expect(isAllowedExternalUrl('')).toBe(false)
  })
})

describe('isAllowedNavigationTarget', () => {
  const appFile = 'file:///opt/OpenAnimator/resources/app.asar/out/renderer/index.html'

  it('allows only the exact current file: document in production', () => {
    expect(isAllowedNavigationTarget(appFile, appFile)).toBe(true)
    expect(
      isAllowedNavigationTarget('file:///opt/OpenAnimator/other.html', appFile)
    ).toBe(false)
    expect(isAllowedNavigationTarget('file:///etc/passwd', appFile)).toBe(false)
    expect(isAllowedNavigationTarget('https://github.com/x', appFile)).toBe(false)
  })

  it('allows only the dev-server origin in development', () => {
    const current = 'http://localhost:5173/'
    expect(isAllowedNavigationTarget('http://localhost:5173/index.html', current)).toBe(true)
    expect(isAllowedNavigationTarget('http://localhost:5173/#/settings', current)).toBe(true)
    expect(isAllowedNavigationTarget('http://localhost:5174/', current)).toBe(false)
    expect(isAllowedNavigationTarget('https://evil.example/', current)).toBe(false)
    expect(isAllowedNavigationTarget('file:///etc/passwd', current)).toBe(false)
  })

  it('rejects malformed targets and current URLs', () => {
    expect(isAllowedNavigationTarget('not a url', appFile)).toBe(false)
    expect(isAllowedNavigationTarget(appFile, 'not a url')).toBe(false)
  })
})
