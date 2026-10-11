import { zipSync } from 'fflate'

/**
 * Packs per-frame PNG files into a ZIP archive: `frame_0000.png` … The zero
 * padding keeps frames ordered in every file browser and import dialog.
 */
export function packPngSequence(frames: Uint8Array[]): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  frames.forEach((bytes, index) => {
    files[`frame_${String(index).padStart(4, '0')}.png`] = bytes
  })
  return zipSync(files)
}
