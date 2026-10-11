import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app, ipcMain } from 'electron'

import {
  LIBRARY_ADD_CHANNEL,
  LIBRARY_LIST_CHANNEL,
  LIBRARY_REMOVE_CHANNEL,
  LIBRARY_RENAME_CHANNEL
} from '../shared/api'
import type { LibraryListResult, LibraryResource } from '../shared/api'
import { collectAssetResourceIds } from '../shared/assets'
import { isAsset } from '../shared/document'
import type { Asset } from '../shared/model'
import type { ProjectResource } from './projectContainer'
import { resourceStore } from './resources'

const INDEX_VERSION = 1

/**
 * Persistent global "My Library": an asset index JSON plus a content-addressed
 * resources folder under the application's user-data directory, so assets
 * survive across documents and sessions. Assets are validated on read
 * (invalid entries are dropped) and copied into the session resource store on
 * use by the renderer — content-addressed dedupe makes that cheap.
 */
export class LibraryStore {
  private readonly indexPath: string
  private readonly resourcesDir: string

  constructor(baseDir: string) {
    this.indexPath = join(baseDir, 'library.json')
    this.resourcesDir = join(baseDir, 'resources')
  }

  /** Every stored asset with the bytes of all referenced resources. */
  async list(): Promise<LibraryListResult> {
    const assets = await this.readIndex()
    const resources: Record<string, LibraryResource> = {}
    const filesById = await this.resourceFilesById()
    for (const asset of assets) {
      for (const resourceId of collectAssetResourceIds(asset, assets)) {
        if (resources[resourceId]) continue
        const file = filesById.get(resourceId)
        if (!file) continue
        try {
          resources[resourceId] = {
            bytes: new Uint8Array(await readFile(file.path)),
            ext: file.ext
          }
        } catch {
          // Missing/unreadable resource: the asset still lists; it shows a
          // placeholder when placed.
        }
      }
    }
    return { assets, resources }
  }

  /**
   * Stores an asset (validated; an existing entry with the same id is
   * replaced) and copies its referenced resources from the session resource
   * store into the library folder. Returns false for invalid assets.
   */
  async add(asset: Asset, contextAssets: Asset[] = []): Promise<boolean> {
    if (!isAsset(asset)) return false
    const assets = (await this.readIndex()).filter((entry) => entry.id !== asset.id)
    assets.push(asset)
    await this.ensureDirs()
    const store = resourceStore.all()
    for (const resourceId of collectAssetResourceIds(asset, contextAssets)) {
      const resource = store.get(resourceId)
      if (resource) await this.writeResource(resourceId, resource)
    }
    await this.writeIndex(assets)
    return true
  }

  /** Removes an asset from the index (its resource files stay — other
   * assets or future re-adds may reference them). */
  async remove(id: string): Promise<boolean> {
    const assets = await this.readIndex()
    const next = assets.filter((entry) => entry.id !== id)
    if (next.length === assets.length) return false
    await this.writeIndex(next)
    return true
  }

  /** Renames an asset. Returns false when the id is unknown. */
  async rename(id: string, name: string): Promise<boolean> {
    const assets = await this.readIndex()
    const asset = assets.find((entry) => entry.id === id)
    if (!asset) return false
    asset.name = name
    await this.writeIndex(assets)
    return true
  }

  private async readIndex(): Promise<Asset[]> {
    try {
      const raw = await readFile(this.indexPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return []
      const assets = (parsed as { assets?: unknown }).assets
      return Array.isArray(assets) ? assets.filter(isAsset) : []
    } catch {
      return []
    }
  }

  private async writeIndex(assets: Asset[]): Promise<void> {
    await this.ensureDirs()
    const payload = JSON.stringify({ version: INDEX_VERSION, assets }, null, 2)
    const tempPath = `${this.indexPath}.tmp`
    await writeFile(tempPath, payload, 'utf8')
    await rename(tempPath, this.indexPath)
  }

  private async writeResource(resourceId: string, resource: ProjectResource): Promise<void> {
    const ext = resource.ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin'
    await writeFile(join(this.resourcesDir, `${resourceId}.${ext}`), resource.bytes)
  }

  private async resourceFilesById(): Promise<Map<string, { path: string; ext: string }>> {
    const byId = new Map<string, { path: string; ext: string }>()
    let files: string[]
    try {
      files = await readdir(this.resourcesDir)
    } catch {
      return byId
    }
    for (const file of files) {
      const dot = file.lastIndexOf('.')
      if (dot <= 0) continue
      byId.set(file.slice(0, dot), {
        path: join(this.resourcesDir, file),
        ext: file.slice(dot + 1).toLowerCase()
      })
    }
    return byId
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.resourcesDir, { recursive: true })
  }
}

/** Registers the IPC handlers for the global library, backed by a store in
 * the application's user-data directory. */
export function registerLibraryHandlers(): void {
  const store = new LibraryStore(join(app.getPath('userData'), 'library'))
  ipcMain.handle(LIBRARY_LIST_CHANNEL, (): Promise<LibraryListResult> => store.list())
  ipcMain.handle(
    LIBRARY_ADD_CHANNEL,
    (_event, asset: Asset, contextAssets?: Asset[]): Promise<boolean> =>
      store.add(asset, contextAssets ?? [])
  )
  ipcMain.handle(LIBRARY_REMOVE_CHANNEL, (_event, id: string): Promise<boolean> => store.remove(id))
  ipcMain.handle(
    LIBRARY_RENAME_CHANNEL,
    (_event, id: string, name: string): Promise<boolean> => store.rename(id, name)
  )
}
