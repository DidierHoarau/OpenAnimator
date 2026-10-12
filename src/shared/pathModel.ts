import type { PathAnchor, PathNode } from './model'

/**
 * Path geometry for `PathNode`: anchors ↔ SVG path data conversion, bounds
 * and normalization. `d` is the single source of truth; anchors are an
 * editing view of it. The parser supports the M/L/H/V/C/S/Q/T/Z commands in
 * both absolute and relative form (opentype.js emits M/L/C/Q/Z, the pen tool
 * emits M/L/C/Z); arcs (A) and malformed data are rejected with `null`.
 */

/** Absolute, relative-form-resolved path command. */
export type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'Z' }

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/
const TOKEN = new RegExp(`([MLHVCSQTAZmlhvcsqtaz])|(${NUMBER.source})`, 'g')

const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2 }

function formatNumber(value: number): string {
  const rounded = Number(value.toFixed(2))
  return String(rounded)
}

/** Parses `d` into absolute commands; null on unknown commands (A), a number
 * count mismatch or malformed numbers. */
export function parsePathCommands(d: string): PathCommand[] | null {
  const tokens = d.match(TOKEN)
  if (!tokens) return null
  const commands: PathCommand[] = []
  const cursor = { x: 0, y: 0 }
  let command = ''
  let relative = false
  const numbers: number[] = []
  const at = (index: number, value: number): number => (relative ? value + index : value)
  const flush = (): boolean => {
    if (!command) return true
    const arity = ARITY[command]
    if (arity === undefined || numbers.length === 0 || numbers.length % arity !== 0) return false
    for (let offset = 0; offset < numbers.length; offset += arity) {
      const n = numbers.slice(offset, offset + arity)
      switch (command) {
        case 'M':
          cursor.x = at(cursor.x, n[0])
          cursor.y = at(cursor.y, n[1])
          commands.push({ type: 'M', x: cursor.x, y: cursor.y })
          command = 'L'
          break
        case 'L':
          cursor.x = at(cursor.x, n[0])
          cursor.y = at(cursor.y, n[1])
          commands.push({ type: 'L', x: cursor.x, y: cursor.y })
          break
        case 'H':
          cursor.x = at(cursor.x, n[0])
          commands.push({ type: 'L', x: cursor.x, y: cursor.y })
          break
        case 'V':
          cursor.y = at(cursor.y, n[0])
          commands.push({ type: 'L', x: cursor.x, y: cursor.y })
          break
        case 'C': {
          const x1 = at(cursor.x, n[0])
          const y1 = at(cursor.y, n[1])
          const x2 = at(cursor.x, n[2])
          const y2 = at(cursor.y, n[3])
          cursor.x = at(cursor.x, n[4])
          cursor.y = at(cursor.y, n[5])
          commands.push({ type: 'C', x1, y1, x2, y2, x: cursor.x, y: cursor.y })
          break
        }
        case 'S': {
          const previous = commands[commands.length - 1]
          const reflected =
            previous && previous.type === 'C'
              ? { x: 2 * previous.x - previous.x2, y: 2 * previous.y - previous.y2 }
              : { ...cursor }
          const x2 = at(cursor.x, n[0])
          const y2 = at(cursor.y, n[1])
          cursor.x = at(cursor.x, n[2])
          cursor.y = at(cursor.y, n[3])
          commands.push({ type: 'C', x1: reflected.x, y1: reflected.y, x2, y2, x: cursor.x, y: cursor.y })
          break
        }
        case 'Q': {
          const x1 = at(cursor.x, n[0])
          const y1 = at(cursor.y, n[1])
          cursor.x = at(cursor.x, n[2])
          cursor.y = at(cursor.y, n[3])
          commands.push({ type: 'Q', x1, y1, x: cursor.x, y: cursor.y })
          break
        }
        case 'T': {
          const previous = commands[commands.length - 1]
          const reflected =
            previous && previous.type === 'Q'
              ? { x: 2 * previous.x - previous.x1, y: 2 * previous.y - previous.y1 }
              : { ...cursor }
          cursor.x = at(cursor.x, n[0])
          cursor.y = at(cursor.y, n[1])
          commands.push({ type: 'Q', x1: reflected.x, y1: reflected.y, x: cursor.x, y: cursor.y })
          break
        }
      }
    }
    numbers.length = 0
    return true
  }
  for (const token of tokens) {
    if (token.length === 1 && /[a-zA-Z]/.test(token)) {
      if (!flush()) return null
      const upper = token.toUpperCase()
      if (upper === 'A') return null
      if (upper === 'Z') {
        commands.push({ type: 'Z' })
        command = ''
        continue
      }
      command = upper
      relative = token !== upper
      continue
    }
    const value = Number(token)
    if (!Number.isFinite(value)) return null
    numbers.push(value)
  }
  if (!flush()) return null
  return commands
}

/** Serializes absolute commands back to path data (numbers to 2 decimals). */
export function serializeCommands(commands: PathCommand[]): string {
  let d = ''
  for (const command of commands) {
    switch (command.type) {
      case 'M':
        d += `M${formatNumber(command.x)} ${formatNumber(command.y)}`
        break
      case 'L':
        d += `L${formatNumber(command.x)} ${formatNumber(command.y)}`
        break
      case 'C':
        d += `C${formatNumber(command.x1)} ${formatNumber(command.y1)} ${formatNumber(command.x2)} ${formatNumber(command.y2)} ${formatNumber(command.x)} ${formatNumber(command.y)}`
        break
      case 'Q':
        d += `Q${formatNumber(command.x1)} ${formatNumber(command.y1)} ${formatNumber(command.x)} ${formatNumber(command.y)}`
        break
      case 'Z':
        d += 'Z'
        break
    }
  }
  return d
}

/** Builds absolute path data from anchors: straight `L` segments unless an
 * anchor carries handles, which produce cubic `C` segments. */
export function buildPathData(anchors: PathAnchor[], closed: boolean): string {
  if (anchors.length === 0) return ''
  const commands: PathCommand[] = [{ type: 'M', x: anchors[0].x, y: anchors[0].y }]
  for (let i = 1; i < anchors.length; i++) {
    commands.push(...segmentCommands(anchors[i - 1], anchors[i]))
  }
  if (closed && anchors.length > 2) {
    commands.push(...segmentCommands(anchors[anchors.length - 1], anchors[0]))
    commands.push({ type: 'Z' })
  }
  return serializeCommands(commands)
}

function segmentCommands(from: PathAnchor, to: PathAnchor): PathCommand[] {
  if (!from.out && !to.in) {
    return [{ type: 'L', x: to.x, y: to.y }]
  }
  const c1 = from.out ? { x: from.x + from.out.x, y: from.y + from.out.y } : { ...from }
  const c2 = to.in ? { x: to.x + to.in.x, y: to.y + to.in.y } : { ...to }
  return [{ type: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: to.x, y: to.y }]
}

/** Editing view of `d`: anchors for a single open/closed subpath, or null for
 * multi-subpath paths (glyph outlines) and unparseable data — those are only
 * moved/scaled as a whole. */
export function pathDataToAnchors(d: string): { anchors: PathAnchor[]; closed: boolean } | null {
  const commands = parsePathCommands(d)
  if (!commands || commands.length === 0) return null
  let closed = false
  const anchors: PathAnchor[] = []
  for (const command of commands) {
    if (command.type === 'M') {
      if (anchors.length > 0) return null
      anchors.push({ x: command.x, y: command.y })
      continue
    }
    if (command.type === 'Z') {
      if (anchors.length === 0) return null
      closed = true
      continue
    }
    if (closed) return null
    const previous = anchors[anchors.length - 1]
    if (command.type === 'C') {
      previous.out = { x: command.x1 - previous.x, y: command.y1 - previous.y }
      anchors.push({ x: command.x, y: command.y, in: { x: command.x2 - command.x, y: command.y2 - command.y } })
      continue
    }
    if (command.type === 'Q') {
      // Quadratic → equivalent cubic handles: c = p ± ⅔(q − p).
      previous.out = { x: (2 / 3) * (command.x1 - previous.x), y: (2 / 3) * (command.y1 - previous.y) }
      anchors.push({
        x: command.x,
        y: command.y,
        in: { x: (2 / 3) * (command.x1 - command.x), y: (2 / 3) * (command.y1 - command.y) }
      })
      continue
    }
    anchors.push({ x: command.x, y: command.y })
  }
  return { anchors, closed }
}

/** Bounding box of everything `d` draws (on-curve points and controls);
 * null when the path draws nothing. */
export function pathDataBounds(d: string): { x: number; y: number; width: number; height: number } | null {
  const commands = parsePathCommands(d)
  if (!commands || commands.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const add = (x: number, y: number): void => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const command of commands) {
    if (command.type === 'Z') continue
    add(command.x, command.y)
    if (command.type === 'C') {
      add(command.x1, command.y1)
      add(command.x2, command.y2)
    }
    if (command.type === 'Q') add(command.x1, command.y1)
  }
  if (minX === Infinity) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Re-centers `d` so its bounding-box center sits at (0,0) — the invariant the
 * renderer's scale transform relies on. Returns `d` unchanged when it cannot
 * be parsed or draws nothing.
 */
export function normalizePathData(d: string): string {
  const commands = parsePathCommands(d)
  if (!commands) return d
  const bounds = pathDataBounds(d)
  if (!bounds) return d
  const dx = -(bounds.x + bounds.width / 2)
  const dy = -(bounds.y + bounds.height / 2)
  const shifted = commands.map((command) => {
    switch (command.type) {
      case 'M':
        return { type: 'M' as const, x: command.x + dx, y: command.y + dy }
      case 'L':
        return { type: 'L' as const, x: command.x + dx, y: command.y + dy }
      case 'C':
        return {
          type: 'C' as const,
          x1: command.x1 + dx,
          y1: command.y1 + dy,
          x2: command.x2 + dx,
          y2: command.y2 + dy,
          x: command.x + dx,
          y: command.y + dy
        }
      case 'Q':
        return {
          type: 'Q' as const,
          x1: command.x1 + dx,
          y1: command.y1 + dy,
          x: command.x + dx,
          y: command.y + dy
        }
      case 'Z':
        return command
    }
  })
  return serializeCommands(shifted)
}

/** Natural size of a path's geometry: the parsed bounding box, falling back
 * to the node's placed size for unparseable data. */
export function pathNaturalSize(node: PathNode): { width: number; height: number } {
  const bounds = pathDataBounds(node.d)
  return {
    width: bounds && bounds.width > 0 ? bounds.width : node.width,
    height: bounds && bounds.height > 0 ? bounds.height : node.height
  }
}
