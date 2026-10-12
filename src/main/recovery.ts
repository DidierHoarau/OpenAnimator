import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app, ipcMain } from 'electron'

import {
  RECOVERY_CHECK_CHANNEL,
  RECOVERY_CLEAR_CHANNEL,
  RECOVERY_LIST_UNSAVED_CHANNEL,
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

/** Untitled (never-saved) snapshots kept before the oldest is pruned. */
const UNTITLED_SLOT_CAP = 3

/** One recovery slot per project path, keyed by the hash of the path. */
function slotId(path: string): string {
  return createHash('sha256').update(path).digest('hex')
}

/**
 * Autosave recovery snapshots under the application's user-data directory:
 * one `.oanim` container plus one info JSON per project path. Snapshots never
 * replace the project file — they are only offered for recovery when they are
 * newer than the last manual save. Never-saved documents get the same pairing
 * under a session key, with a bounded number of slots.
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
    savedAt: number,
    untitled = false
  ): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    const snapshot = this.snapshotPath(path)
    await writeFile(`${snapshot}.tmp`, packProject(document, resources))
    await rename(`${snapshot}.tmp`, snapshot)
    const info: RecoveryInfo = { path, name: document.name, savedAt, untitled }
    const infoPath = this.infoPath(path)
    await writeFile(`${infoPath}.tmp`, JSON.stringify(info, null, 2), 'utf8')
    await rename(`${infoPath}.tmp`, infoPath)
    if (untitled) await this.pruneUntitled()
  }

  /** Deletes the oldest untitled slots beyond the cap; file-backed slots are
   * never touched. */
  private async pruneUntitled(): Promise<void> {
    const unsaved = await this.listUnsaved()
    await Promise.all(unsaved.slice(UNTITLED_SLOT_CAP).map((info) => this.clear(info.path)))
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
   * and both exist; null otherwise. Untitled snapshots have no file to
   * compare against and are pending by definition. */
  async pending(path: string): Promise<RecoveryInfo | null> {
    const info = await this.info(path)
    if (!info) return null
    if (info.untitled) return info
    try {
      const stats = await stat(path)
      return shouldOfferRecovery(info.savedAt, stats.mtimeMs) ? info : null
    } catch {
      return null
    }
  }

  /** Untitled-document snapshots, newest first. */
  async listUnsaved(): Promise<RecoveryInfo[]> {
    let files: string[]
    try {
      files = await readdir(this.baseDir)
    } catch {
      return []
    }
    const infos = await Promise.all(
      files
        .filter((file) => file.endsWith('.json'))
        .map(async (file) => {
          try {
            const raw = await readFile(join(this.baseDir, file), 'utf8')
            const parsed: unknown = JSON.parse(raw)
            return isRecoverySnapshotInfo(parsed) && parsed.untitled ? parsed : null
          } catch {
            return null
          }
        })
    )
    return infos
      .filter((info): info is RecoveryInfo => info !== null)
      .sort((a, b) => b.savedAt - a.savedAt)
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
    async (
      _event,
      path: string,
      document: AnimatorDocument,
      untitled = false
    ): Promise<SaveToResult> => {
      try {
        await store.write(path, document, resourceStore.all(), Date.now(), untitled)
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
  ipcMain.handle(
    RECOVERY_LIST_UNSAVED_CHANNEL,
    (): Promise<RecoveryInfo[]> => store.listUnsaved()
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
