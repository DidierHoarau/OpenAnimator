import type { UpdateAvailableInfo } from '@shared/api'

import { el } from './dom'

/**
 * Dismissible banner announcing a newer release. Updates are never downloaded
 * automatically (unsigned builds cannot self-install safely), so the banner
 * links to the release page instead.
 */
export function showUpdateBanner(info: UpdateAvailableInfo): void {
  const banner = el('div', 'update-banner')
  const text = el('span', 'update-banner-text', `OpenAnimator v${info.version} is available`)
  const notes = el('button', undefined, 'Release notes')
  notes.addEventListener('click', () => void window.api.openReleasePage(info.version))
  const dismiss = el('button', 'update-banner-dismiss', '×')
  dismiss.title = 'Dismiss'
  dismiss.addEventListener('click', () => banner.remove())
  banner.append(text, notes, dismiss)
  document.body.appendChild(banner)
}
