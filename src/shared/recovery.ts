/** Metadata of an autosave recovery snapshot, stored next to the snapshot. */
export interface RecoveryInfo {
  /** Path of the project file the snapshot belongs to, or the session key
   * (`untitled/<id>`) for a never-saved document. */
  path: string
  /** Project name shown in the recovery dialog. */
  name: string
  /** Snapshot write time (epoch ms). */
  savedAt: number
  /** True for snapshots of never-saved (untitled) documents; absent on
   * snapshots written by older versions. */
  untitled?: boolean
}

/** Defensive parse of a stored snapshot info (invalid entries are ignored). */
export function isRecoverySnapshotInfo(value: unknown): value is RecoveryInfo {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RecoveryInfo>
  return (
    typeof candidate.path === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.savedAt === 'number' &&
    (candidate.untitled === undefined || typeof candidate.untitled === 'boolean')
  )
}

/**
 * The recovery dialog is offered only when the autosave snapshot is newer than
 * the last write of the project file itself (i.e. there are autosaved changes
 * the file on disk does not contain).
 */
export function shouldOfferRecovery(snapshotSavedAt: number, projectModifiedAt: number): boolean {
  return snapshotSavedAt > projectModifiedAt
}
