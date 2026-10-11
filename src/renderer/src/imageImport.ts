import { fitImagePlacement } from '@shared/imagePlacement'
import type { ImageNode } from '@shared/model'
import { createId } from '@shared/document'

import type { Editor } from './editor'

/** How an imported file's bytes are handled. */
export type ImageFormat = 'png' | 'jpg' | 'webp' | 'gif' | 'svg'

const FORMAT_MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml'
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.slice(0, 256)).trimStart().toLowerCase()
  return head.startsWith('<svg') || head.startsWith('<?xml')
}

/** Format of an imported file: extension first (SVG has no magic bytes),
 * then the magic bytes. Null when the format is not supported. */
export function detectImageFormat(fileName: string, bytes: Uint8Array): ImageFormat | null {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  if (ext === 'svg') return 'svg'
  if (ext === 'png') return 'png'
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg'
  if (ext === 'webp') return 'webp'
  if (ext === 'gif') return 'gif'
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return 'png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'webp'
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif'
  if (looksLikeSvg(bytes)) return 'svg'
  return null
}

/** Injectable decode/encode dependencies (the real ones use the DOM). */
export interface ImageImportDeps {
  /** Intrinsic pixel size of the decoded image. */
  decode?: (bytes: Uint8Array, mime: string) => Promise<{ width: number; height: number }>
  /** PNG bytes of the raster drawn at `scale`× its natural size. */
  encodePng?: (
    bytes: Uint8Array,
    mime: string,
    natural: { width: number; height: number },
    scale: number
  ) => Promise<Uint8Array>
}

function defaultDecode(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }))
  const image = new Image()
  image.src = url
  return image
    .decode()
    .then(() => ({ width: image.naturalWidth, height: image.naturalHeight }))
    .finally(() => URL.revokeObjectURL(url))
}

function defaultEncodePng(
  bytes: Uint8Array,
  mime: string,
  natural: { width: number; height: number },
  scale: number
): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(natural.width * scale))
  canvas.height = Math.max(1, Math.round(natural.height * scale))
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }))
  const image = new Image()
  image.src = url
  return new Promise<Uint8Array>((resolve, reject) => {
    image.onload = () => {
      const context = canvas.getContext('2d')
      if (!context) {
        reject(new Error('Canvas 2D context is unavailable'))
        return
      }
      context.imageSmoothingEnabled = true
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url)
        if (!blob) {
          reject(new Error('PNG encoding failed'))
          return
        }
        void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)))
      }, 'image/png')
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Image decoding failed'))
    }
  })
}

/** A decoded, stored image ready to be referenced by an ImageNode. */
export interface PreparedImage {
  resourceId: string
  deduped: boolean
  natural: { width: number; height: number }
  name: string
}

/**
 * Decodes, (re-)encodes and stores raw image bytes in the main-process
 * resource store: PNG/JPEG/WebP keep their original bytes (no recompression),
 * GIFs are re-encoded to a PNG of their first frame and static SVGs are
 * rasterized at 2×. Identical content dedupes by SHA-256. Returns null (with
 * a status-bar message) for unsupported formats and undecodable bytes.
 */
export async function prepareImageResource(
  editor: Editor,
  fileName: string,
  bytes: Uint8Array,
  deps: ImageImportDeps = {}
): Promise<PreparedImage | null> {
  const format = detectImageFormat(fileName, bytes)
  if (!format) {
    editor.showMessage('Unsupported image format (PNG, JPG, WebP, GIF or SVG)')
    return null
  }
  const mime = FORMAT_MIME[format]
  const decode = deps.decode ?? defaultDecode
  const encodePng = deps.encodePng ?? defaultEncodePng
  let natural: { width: number; height: number }
  let resourceBytes: Uint8Array
  try {
    natural = await decode(bytes, mime)
    if (format === 'gif') {
      resourceBytes = await encodePng(bytes, mime, natural, 1)
    } else if (format === 'svg') {
      resourceBytes = await encodePng(bytes, mime, natural, 2)
      natural = { width: natural.width * 2, height: natural.height * 2 }
    } else {
      resourceBytes = bytes
    }
  } catch (error) {
    console.warn('OpenAnimator: image import failed', error)
    editor.showMessage('The image could not be decoded')
    return null
  }
  const { resourceId, deduped } = await window.api.addResource(resourceBytes, fileName)
  return { resourceId, deduped, natural, name: fileName }
}

/**
 * Imports raw image bytes as a new ImageNode on the current object layer:
 * placed centered on the stage — or at the drop point — at natural size
 * capped to the stage, then auto-selected. Returns true when the image landed
 * on the stage.
 */
export async function importImageBytes(
  editor: Editor,
  fileName: string,
  bytes: Uint8Array,
  dropPoint?: { x: number; y: number },
  deps: ImageImportDeps = {}
): Promise<boolean> {
  const layer = editor.currentLayer
  if (!layer || layer.locked || !layer.visible) {
    editor.showMessage('Select a visible, unlocked object layer to import the image')
    return false
  }
  const prepared = await prepareImageResource(editor, fileName, bytes, deps)
  if (!prepared) return false
  const placement = fitImagePlacement(prepared.natural, editor.document, dropPoint)
  const node: ImageNode = {
    id: createId('node'),
    type: 'image',
    name: prepared.name,
    resourceId: prepared.resourceId,
    center: placement.center,
    width: placement.width,
    height: placement.height,
    rotation: 0,
    opacity: 1,
    naturalWidth: Math.max(1, prepared.natural.width),
    naturalHeight: Math.max(1, prepared.natural.height),
    smoothing: true
  }
  editor.addNode(node)
  return true
}

/** Picks an image file through the OS dialog; null when canceled. */
export async function pickImageFile(): Promise<{ fileName: string; bytes: Uint8Array } | null> {
  const result = await window.api.pickImageFile('Import image')
  return result.canceled ? null : { fileName: result.fileName, bytes: result.bytes }
}

/** Imports an image picked through the OS file dialog (Ctrl+I / toolbar). */
export async function importImageViaDialog(editor: Editor): Promise<boolean> {
  const picked = await pickImageFile()
  if (!picked) return false
  return importImageBytes(editor, picked.fileName, picked.bytes)
}
