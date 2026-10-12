import { el } from './dom'
import { createModal } from './modal'

/**
 * About dialog: application and runtime versions plus links to the
 * documentation and the GitHub repository. Links go through the main-process
 * external-URL handler, which enforces the host allowlist (https GitHub and
 * docs-site URLs only).
 */

export const DOCS_URL = 'https://didierhoarau.github.io/OpenAnimator/'
const GITHUB_URL = 'https://github.com/DidierHoarau/OpenAnimator'

export function showAboutDialog(): void {
  const handle = createModal({ modalClass: 'about-modal' })

  const header = el('div', 'modal-header')
  const closeButton = el('button', 'modal-close', '×')
  closeButton.title = 'Close'
  closeButton.addEventListener('click', () => handle.close())
  header.append(el('h2', 'modal-title', 'About OpenAnimator'), closeButton)

  const body = el('div', 'about-body')
  const versionLine = el('p', 'about-versions', 'Loading versions…')
  const tagline = el(
    'p',
    'modal-subtitle',
    'A desktop animator: vector drawing, object animation, audio and export to GIF, video or image sequences.'
  )
  const linkRow = el('div', 'modal-actions')
  const status = el('p', 'about-status')

  const link = (label: string, url: string): HTMLButtonElement => {
    const button = el('button', undefined, label)
    button.addEventListener('click', () => {
      status.textContent = ''
      void window.api.openExternal(url).then((result) => {
        if (!result.ok) status.textContent = `Could not open the link: ${result.error}`
      })
    })
    return button
  }
  linkRow.append(link('Open documentation', DOCS_URL), link('GitHub repository', GITHUB_URL))

  body.append(tagline, versionLine, linkRow, status)
  handle.modal.append(header, body)

  void window.api
    .versions()
    .then((versions) => {
      versionLine.textContent = `OpenAnimator v${versions.app} · Electron ${versions.electron} · Chromium ${versions.chrome} · Node ${versions.node}`
    })
    .catch(() => {
      versionLine.textContent = 'Version information unavailable'
    })
}
