/** Identifiers of the right-panel sections. */
export type SectionId = 'explorer' | 'layer' | 'playback' | 'shape'

/** Expanded/collapsed state of every panel section. */
export type SectionState = Record<SectionId, boolean>

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const SECTION_STORAGE_KEY = 'openanimator.panelSections'

export const DEFAULT_SECTION_STATE: SectionState = {
  explorer: true,
  layer: true,
  playback: true,
  shape: true
}

const SECTION_IDS = Object.keys(DEFAULT_SECTION_STATE) as SectionId[]

/** Reads the persisted section state, falling back to all-expanded for
 * missing, corrupted or partially invalid data. */
export function loadSectionState(storage: StorageLike): SectionState {
  const state: SectionState = { ...DEFAULT_SECTION_STATE }
  try {
    const raw = storage.getItem(SECTION_STORAGE_KEY)
    if (!raw) return state
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return state
    const record = parsed as Record<string, unknown>
    for (const id of SECTION_IDS) {
      if (typeof record[id] === 'boolean') state[id] = record[id]
    }
    return state
  } catch {
    return state
  }
}

/** Persists the section state; storage failures are ignored (the app works
 * without persistence, e.g. when localStorage is unavailable). */
export function saveSectionState(storage: StorageLike, state: SectionState): void {
  try {
    storage.setItem(SECTION_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Persistence is best-effort.
  }
}
