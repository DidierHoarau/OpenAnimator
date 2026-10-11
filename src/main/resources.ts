import { createHash } from 'node:crypto'

import type { AnimatorDocument } from '../shared/model'
import { collectResourceCounts } from '../shared/resources'
import type { ProjectResourceMap } from './projectContainer'

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Extension of a file name, lowercased without the dot ('' when none). */
export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1) : ''
  return ext.toLowerCase()
}

/**
 * Content-addressed in-memory resource store for the current editing session,
 * owned by the main process (fs/hashing are main concerns). Every raster is
 * keyed by its SHA-256 hex digest, so identical content dedupes
 * automatically. Undo/redo never touches the store; the document references
 * resources by id only.
 */
export class ResourceStore {
  private readonly entries: ProjectResourceMap = new Map()

  /**
   * Stores the bytes under their content digest. Returns the resource id and
   * whether the content was already present (dedupe).
   */
  add(bytes: Uint8Array, ext: string): { resourceId: string; deduped: boolean } {
    const resourceId = sha256Hex(bytes)
    const deduped = this.entries.has(resourceId)
    if (!deduped) this.entries.set(resourceId, { bytes, ext: ext || 'bin' })
    return { resourceId, deduped }
  }

  /** Every stored resource, for the project writer. */
  all(): ProjectResourceMap {
    return this.entries
  }

  /**
   * Removes every resource the document does not reference (explicit
   * purge-unused — there is no silent garbage collection). Returns how many
   * entries were removed.
   */
  purgeUnused(document: AnimatorDocument): number {
    const referenced = collectResourceCounts(document)
    let removed = 0
    for (const resourceId of this.entries.keys()) {
      if (!referenced.has(resourceId)) {
        this.entries.delete(resourceId)
        removed += 1
      }
    }
    return removed
  }

  /** Replaces the store contents — used when a project file is opened. */
  reset(resources: ProjectResourceMap): void {
    this.entries.clear()
    for (const [resourceId, resource] of resources) this.entries.set(resourceId, resource)
  }
}

/** Session store singleton used by the IPC handlers. */
export const resourceStore = new ResourceStore()
