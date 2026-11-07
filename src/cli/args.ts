export type FlagValue = string | boolean | string[]

export interface CliArgs {
  positional: string[]
  flags: Map<string, FlagValue>
}

/** Flags that never take a value: the next token stays positional. */
const BOOLEAN_FLAGS = new Set(['transparent', 'gif-dither'])

/**
 * Splits `--flag value` pairs from positionals. Known boolean flags never
 * consume the following token, so `render --transparent in.oanim --out out.gif`
 * keeps `in.oanim` positional. Value flags accumulate in order when repeated
 * (e.g. `--format gif --format lottie`); unknown flags keep the legacy
 * behavior of consuming a following non-flag token.
 */
export function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = []
  const flags = new Map<string, FlagValue>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const key = arg.slice(2)
    if (BOOLEAN_FLAGS.has(key)) {
      flags.set(key, true)
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      const existing = flags.get(key)
      if (typeof existing === 'string') flags.set(key, [existing, next])
      else if (Array.isArray(existing)) existing.push(next)
      else flags.set(key, next)
      index += 1
    } else {
      flags.set(key, true)
    }
  }
  return { positional, flags }
}

export function stringFlag(flags: CliArgs['flags'], key: string): string | undefined {
  const value = flags.get(key)
  return typeof value === 'string' ? value : undefined
}

/** Every occurrence of a value flag, in command-line order. */
export function stringFlags(flags: CliArgs['flags'], key: string): string[] {
  const value = flags.get(key)
  if (value === undefined || typeof value === 'boolean') return []
  return Array.isArray(value) ? value : [value]
}

export function booleanFlag(flags: CliArgs['flags'], key: string): boolean {
  return flags.has(key)
}

export function numberFlag(flags: CliArgs['flags'], key: string): number | undefined {
  const value = stringFlag(flags, key)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
