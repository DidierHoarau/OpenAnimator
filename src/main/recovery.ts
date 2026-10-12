import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app, ipcMain } from 'electron'

import {
  RECOVERY_CHECK_CHANNEL,
  RECOVERY_CLEAR_CHANNEL,
  RECOVERY_READ_CHANNEL,
  RECOVERY_WRITE_CHANNEL
} from '../shared/api'
import type { ReadResult, SaveToResult } from '../shared/api'
import type { AnimatorDocument } from '../shared/model'
import { isRecoverySnapshotInfo, shouldOfferRecovery } from '../shared/recovery'
import type { RecoveryInfo } from '../shared/recovery'
import type { ProjectResourceMap } from './projectContainer'
import { packProject, parseProject } from './projectContainer'
import { resourceStore } from './resources'

/** One recovery slot per project path, keyed by the hash of the path. */
function slotId(path: string): string {
  return createHash('sha256').update(path).digest('hex')
}

/**
 * Autosave recovery snapshots under the application's user-data directory:
 * one `.oanim` container plus one info JSON per project path. Snapshots never
 * replace the project file — they are only offered for recovery when they are
 * newer than the last manual save.
 */
export class RecoveryStore {
  private readonly baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  private snapshotPath(path: string): string {
    return join(this.baseDir, `${slotId(path)}.oanim`)
  }

  private infoPath(path: string): string {
    return join(this.baseDir, `${slotId(path)}.json`)
  }

  /** Writes the snapshot and its info atomically (temp file + rename). */
  async write(
    path: string,
    document: AnimatorDocument,
    resources: ProjectResourceMap,
    savedAt: number
  ): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    const snapshot = this.snapshotPath(path)
    await writeFile(`${snapshot}.tmp`, packProject(document, resources))
    await rename(`${snapshot}.tmp`, snapshot)
    const info: RecoveryInfo = { path, name: document.name, savedAt }
    const infoPath = this.infoPath(path)
    await writeFile(`${infoPath}.tmp`, JSON.stringify(info, null, 2), 'utf8')
    await rename(`${infoPath}.tmp`, infoPath)
  }

  /** Stored snapshot info, or null when absent or corrupt. */
  async info(path: string): Promise<RecoveryInfo | null> {
    try {
      const raw = await readFile(this.infoPath(path), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      return isRecoverySnapshotInfo(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  /** Snapshot document and resources; throws when missing or corrupt. */
  async read(path: string): Promise<{ document: AnimatorDocument; resources: ProjectResourceMap }> {
    const bytes = await readFile(this.snapshotPath(path))
    return parseProject(new Uint8Array(bytes))
  }

  /** Deletes the snapshot and its info (best-effort). */
  async clear(path: string): Promise<void> {
    await Promise.all(
      [this.snapshotPath(path), this.infoPath(path)].map((file) =>
        unlink(file).catch(() => undefined)
      )
    )
  }

  /** Snapshot info when the snapshot is newer than the project file itself
   * and both exist; null otherwise. */
  async pending(path: string): Promise<RecoveryInfo | null> {
    const info = await this.info(path)
    if (!info) return null
    try {
      const stats = await stat(path)
      return shouldOfferRecovery(info.savedAt, stats.mtimeMs) ? info : null
    } catch {
      return null
    }
  }
}

function resourcesToRecord(resources: ProjectResourceMap): Record<string, Uint8Array> {
  const record: Record<string, Uint8Array> = {}
  for (const [resourceId, resource] of resources) record[resourceId] = resource.bytes
  return record
}

/** Registers the IPC handlers for autosave recovery snapshots, stored under
 * the application's user-data directory. */
export function registerRecoveryHandlers(): void {
  const store = new RecoveryStore(join(app.getPath('userData'), 'recovery'))
  ipcMain.handle(
    RECOVERY_WRITE_CHANNEL,
    async (_event, path: string, document: AnimatorDocument): Promise<SaveToResult> => {
      try {
        await store.write(path, document, resourceStore.all(), Date.now())
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: message }
      }
    }
  )
  ipcMain.handle(
    RECOVERY_CHECK_CHANNEL,
    (_event, path: string): Promise<RecoveryInfo | null> => store.pending(path)
  )
  ipcMain.handle(RECOVERY_READ_CHANNEL, async (_event, path: string): Promise<ReadResult> => {
    try {
      const { document, resources } = await store.read(path)
      // The snapshot carries every resource the session store held at write
      // time; resetting keeps a later explicit save from dropping recovered
      // (or newly imported) resources.
      resourceStore.reset(resources)
      return { ok: true, document, resources: resourcesToRecord(resources) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  })
  ipcMain.handle(RECOVERY_CLEAR_CHANNEL, (_event, path: string): Promise<void> => store.clear(path))
}
