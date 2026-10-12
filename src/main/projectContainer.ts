import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

import { collectResourceCounts } from '../shared/resources'
import { MigrationError, migrateDocument } from '../shared/migrate'
import type { AnimatorDocument } from '../shared/model'

/** A binary resource keyed by its SHA-256 hex digest, with the file
 * extension matching the actual encoded format. */
export interface ProjectResource {
  bytes: Uint8Array
  ext: string
}

export type ProjectResourceMap = Map<string, ProjectResource>

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const RESOURCE_PREFIX = 'resources/'
const DOCUMENT_ENTRY = 'document.json'

/** True when the bytes start with the ZIP local-file magic `PK\x03\x04`. */
export function isZipContainer(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && ZIP_MAGIC.every((byte, index) => bytes[index] === byte)
}

function resourceEntryName(resourceId: string, resource: ProjectResource): string {
  const ext = resource.ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin'
  return `${RESOURCE_PREFIX}${resourceId}.${ext}`
}

/** ZIP timestamp option for `packProject`: pinning `mtime` makes the output
 * byte-for-byte reproducible, which generated artifacts (committed docs
 * samples) rely on; interactive saves keep the default wall-clock time. */
export interface PackProjectOptions {
  /** Fixed modification time for every ZIP entry. */
  mtime?: Date
}

/**
 * Serializes a document and its referenced resources into the ZIP v2
 * `.oanim` container: `document.json` (deflated) plus one stored (level 0,
 * never recompressed) entry per *referenced* resource — the refcount walk
 * drops resources no node points at. Saving is always a ZIP file, even with
 * no resources at all.
 */
export function packProject(
  document: AnimatorDocument,
  resources: ProjectResourceMap,
  options: PackProjectOptions = {}
): Uint8Array {
  const referenced = collectResourceCounts(document)
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    [DOCUMENT_ENTRY]: [strToU8(JSON.stringify(document, null, 2)), { level: 6 }]
  }
  for (const [resourceId, resource] of resources) {
    if (!referenced.has(resourceId)) continue
    files[resourceEntryName(resourceId, resource)] = [resource.bytes, { level: 0 }]
  }
  return zipSync(files, options.mtime ? { mtime: options.mtime } : {})
}

function parseResourceName(entryName: string): { id: string; ext: string } | null {
  if (!entryName.startsWith(RESOURCE_PREFIX) || entryName.endsWith('/')) return null
  const base = entryName.slice(RESOURCE_PREFIX.length)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return { id: base.slice(0, dot), ext: base.slice(dot + 1).toLowerCase() }
}

/**
 * Parses a ZIP v2 container: extracts `document.json` (migrated and
 * deep-validated), then collects the `resources/` entries keyed by their
 * content digest. Missing or corrupt resource bytes are *not* an error — the
 * document still opens and the renderer shows placeholders; unknown node
 * types and structurally broken files raise `MigrationError` (pre-1.0, no
 * forward-compat shims).
 */
export function parseProject(bytes: Uint8Array): {
  document: AnimatorDocument
  resources: ProjectResourceMap
} {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    throw new MigrationError('The project file is not a valid OpenAnimator archive.')
  }
  const documentBytes = entries[DOCUMENT_ENTRY]
  if (!documentBytes) {
    throw new MigrationError('The project archive is missing its document.json entry.')
  }
  let document: AnimatorDocument
  try {
    document = migrateDocument(JSON.parse(strFromU8(documentBytes)))
  } catch (error) {
    if (error instanceof MigrationError) throw error
    throw new MigrationError('The project archive contains an invalid document.json entry.')
  }
  const resources: ProjectResourceMap = new Map()
  for (const [entryName, entryBytes] of Object.entries(entries)) {
    if (entryName === DOCUMENT_ENTRY) continue
    const parsed = parseResourceName(entryName)
    if (parsed) resources.set(parsed.id, { bytes: entryBytes, ext: parsed.ext })
  }
  return { document, resources }
}
