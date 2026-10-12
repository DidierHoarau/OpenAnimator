import type { LottieAudioResource } from '@shared/lottieExport'

import type { ResourceCache } from '../resourceCache'

export type BlobBytesReader = (blob: Blob) => Promise<Uint8Array>

async function defaultReadBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/** File extensions for the MIME types `sniffResourceMime` can report for
 * audio resources (plus common variants); unknown types fall back to `.bin`. */
const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/webm': 'webm'
}

/**
 * Bridges the session ResourceCache into the Lottie exporter's audio-bytes
 * resolver: a resource id becomes its raw bytes plus the file extension
 * derived from the sniffed Blob type (cached per id) for data-URI embedding
 * or dotLottie side files. Missing or unreadable resources resolve to null
 * and the exporter reports a diagnostic instead.
 */
export function createResourceBytesResolver(
  resources: ResourceCache,
  readBlob: BlobBytesReader = defaultReadBlobBytes
): (resourceId: string) => Promise<LottieAudioResource | null> {
  const cache = new Map<string, LottieAudioResource | null>()
  return async (resourceId: string): Promise<LottieAudioResource | null> => {
    const cached = cache.get(resourceId)
    if (cached !== undefined) return cached
    const blob = resources.getBlob(resourceId)
    if (!blob) {
      cache.set(resourceId, null)
      return null
    }
    try {
      const bytes = await readBlob(blob)
      const result = { bytes, ext: EXT_BY_MIME[blob.type] ?? 'bin' }
      cache.set(resourceId, result)
      return result
    } catch {
      cache.set(resourceId, null)
      return null
    }
  }
}
