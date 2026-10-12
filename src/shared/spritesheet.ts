import { strToU8, zipSync } from 'fflate'

/**
 * Spritesheet packing (pure helpers): grid math, TexturePacker JSON-Hash
 * metadata, RGBA blitting and the atlas zip. The rasterizer lives on the
 * caller's side — the canvas path in the renderer, resvg + pngjs in the CLI —
 * so every helper here stays environment-free and unit-testable.
 */

export interface SpritesheetGrid {
  columns: number
  rows: number
  width: number
  height: number
}

/**
 * Near-square atlas grid for `frameCount` frames of `frameWidth` ×
 * `frameHeight` pixels. The column count starts from the minimal pixel-square
 * and only grows (making the atlas wider, never taller) to keep both sides
 * within `maxDimension`. Throws a descriptive error when a single frame or
 * the whole sheet cannot fit — the caller surfaces it as an export failure.
 */
export function computeSpritesheetGrid(
  frameCount: number,
  frameWidth: number,
  frameHeight: number,
  maxDimension = 7680
): SpritesheetGrid {
  if (frameCount < 1) throw new Error('A spritesheet needs at least one frame.')
  if (frameWidth < 1 || frameHeight < 1) {
    throw new Error('Frame dimensions must be positive.')
  }
  if (frameWidth > maxDimension || frameHeight > maxDimension) {
    throw new Error(
      `A single frame of ${frameWidth}×${frameHeight} px exceeds the maximum spritesheet dimension of ${maxDimension} px.`
    )
  }
  const maxColumns = Math.floor(maxDimension / frameWidth)
  const maxRows = Math.floor(maxDimension / frameHeight)
  const minColumns = Math.ceil(frameCount / maxRows)
  if (minColumns > maxColumns) {
    throw new Error(
      `${frameCount} frames of ${frameWidth}×${frameHeight} px do not fit in a ${maxDimension}×${maxDimension} px atlas.`
    )
  }
  const idealColumns = Math.ceil(Math.sqrt((frameCount * frameHeight) / frameWidth))
  const columns = Math.min(maxColumns, Math.min(frameCount, Math.max(minColumns, idealColumns)))
  const rows = Math.ceil(frameCount / columns)
  return { columns, rows, width: columns * frameWidth, height: rows * frameHeight }
}

/** One frame's rectangle inside the atlas (top-left origin). */
export interface SpritesheetFrameRect {
  x: number
  y: number
  w: number
  h: number
}

export interface SpritesheetMetadata {
  frames: Record<
    string,
    {
      frame: SpritesheetFrameRect
      rotated: boolean
      trimmed: boolean
      spriteSourceSize: SpritesheetFrameRect
      sourceSize: { w: number; h: number }
    }
  >
  meta: {
    app: string
    version: string
    image: string
    format: string
    size: { w: number; h: number }
    scale: number
  }
  openanimator: {
    fps: number
    fromFrame: number
    toFrame: number
    frameCount: number
  }
}

export interface SpritesheetMetadataOptions {
  frameCount: number
  frameWidth: number
  frameHeight: number
  grid: SpritesheetGrid
  fps: number
  fromFrame: number
  toFrame: number
  /** App version recorded in `meta.version`. */
  version: string
}

/** TexturePacker JSON-Hash metadata plus an `openanimator` block (unknown to
 * TexturePacker consumers) carrying the playback info a player needs. Frame
 * names use the same `frame_%04d` convention as the PNG-sequence export. */
export function buildSpritesheetMetadata(options: SpritesheetMetadataOptions): SpritesheetMetadata {
  const frames: SpritesheetMetadata['frames'] = {}
  for (let i = 0; i < options.frameCount; i++) {
    const rect: SpritesheetFrameRect = {
      x: (i % options.grid.columns) * options.frameWidth,
      y: Math.floor(i / options.grid.columns) * options.frameHeight,
      w: options.frameWidth,
      h: options.frameHeight
    }
    frames[`frame_${String(i).padStart(4, '0')}`] = {
      frame: rect,
      rotated: false,
      trimmed: false,
      spriteSourceSize: { ...rect },
      sourceSize: { w: options.frameWidth, h: options.frameHeight }
    }
  }
  return {
    frames,
    meta: {
      app: 'OpenAnimator',
      version: options.version,
      image: 'atlas.png',
      format: 'RGBA8888',
      size: { w: options.grid.width, h: options.grid.height },
      scale: 1
    },
    openanimator: {
      fps: options.fps,
      fromFrame: options.fromFrame,
      toFrame: options.toFrame,
      frameCount: options.frameCount
    }
  }
}

/** Copies one RGBA frame into the atlas buffer at `(x, y)` by rows. Pure
 * buffer math; the caller guarantees the rectangle is inside the atlas. */
export function blitFrameIntoAtlas(
  atlas: Uint8Array,
  atlasWidth: number,
  frame: { rgba: Uint8Array; width: number; height: number },
  x: number,
  y: number
): void {
  const rowBytes = frame.width * 4
  for (let row = 0; row < frame.height; row++) {
    const source = row * rowBytes
    const target = ((y + row) * atlasWidth + x) * 4
    atlas.set(frame.rgba.subarray(source, source + rowBytes), target)
  }
}

/** Zips the atlas PNG together with its JSON metadata (the spritesheet
 * export artifact: `atlas.png` + `atlas.json`). */
export function packSpritesheet(atlasPng: Uint8Array, metadata: SpritesheetMetadata): Uint8Array {
  return zipSync({
    'atlas.png': atlasPng,
    'atlas.json': strToU8(JSON.stringify(metadata, null, 2))
  })
}
