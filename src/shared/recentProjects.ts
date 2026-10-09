import type { RecentProject } from './api'

/**
 * Merges a project into the recent list: upserts by path (moving it to the
 * front with the given name and time), sorts by recency and caps the list.
 */
export function mergeRecentProject(
  existing: RecentProject[],
  path: string,
  name: string,
  now: number,
  limit = 10
): RecentProject[] {
  const updated: RecentProject = { path, name, lastOpenedAt: now }
  const others = existing.filter((entry) => entry.path !== path)
  return [updated, ...others]
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, Math.max(1, limit))
}
