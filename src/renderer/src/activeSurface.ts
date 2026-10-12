/**
 * Which editing surface was interacted with last ('stage' or 'timeline').
 * The Ctrl+C/Ctrl+V dispatcher uses it to pick the right clipboard: the
 * timeline's keyframe clipboard or the scene-node clipboard. Ctrl+X and
 * Ctrl+D are surface-independent (scene nodes only).
 */

export type ActiveSurface = 'stage' | 'timeline'

let activeSurface: ActiveSurface = 'stage'

export function setActiveSurface(surface: ActiveSurface): void {
  activeSurface = surface
}

export function getActiveSurface(): ActiveSurface {
  return activeSurface
}
