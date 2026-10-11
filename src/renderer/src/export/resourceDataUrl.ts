import type { ResourceCache } from '../resourceCache'
import type { FrameRasterDeps } from './frameRaster'

export type BlobReader = (blob: Blob) => Promise<string>

function defaultReadBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Could not read the image data'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Bridges the session ResourceCache into the export rasterizer's data-URL
 * resolver: resource ids become `data:` URLs via FileReader (cached per id),
 * so the SVG frames stay self-contained. Missing or corrupt resources
 * resolve to null and render as the standard placeholder.
 */
export function createResourceDataUrlResolver(
  resources: ResourceCache,
  readBlob: BlobReader = defaultReadBlobAsDataUrl
): FrameRasterDeps['resolveResourceDataUrl'] {
  const cache = new Map<string, string | null>()
  return async (resourceId: string): Promise<string | null> => {
    const cached = cache.get(resourceId)
    if (cached !== undefined) return cached
    const blob = resources.getBlob(resourceId)
    if (!blob) {
      cache.set(resourceId, null)
      return null
    }
    try {
      const url = await readBlob(blob)
      cache.set(resourceId, url)
      return url
    } catch {
      cache.set(resourceId, null)
      return null
    }
  }
}
