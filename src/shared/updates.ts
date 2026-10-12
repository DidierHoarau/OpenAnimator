import { gt } from 'semver'

/** GitHub repository the update feed and release pages point at. */
export const UPDATE_REPO = 'DidierHoarau/OpenAnimator'

const RELEASE_TAG_PATTERN = /^v?(\d+\.\d+\.\d+)$/

/**
 * Extracts the `x.y.z` version from a GitHub Releases API payload, or null
 * when the payload has no plain semver `tag_name` (prereleases and malformed
 * responses are ignored — only exact release tags drive update notices).
 */
export function latestVersionFromRelease(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null
  const tag = (json as { tag_name?: unknown }).tag_name
  if (typeof tag !== 'string') return null
  const match = RELEASE_TAG_PATTERN.exec(tag)
  return match ? match[1] : null
}

/** True when `latest` is strictly newer than `current` (semantic versioning). */
export function isNewerVersion(current: string, latest: string): boolean {
  return gt(latest, current)
}

/** Canonical GitHub release page of a version, used for the "release notes"
 * link of the update notification (no download is ever started from it). */
export function releasePageUrl(version: string): string {
  return `https://github.com/${UPDATE_REPO}/releases/tag/v${version}`
}
