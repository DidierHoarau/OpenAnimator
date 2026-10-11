/**
 * Persisted, user-resizable panel sizes. The layout grid consumes three CSS
 * custom properties (--library-size, --properties-size, --timeline-size);
 * the splitter handles created by attachPanelSplitters update them during a
 * pointer drag and persist the values on release.
 */

export interface PanelSizes {
  library: number
  properties: number
  timeline: number
}

export type PanelKey = keyof PanelSizes

export const PANEL_LIMITS: Record<PanelKey, { min: number; max: number; fallback: number }> = {
  library: { min: 180, max: 480, fallback: 208 },
  properties: { min: 200, max: 520, fallback: 280 },
  timeline: { min: 120, max: 480, fallback: 196 }
}

export const DEFAULT_PANEL_SIZES: PanelSizes = {
  library: PANEL_LIMITS.library.fallback,
  properties: PANEL_LIMITS.properties.fallback,
  timeline: PANEL_LIMITS.timeline.fallback
}

const STORAGE_KEY = 'openanimator.panel-sizes'

type SizeStorage = Pick<Storage, 'getItem' | 'setItem'>

export function clampPanelSize(key: PanelKey, value: number): number {
  const limit = PANEL_LIMITS[key]
  if (!Number.isFinite(value)) return limit.fallback
  return Math.min(limit.max, Math.max(limit.min, Math.round(value)))
}

function sanitize(source: unknown): PanelSizes {
  const raw = (source ?? {}) as Partial<Record<PanelKey, unknown>>
  return {
    library: clampPanelSize('library', Number(raw.library)),
    properties: clampPanelSize('properties', Number(raw.properties)),
    timeline: clampPanelSize('timeline', Number(raw.timeline))
  }
}

export function loadPanelSizes(storage?: SizeStorage): PanelSizes {
  const store = storage ?? window.localStorage
  try {
    return sanitize(JSON.parse(store.getItem(STORAGE_KEY) ?? '{}'))
  } catch {
    return { ...DEFAULT_PANEL_SIZES }
  }
}

export function savePanelSizes(sizes: PanelSizes, storage?: SizeStorage): void {
  const store = storage ?? window.localStorage
  store.setItem(STORAGE_KEY, JSON.stringify(sanitize(sizes)))
}

export function applyPanelSizes(layout: HTMLElement, sizes: PanelSizes): void {
  layout.style.setProperty('--library-size', `${sizes.library}px`)
  layout.style.setProperty('--properties-size', `${sizes.properties}px`)
  layout.style.setProperty('--timeline-size', `${sizes.timeline}px`)
}

/**
 * Adds the three splitter handles to the layout grid and wires dragging:
 * horizontal resize for the library (left) and properties (right) columns,
 * vertical for the timeline height. Drag math uses the layout rect captured
 * at pointerdown; the sizes persist to storage on release.
 */
export function attachPanelSplitters(layout: HTMLElement, storage?: SizeStorage): void {
  const sizes = loadPanelSizes(storage)
  applyPanelSizes(layout, sizes)

  // Only one splitter may drag at a time: every handle shares the
  // window-level pointer listeners, so an unguarded move from a second
  // handle (or a stray event with default coordinates) would corrupt the
  // size of the panel being dragged.
  let active: { key: PanelKey; sizeFor: (event: PointerEvent, rect: DOMRect) => number } | null =
    null
  let rect: DOMRect | null = null

  const definitions: Array<{
    key: PanelKey
    className: string
    /** Named grid area of the layout template; without it the handles
     * auto-place into whatever cells remain and resize the wrong thing. */
    gridArea: string
    title: string
    sizeFor: (event: PointerEvent, rect: DOMRect) => number
  }> = [
    {
      key: 'library',
      className: 'split split-library',
      gridArea: 'split-l',
      title: 'Drag to resize the library panel',
      sizeFor: (event, rect) => event.clientX - rect.left
    },
    {
      key: 'properties',
      className: 'split split-properties',
      gridArea: 'split-r',
      title: 'Drag to resize the properties panel',
      sizeFor: (event, rect) => rect.right - event.clientX
    },
    {
      key: 'timeline',
      className: 'split split-timeline',
      gridArea: 'split-b',
      title: 'Drag to resize the timeline height',
      sizeFor: (event, rect) => rect.bottom - event.clientY
    }
  ]

  for (const definition of definitions) {
    const handle = document.createElement('div')
    handle.className = definition.className
    handle.style.gridArea = definition.gridArea
    handle.title = definition.title
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      active = definition
      rect = layout.getBoundingClientRect()
      for (const other of layout.querySelectorAll('.split.dragging')) {
        other.classList.remove('dragging')
      }
      handle.classList.add('dragging')
    })
    layout.appendChild(handle)
  }

  const onMove = (event: PointerEvent): void => {
    if (!active || !rect) return
    sizes[active.key] = clampPanelSize(active.key, active.sizeFor(event, rect))
    applyPanelSizes(layout, sizes)
  }
  const onRelease = (): void => {
    if (!active) return
    active = null
    rect = null
    for (const other of layout.querySelectorAll('.split.dragging')) {
      other.classList.remove('dragging')
    }
    savePanelSizes(sizes, storage)
  }
  // Window-level listeners route the drag even when the pointer leaves the
  // thin handle, without needing pointer capture.
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onRelease)
  window.addEventListener('pointercancel', onRelease)
}
