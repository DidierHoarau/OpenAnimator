/**
 * Extracts the `.oanim` path from a launch command line. The first entry is
 * the executable itself; switches (`-…`) and non-project arguments are
 * ignored, and the last matching argument wins (Windows/macOS may append
 * their own trailing switches).
 */
export function projectPathFromArgv(argv: string[]): string | null {
  let found: string | null = null
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    if (/\.oanim$/i.test(arg)) found = arg
  }
  return found
}
