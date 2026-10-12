import { DEFAULT_PREFERENCES } from '@shared/preferences'
import type { AppPreferences } from '@shared/preferences'

/**
 * Renderer-side preferences store: one in-memory copy of the persisted
 * preferences, loaded once at startup. Updates are written through to the
 * main-process store (which re-sanitizes and returns the accepted values)
 * before the in-memory copy and the change listeners are updated.
 */

let preferences: AppPreferences = { ...DEFAULT_PREFERENCES }

const listeners = new Set<(preferences: AppPreferences) => void>()

export function getPreferences(): AppPreferences {
  return preferences
}

/** Loads the persisted preferences (defaults survive a missing store). */
export async function initPreferences(): Promise<AppPreferences> {
  try {
    preferences = await window.api.getPreferences()
  } catch (error) {
    console.warn('OpenAnimator: failed to load preferences, using defaults', error)
    preferences = { ...DEFAULT_PREFERENCES }
  }
  return preferences
}

/**
 * Merges `patch` into the current preferences, persists the full result and
 * notifies the listeners with the sanitized values the store returned.
 */
export async function updatePreferences(
  patch: Partial<AppPreferences>
): Promise<AppPreferences> {
  const merged = { ...preferences, ...patch }
  try {
    preferences = await window.api.savePreferences(merged)
  } catch (error) {
    console.warn('OpenAnimator: failed to persist preferences', error)
    preferences = merged
  }
  for (const listener of [...listeners]) listener(preferences)
  return preferences
}

/** Subscribes to preference changes; returns the unsubscribe function. */
export function onPreferencesChanged(listener: (preferences: AppPreferences) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
