import { describe, expect, it } from 'vitest'

import { mergeRecentProject } from './recentProjects'
import type { RecentProject } from './api'

function entry(path: string, name: string, lastOpenedAt: number): RecentProject {
  return { path, name, lastOpenedAt }
}

describe('mergeRecentProject', () => {
  it('adds a new entry at the front', () => {
    const existing = [entry('/a.oanim', 'a', 100), entry('/b.oanim', 'b', 200)]
    const merged = mergeRecentProject(existing, '/c.oanim', 'c', 300)
    expect(merged.map((project) => project.path)).toEqual(['/c.oanim', '/b.oanim', '/a.oanim'])
  })

  it('moves an existing entry to the front and updates its name and time', () => {
    const existing = [entry('/a.oanim', 'old name', 100), entry('/b.oanim', 'b', 200)]
    const merged = mergeRecentProject(existing, '/a.oanim', 'new name', 300)
    expect(merged).toEqual([
      entry('/a.oanim', 'new name', 300),
      entry('/b.oanim', 'b', 200)
    ])
  })

  it('dedupes by path even when several stale entries exist', () => {
    const existing = [entry('/a.oanim', 'a', 100), entry('/a.oanim', 'a again', 50)]
    const merged = mergeRecentProject(existing, '/a.oanim', 'final', 300)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toEqual(entry('/a.oanim', 'final', 300))
  })

  it('caps the list at the limit', () => {
    const existing = Array.from({ length: 12 }, (_, i) => entry(`/p${i}.oanim`, `p${i}`, i))
    const merged = mergeRecentProject(existing, '/new.oanim', 'new', 999)
    expect(merged).toHaveLength(10)
    expect(merged[0].path).toBe('/new.oanim')
    // Newest entries survive the cap.
    expect(merged.map((project) => project.path)).toContain('/p11.oanim')
    expect(merged.map((project) => project.path)).not.toContain('/p0.oanim')
  })

  it('keeps untouched entries and their relative order', () => {
    const existing = [entry('/a.oanim', 'a', 300), entry('/b.oanim', 'b', 200), entry('/c.oanim', 'c', 100)]
    const merged = mergeRecentProject(existing, '/z.oanim', 'z', 50)
    expect(merged.map((project) => project.path)).toEqual(['/a.oanim', '/b.oanim', '/c.oanim', '/z.oanim'])
    expect(merged[0]).toBe(existing[0])
  })
})
