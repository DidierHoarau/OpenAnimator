declare module 'gifenc' {
  export interface GifPaletteEntry extends ArrayLike<number> {
    0: number
    1: number
    2: number
    3?: number
  }

  export interface GifEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: {
        palette?: GifPaletteEntry[]
        delay?: number
        transparent?: boolean
        transparentIndex?: number
        repeat?: number
        dispose?: number
      }
    ): void
    finish(): void
    bytes(): Uint8Array
    bytesView(): Uint8Array
    reset(): void
  }

  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GifEncoderInstance

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: {
      format?: 'rgb565' | 'rgb444' | 'rgba4444'
      oneBitAlpha?: boolean | number
      clearAlpha?: boolean
      clearAlphaColor?: number
      clearAlphaThreshold?: number
    }
  ): GifPaletteEntry[]

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: GifPaletteEntry[],
    format?: 'rgb565' | 'rgb444' | 'rgba4444'
  ): Uint8Array

  export function nearestColorIndex(palette: GifPaletteEntry[], pixel: number[]): number
}
