import { deflateSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

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

/** How the last incremental pack treated the referenced resource entries. */
export interface PackCacheStats {
  /** Resource entries reappended verbatim from the pack cache. */
  reused: number
  /** Resource entries freshly compressed and cached. */
  rebuilt: number
}

/** One cached resource entry: the complete local file record (its bytes can
 * be re-appended verbatim — a local record contains no self-referencing
 * offsets) plus the metadata the central directory needs. */
export interface PackedResourceRecord {
  localRecord: Uint8Array
  nameBytes: Uint8Array
  crc32: number
  compressedSize: number
  uncompressedSize: number
}

/**
 * Session cache for incremental recovery packing, keyed by ZIP entry name.
 * Reuse is sound by construction: resource ids are content-addressed SHA-256
 * digests, so the same entry name always means the same bytes. The cache is
 * naturally bounded by the session resource store — no eviction needed.
 */
export class ProjectPackCache {
  readonly entries = new Map<string, PackedResourceRecord>()
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE 802.3, the ZIP variant), table-based and dependency-free. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

interface LocalRecordFields {
  method: 0 | 8
  crc: number
  compressedSize: number
  uncompressedSize: number
  data: Uint8Array
  mtime: Date
}

function localRecord(nameBytes: Uint8Array, fields: LocalRecordFields): Uint8Array {
  const stamp = dosDateTime(fields.mtime)
  const record = new Uint8Array(30 + nameBytes.length + fields.data.length)
  const view = new DataView(record.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 0, true)
  view.setUint16(8, fields.method, true)
  view.setUint16(10, stamp.time, true)
  view.setUint16(12, stamp.date, true)
  view.setUint32(14, fields.crc, true)
  view.setUint32(18, fields.compressedSize, true)
  view.setUint32(22, fields.uncompressedSize, true)
  view.setUint16(26, nameBytes.length, true)
  view.setUint16(28, 0, true)
  record.set(nameBytes, 30)
  record.set(fields.data, 30 + nameBytes.length)
  return record
}

function centralEntry(
  nameBytes: Uint8Array,
  method: 0 | 8,
  checksum: number,
  compressedSize: number,
  uncompressedSize: number,
  localOffset: number,
  mtime: Date
): Uint8Array {
  const stamp = dosDateTime(mtime)
  const entry = new Uint8Array(46 + nameBytes.length)
  const view = new DataView(entry.buffer)
  view.setUint32(0, 0x02014b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 20, true)
  view.setUint16(8, 0, true)
  view.setUint16(10, method, true)
  view.setUint16(12, stamp.time, true)
  view.setUint16(14, stamp.date, true)
  view.setUint32(16, checksum, true)
  view.setUint32(20, compressedSize, true)
  view.setUint32(24, uncompressedSize, true)
  view.setUint16(28, nameBytes.length, true)
  view.setUint16(30, 0, true)
  view.setUint16(32, 0, true)
  view.setUint16(34, 0, true)
  view.setUint16(36, 0, true)
  view.setUint32(38, 0, true)
  view.setUint32(42, localOffset, true)
  entry.set(nameBytes, 46)
  return entry
}

function endOfCentralDirectory(count: number, cdSize: number, cdOffset: number): Uint8Array {
  const eocd = new Uint8Array(22)
  const view = new DataView(eocd.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, count, true)
  view.setUint16(10, count, true)
  view.setUint32(12, cdSize, true)
  view.setUint32(16, cdOffset, true)
  return eocd
}

function concatParts(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

/**
 * Incremental variant of `packProject` for the autosave path: same container
 * format (a regular ZIP v2 read back by `parseProject`), but the stored
 * resource entries whose (content-addressed) entry is already in `cache` are
 * re-appended byte-for-byte from their cached local records instead of being
 * re-checksummed and re-framed — only `document.json` is re-deflated on
 * every write. Unlike `packProject`, the output is not required to be
 * byte-reproducible (generated docs samples keep using `packProject`).
 */
export function packProjectIncremental(
  document: AnimatorDocument,
  resources: ProjectResourceMap,
  cache: ProjectPackCache,
  options: PackProjectOptions = {}
): { bytes: Uint8Array; stats: PackCacheStats } {
  const referenced = collectResourceCounts(document)
  const mtime = options.mtime ?? new Date()
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0
  let reused = 0
  let rebuilt = 0

  const documentBytes = strToU8(JSON.stringify(document, null, 2))
  const documentDeflated = deflateSync(documentBytes, { level: 6 })
  const documentName = strToU8(DOCUMENT_ENTRY)
  const documentChecksum = crc32(documentBytes)
  const documentLocal = localRecord(documentName, {
    method: 8,
    crc: documentChecksum,
    compressedSize: documentDeflated.length,
    uncompressedSize: documentBytes.length,
    data: documentDeflated,
    mtime
  })
  localParts.push(documentLocal)
  centralParts.push(
    centralEntry(
      documentName,
      8,
      documentChecksum,
      documentDeflated.length,
      documentBytes.length,
      0,
      mtime
    )
  )
  offset += documentLocal.length

  for (const [resourceId, resource] of resources) {
    if (!referenced.has(resourceId)) continue
    const entryName = resourceEntryName(resourceId, resource)
    const cached = cache.entries.get(entryName)
    if (cached) {
      localParts.push(cached.localRecord)
      centralParts.push(
        centralEntry(
          cached.nameBytes,
          0,
          cached.crc32,
          cached.compressedSize,
          cached.uncompressedSize,
          offset,
          mtime
        )
      )
      offset += cached.localRecord.length
      reused += 1
      continue
    }
    const nameBytes = strToU8(entryName)
    const checksum = crc32(resource.bytes)
    const local = localRecord(nameBytes, {
      method: 0,
      crc: checksum,
      compressedSize: resource.bytes.length,
      uncompressedSize: resource.bytes.length,
      data: resource.bytes,
      mtime
    })
    cache.entries.set(entryName, {
      localRecord: local,
      nameBytes,
      crc32: checksum,
      compressedSize: resource.bytes.length,
      uncompressedSize: resource.bytes.length
    })
    localParts.push(local)
    centralParts.push(
      centralEntry(nameBytes, 0, checksum, resource.bytes.length, resource.bytes.length, offset, mtime)
    )
    offset += local.length
    rebuilt += 1
  }

  const central = concatParts(centralParts)
  const eocd = endOfCentralDirectory(localParts.length, central.length, offset)
  return { bytes: concatParts([...localParts, central, eocd]), stats: { reused, rebuilt } }
}
