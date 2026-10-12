// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { showUpdateBanner } from './updateBanner'

describe('showUpdateBanner', () => {
  let previous: typeof window.api

  beforeEach(() => {
    previous = window.api
  })

  afterEach(() => {
    window.api = previous
    document.body.innerHTML = ''
  })

  function stubApi(): { openReleasePage: ReturnType<typeof vi.fn> } {
    const openReleasePage = vi.fn(async () => undefined)
    window.api = { openReleasePage } as unknown as typeof window.api
    return { openReleasePage }
  }

  it('renders the available version and opens the release page from the notes button', () => {
    const { openReleasePage } = stubApi()
    showUpdateBanner({ version: '0.19.0' })

    const banner = document.querySelector<HTMLElement>('.update-banner')
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toContain('OpenAnimator v0.19.0 is available')

    const notes = [...banner!.querySelectorAll('button')].find(
      (button) => button.textContent === 'Release notes'
    )!
    notes.click()
    expect(openReleasePage).toHaveBeenCalledWith('0.19.0')
  })

  it('dismisses the banner through its close button', () => {
    stubApi()
    showUpdateBanner({ version: '1.0.0' })
    document.querySelector<HTMLElement>('.update-banner-dismiss')!.click()
    expect(document.querySelector('.update-banner')).toBeNull()
  })
})
