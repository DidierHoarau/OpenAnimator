export type Rgb = [number, number, number]

/** Parses `#rgb` and `#rrggbb` hex colors; returns null for anything else. */
export function parseHexColor(value: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (!match) return null
  let hex = match[1]
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('')
  }
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

export function formatHexColor(rgb: Rgb): string {
  const channels = rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))))
  const [r, g, b] = channels as Rgb
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

/** Linearly interpolates two hex colors; returns null if either is not valid hex. */
export function lerpHexColor(from: string, to: string, t: number): string | null {
  const a = parseHexColor(from)
  const b = parseHexColor(to)
  if (!a || !b) return null
  const mixed: Rgb = [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ]
  return formatHexColor(mixed)
}
