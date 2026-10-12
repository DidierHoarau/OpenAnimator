/** Sniffs the MIME type of an encoded resource from its magic bytes. */
export function sniffResourceMime(bytes: Uint8Array): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  // Embedded font subsets live in the resource store too; they are Blobs the
  // stage font registration reads, never images for `<image href>`.
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) {
    return 'font/ttf'
  }
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x54 && bytes[2] === 0x54 && bytes[3] === 0x4f) {
    return 'font/otf'
  }
  if (bytes.length >= 4 && bytes[0] === 0x74 && bytes[1] === 0x72 && bytes[2] === 0x75 && bytes[3] === 0x65) {
    return 'font/ttf'
  }
  if (bytes.length >= 4 && bytes[0] === 0x74 && bytes[1] === 0x74 && bytes[2] === 0x63 && bytes[3] === 0x66) {
    return 'font/collection'
  }
  return 'application/octet-stream'
}

/** Decoded-size report of the async validation pass. */
export interface DecodedImage {
  width: number
  height: number
}

export type UrlCreator = (blob: Blob) => string
export type UrlRevoker = (url: string) => void
export type ImageDecoder = (blob: Blob) => Promise<DecodedImage>

export interface ResourceCacheDeps {
  createUrl?: UrlCreator
  revokeUrl?: UrlRevoker
  /** Explicit `null` disables validation (e.g. environments without decoders). */
  decode?: ImageDecoder | null
}

function defaultCreateUrl(blob: Blob): string {
  return URL.createObjectURL(blob)
}

function defaultRevokeUrl(url: string): void {
  URL.revokeObjectURL(url)
}

function defaultDecode(blob: Blob): Promise<DecodedImage> {
  return createImageBitmap(blob).then((bitmap) => {
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  })
}

interface ResourceEntry {
  url: string
  blob: Blob
}

/**
 * In-memory cache of the document's binary resources: every blob is wrapped
 * as an object URL the DOM renderer injects into `<image href>` (embedded
 * font subsets are stored alongside and read as Blobs for font registration).
 * Registration runs an async decode validation — bytes that fail to decode
 * are marked corrupt, dropped from the cache and reported through the
 * listener so the stage re-renders them as placeholders. Resources missing
 * from the document's set never get a URL; the evaluator stays pure by
 * referring to resource ids only.
 */
export class ResourceCache {
  private readonly entries = new Map<string, ResourceEntry>()
  private readonly corrupt = new Set<string>()
  private readonly createUrl: UrlCreator
  private readonly revokeUrl: UrlRevoker
  private readonly decode: ImageDecoder | null
  private readonly listeners = new Set<() => void>()

  constructor(resources: Record<string, Uint8Array> = {}, deps: ResourceCacheDeps = {}) {
    this.createUrl = deps.createUrl ?? defaultCreateUrl
    this.revokeUrl = deps.revokeUrl ?? defaultRevokeUrl
    this.decode = deps.decode !== undefined ? deps.decode : typeof createImageBitmap === 'function' ? defaultDecode : null
    this.reset(resources)
  }

  /** Object URL of the resource, or null when missing/corrupt (placeholder). */
  getUrl(resourceId: string): string | null {
    return this.entries.get(resourceId)?.url ?? null
  }

  /** The stored blob of the resource, or null when missing/corrupt. Used by
   * the export pipeline to build data: URLs (blob: references cannot load
   * inside an SVG rasterized through `<img>`). */
  getBlob(resourceId: string): Blob | null {
    return this.entries.get(resourceId)?.blob ?? null
  }

  isCorrupt(resourceId: string): boolean {
    return this.corrupt.has(resourceId)
  }

  get size(): number {
    return this.entries.size
  }

  /** Replaces the whole cache — used when a document is opened or reset. */
  reset(resources: Record<string, Uint8Array>): void {
    for (const entry of this.entries.values()) this.revokeUrl(entry.url)
    this.entries.clear()
    this.corrupt.clear()
    for (const [resourceId, bytes] of Object.entries(resources)) {
      this.store(resourceId, bytes)
    }
    this.validateAsync()
  }

  /**
   * Registers one resource (e.g. when an asset is imported into the session
   * from the global library), replacing any previous entry under the same id.
   * The blob is validated asynchronously like every reset-registered entry.
   */
  put(resourceId: string, bytes: Uint8Array): void {
    const existing = this.entries.get(resourceId)
    if (existing) this.revokeUrl(existing.url)
    this.corrupt.delete(resourceId)
    this.store(resourceId, bytes)
    this.validateAsync(resourceId)
  }

  private store(resourceId: string, bytes: Uint8Array): void {
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: sniffResourceMime(bytes) })
    this.entries.set(resourceId, { url: this.createUrl(blob), blob })
  }

  private validateAsync(only?: string): void {
    if (!this.decode) return
    for (const [resourceId, entry] of [...this.entries]) {
      if (only !== undefined && resourceId !== only) continue
      // Font blobs are not images: the image decoder can never accept them,
      // so validating them would wrongly flag and drop every embedded subset.
      if (entry.blob.type.startsWith('font/')) continue
      void this.decode(entry.blob)
        .then(() => {
          if (this.corrupt.delete(resourceId)) this.notify()
        })
        .catch(() => {
          const current = this.entries.get(resourceId)
          if (current && current.url === entry.url) {
            this.revokeUrl(current.url)
            this.entries.delete(resourceId)
          }
          this.corrupt.add(resourceId)
          this.notify()
        })
    }
  }

  /** Notified when a resource is found corrupt (or recovers) so views re-render. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
