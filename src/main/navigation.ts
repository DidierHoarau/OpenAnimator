/** Hosts the application is allowed to open in the system browser. */
const EXTERNAL_URL_HOSTS = new Set(['github.com', 'didierhoarau.github.io'])

/** True when `value` is an https URL on an allowlisted external host. */
export function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && EXTERNAL_URL_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/**
 * True when an in-app navigation may proceed: production renders a single
 * `file:` document (all `file:` URLs share the `null` origin, so the pathname
 * must match exactly), development navigates within the dev-server origin.
 * Anything else — another local file, a remote page, a malformed URL — is
 * denied.
 */
export function isAllowedNavigationTarget(value: string, currentUrl: string): boolean {
  let target: URL
  let current: URL
  try {
    target = new URL(value)
    current = new URL(currentUrl)
  } catch {
    return false
  }
  if (current.protocol === 'file:') {
    return target.protocol === 'file:' && target.pathname === current.pathname
  }
  if (current.protocol === 'http:' || current.protocol === 'https:') {
    return target.origin === current.origin
  }
  return false
}
