import { describe, expect, it } from 'vitest'

import { isNewerVersion, latestVersionFromRelease, releasePageUrl } from './updates'

describe('latestVersionFromRelease', () => {
  it('extracts the version from a v-prefixed release tag', () => {
    expect(latestVersionFromRelease({ tag_name: 'v0.19.0' })).toBe('0.19.0')
  })

  it('accepts a bare semver tag', () => {
    expect(latestVersionFromRelease({ tag_name: '1.2.3' })).toBe('1.2.3')
  })

  it('ignores prerelease and malformed tags', () => {
    expect(latestVersionFromRelease({ tag_name: 'v0.19.0-beta.1' })).toBeNull()
    expect(latestVersionFromRelease({ tag_name: 'v1.2' })).toBeNull()
    expect(latestVersionFromRelease({ tag_name: 'latest' })).toBeNull()
    expect(latestVersionFromRelease({ tag_name: '' })).toBeNull()
  })

  it('rejects payloads without a string tag_name', () => {
    expect(latestVersionFromRelease({})).toBeNull()
    expect(latestVersionFromRelease({ tag_name: 3 })).toBeNull()
    expect(latestVersionFromRelease(null)).toBeNull()
    expect(latestVersionFromRelease('v1.0.0')).toBeNull()
    expect(latestVersionFromRelease([{ tag_name: 'v1.0.0' }])).toBeNull()
  })
})

describe('isNewerVersion', () => {
  it('is true only for strictly newer versions', () => {
    expect(isNewerVersion('0.18.0', '0.19.0')).toBe(true)
    expect(isNewerVersion('0.18.0', '1.0.0')).toBe(true)
    expect(isNewerVersion('0.19.0', '0.18.9')).toBe(false)
    expect(isNewerVersion('0.19.0', '0.19.0')).toBe(false)
  })
})

describe('releasePageUrl', () => {
  it('points at the canonical GitHub release page', () => {
    expect(releasePageUrl('0.19.0')).toBe(
      'https://github.com/DidierHoarau/OpenAnimator/releases/tag/v0.19.0'
    )
  })
})
