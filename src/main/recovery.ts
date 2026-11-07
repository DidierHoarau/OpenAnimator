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
import { collectResourceCounts, isContentAddressedResourceId } from '../shared/resources'
import type { ProjectResourceMap } from './projectContainer'
import {
  packProjectIncremental,
  parseProject,
  ProjectPackCache,
  sanitizedExtension
} from './projectContainer'
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
  /** Content-addressed resource files shared by every snapshot (one file per
   * resource id); snapshots themselves carry only `document.json`. */
  private readonly resourcesDir: string
  /** Session pack cache handed to the incremental packer (snapshots carry no
   * embedded resources; the directory holds them). */
  private readonly packCache = new ProjectPackCache()

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.resourcesDir = join(baseDir, 'resources')
  }

  private snapshotPath(path: string): string {
    return join(this.baseDir, `${slotId(path)}.oanim`)
  }

  private infoPath(path: string): string {
    return join(this.baseDir, `${slotId(path)}.json`)
  }

  /** Writes the snapshot and its info atomically (temp file + rename).
   * Referenced resources go to the shared content-addressed directory first,
   * so a crash can never leave a snapshot pointing at missing files. */
  async write(
    path: string,
    document: AnimatorDocument,
    resources: ProjectResourceMap,
    savedAt: number,
    untitled = false
  ): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    await mkdir(this.resourcesDir, { recursive: true })
    const existing = await this.resourceFileById()
    for (const resourceId of collectResourceCounts(document).keys()) {
      // Content-addressed: an id already on disk holds these exact bytes.
      if (!isContentAddressedResourceId(resourceId) || existing.has(resourceId)) continue
      const resource = resources.get(resourceId)
      if (!resource) continue
      const filename = `${resourceId}.${sanitizedExtension(resource.ext)}`
      const target = join(this.resourcesDir, filename)
      await writeFile(`${target}.tmp`, resource.bytes)
      await rename(`${target}.tmp`, target)
      existing.set(resourceId, filename)
    }
    const snapshot = this.snapshotPath(path)
    // Resources live beside the snapshot now: the container is document-only.
    const packed = packProjectIncremental(document, new Map(), this.packCache)
    await writeFile(`${snapshot}.tmp`, packed.bytes)
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

  /** Snapshot document and resources; throws when missing or corrupt.
   * Resources live in the content-addressed directory; snapshots written by
   * older versions still embed theirs, and the embedded copy wins. */
  async read(path: string): Promise<{ document: AnimatorDocument; resources: ProjectResourceMap }> {
    const bytes = await readFile(this.snapshotPath(path))
    const parsed = parseProject(new Uint8Array(bytes))
    const merged: ProjectResourceMap = new Map(parsed.resources)
    const onDisk = await this.resourceFileById()
    for (const resourceId of collectResourceCounts(parsed.document).keys()) {
      if (merged.has(resourceId) || !isContentAddressedResourceId(resourceId)) continue
      const filename = onDisk.get(resourceId)
      if (!filename) continue
      const ext = filename.slice(resourceId.length + 1)
      merged.set(resourceId, {
        bytes: new Uint8Array(await readFile(join(this.resourcesDir, filename))),
        ext
      })
    }
    return { document: parsed.document, resources: merged }
  }

  /** Deletes the snapshot and its info (best-effort), then prunes resource
   * files no remaining snapshot references. */
  async clear(path: string): Promise<void> {
    await Promise.all(
      [this.snapshotPath(path), this.infoPath(path)].map((file) =>
        unlink(file).catch(() => undefined)
      )
    )
    await this.pruneResources()
  }

  /** Id → filename of every content-addressed resource on disk. */
  private async resourceFileById(): Promise<Map<string, string>> {
    const byId = new Map<string, string>()
    let files: string[]
    try {
      files = await readdir(this.resourcesDir)
    } catch {
      return byId
    }
    for (const file of files) {
      const dot = file.lastIndexOf('.')
      if (dot <= 0) continue
      const resourceId = file.slice(0, dot)
      if (isContentAddressedResourceId(resourceId) && !byId.has(resourceId)) {
        byId.set(resourceId, file)
      }
    }
    return byId
  }

  /** Unlinks resource files that no readable snapshot references. Ids are
   * content-addressed, so a file left by a deleted slot is either shared by
   * another snapshot (kept) or dead (removed). */
  private async pruneResources(): Promise<void> {
    const referenced = new Set<string>()
    let files: string[]
    try {
      files = await readdir(this.baseDir)
    } catch {
      return
    }
    for (const file of files) {
      if (!file.endsWith('.oanim')) continue
      try {
        const bytes = await readFile(join(this.baseDir, file))
        const { document } = parseProject(new Uint8Array(bytes))
        for (const resourceId of collectResourceCounts(document).keys()) referenced.add(resourceId)
      } catch {
        // A corrupt snapshot cannot vouch for any resource; skip it.
      }
    }
    let resourceFiles: string[]
    try {
      resourceFiles = await readdir(this.resourcesDir)
    } catch {
      return
    }
    await Promise.all(
      resourceFiles.map(async (file) => {
        const dot = file.lastIndexOf('.')
        const resourceId = dot > 0 ? file.slice(0, dot) : ''
        if (isContentAddressedResourceId(resourceId) && referenced.has(resourceId)) return
        await unlink(join(this.resourcesDir, file)).catch(() => undefined)
      })
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
