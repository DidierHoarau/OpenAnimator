// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import {
  attachPanelSplitters,
  clampPanelSize,
  DEFAULT_PANEL_SIZES,
  loadPanelSizes,
  PANEL_LIMITS,
  savePanelSizes,
  type PanelSizes
} from './panelLayout'

const STORAGE_KEY = 'openanimator.panel-sizes'

function fakeStorage(initial: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size
    }
  } as Storage & { data: Map<string, string> }
}

describe('panel layout sizes', () => {
  it('clamps sizes to the per-panel range and rounds them', () => {
    expect(clampPanelSize('library', 100)).toBe(PANEL_LIMITS.library.min)
    expect(clampPanelSize('properties', 9999)).toBe(PANEL_LIMITS.properties.max)
    expect(clampPanelSize('timeline', 260.4)).toBe(260)
    expect(clampPanelSize('timeline', Number.NaN)).toBe(PANEL_LIMITS.timeline.fallback)
  })

  it('loads defaults when nothing valid is stored', () => {
    expect(loadPanelSizes(fakeStorage())).toEqual(DEFAULT_PANEL_SIZES)
    expect(loadPanelSizes(fakeStorage({ [STORAGE_KEY]: '{not json' }))).toEqual(
      DEFAULT_PANEL_SIZES
    )
  })

  it('sanitizes stored values and round-trips through save', () => {
    const storage = fakeStorage({
      [STORAGE_KEY]: JSON.stringify({ library: 12, properties: 'x', timeline: 300 })
    })
    expect(loadPanelSizes(storage)).toEqual({
      // Out-of-range numbers clamp into the panel's range.
      library: PANEL_LIMITS.library.min,
      // Non-numeric garbage falls back to the default.
      properties: PANEL_LIMITS.properties.fallback,
      timeline: 300
    })
    const sizes: PanelSizes = { library: 240, properties: 340, timeline: 160 }
    savePanelSizes(sizes, storage)
    expect(JSON.parse(storage.data.get(STORAGE_KEY)!)).toEqual(sizes)
    expect(loadPanelSizes(storage)).toEqual(sizes)
  })
})

describe('panel splitters', () => {
  it('attaches three handles and applies the stored sizes as CSS variables', () => {
    document.body.textContent = ''
    const layout = document.createElement('div')
    document.body.appendChild(layout)
    const storage = fakeStorage({
      [STORAGE_KEY]: JSON.stringify({ library: 300, properties: 360, timeline: 250 })
    })

    attachPanelSplitters(layout, storage)

    expect(layout.querySelector('.split-library')).not.toBeNull()
    expect(layout.querySelector('.split-properties')).not.toBeNull()
    expect(layout.querySelector('.split-timeline')).not.toBeNull()
    expect(layout.style.getPropertyValue('--library-size')).toBe('300px')
    expect(layout.style.getPropertyValue('--properties-size')).toBe('360px')
    expect(layout.style.getPropertyValue('--timeline-size')).toBe('250px')
  })

  it('resizes during the drag and persists on release', () => {
    document.body.textContent = ''
    const layout = document.createElement('div')
    document.body.appendChild(layout)
    const storage = fakeStorage()
    attachPanelSplitters(layout, storage)
    layout.getBoundingClientRect = () => ({ left: 0, right: 1000, bottom: 500 }) as DOMRect

    const library = layout.querySelector<HTMLElement>('.split-library')!
    library.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 320 }))
    expect(layout.style.getPropertyValue('--library-size')).toBe('320px')
    window.dispatchEvent(new MouseEvent('pointerup'))
    expect(JSON.parse(storage.data.get(STORAGE_KEY)!).library).toBe(320)

    const properties = layout.querySelector<HTMLElement>('.split-properties')!
    properties.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 1000 - 260 }))
    expect(layout.style.getPropertyValue('--properties-size')).toBe('260px')

    const timeline = layout.querySelector<HTMLElement>('.split-timeline')!
    timeline.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: 500 - 200 }))
    expect(layout.style.getPropertyValue('--timeline-size')).toBe('200px')

    // A drag past the limit clamps instead of escaping it.
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: 500 - 20 }))
    expect(layout.style.getPropertyValue('--timeline-size')).toBe(`${PANEL_LIMITS.timeline.min}px`)
    window.dispatchEvent(new MouseEvent('pointerup'))
    const saved = JSON.parse(storage.data.get(STORAGE_KEY)!)
    expect(saved.properties).toBe(260)
    expect(saved.timeline).toBe(PANEL_LIMITS.timeline.min)
  })

  it('ignores stray move events while no drag is active', () => {
    document.body.textContent = ''
    const layout = document.createElement('div')
    document.body.appendChild(layout)
    attachPanelSplitters(layout, fakeStorage())
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 9000 }))
    expect(layout.style.getPropertyValue('--library-size')).toBe(
      `${DEFAULT_PANEL_SIZES.library}px`
    )
  })
})
