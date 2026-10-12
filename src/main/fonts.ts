import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { app, ipcMain } from 'electron'

import { FONT_LIST_CHANNEL, FONT_POLICY_CHANNEL, FONT_READ_CHANNEL } from '../shared/api'
import type { FontReadResult, SystemFont } from '../shared/api'
import { DEFAULT_EMBEDDING_ALLOWLIST } from '../shared/fontPolicy'
import type { FontEmbeddingPolicy, FontEmbeddingRule } from '../shared/fontPolicy'

const execFileAsync = promisify(execFile)

/** One font face as reported by fontconfig. */
export interface FcFontFace {
  family: string
  weight: number
  /** True for italic and oblique faces (both render as italic text). */
  italic: boolean
  file: string
}

/** fontconfig's numeric weight scale mapped to the CSS weights. */
const FC_WEIGHT_BUCKETS: ReadonlyArray<readonly [number, number]> = [
  [0, 100],
  [40, 200],
  [50, 300],
  [80, 400],
  [100, 500],
  [180, 600],
  [200, 700],
  [205, 800],
  [210, 900]
]

/** Nearest CSS weight for a raw fontconfig weight value. */
export function mapFcWeight(weight: number): number {
  let best = FC_WEIGHT_BUCKETS[0]
  for (const bucket of FC_WEIGHT_BUCKETS) {
    if (Math.abs(bucket[0] - weight) < Math.abs(best[0] - weight)) best = bucket
  }
  return best[1]
}

/**
 * Parses `fc-list -f '%{family[0]}|%{style[0]}|%{weight}|%{file}\n'` output.
 * Italic and oblique faces are flagged as `italic`, malformed lines are
 * skipped, weights are mapped to CSS values.
 */
export function parseFcList(output: string): FcFontFace[] {
  const faces: FcFontFace[] = []
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    const [family, style, weight, ...fileParts] = line.split('|')
    const familyName = (family ?? '').trim()
    const file = fileParts.join('|').trim()
    if (familyName === '' || file === '') continue
    const styleName = (style ?? '').toLowerCase()
    const italic = styleName.includes('italic') || styleName.includes('oblique')
    const fcWeight = Number.parseInt(weight ?? '', 10)
    if (!Number.isFinite(fcWeight)) continue
    faces.push({ family: familyName, weight: mapFcWeight(fcWeight), italic, file })
  }
  return faces
}

/** Nearest available weight to the request; ties pick the lower weight so
 * regular text stays regular when 400/700 are equally far. */
export function pickNearestWeight(available: readonly number[], requested: number): number | null {
  let best: number | null = null
  for (const weight of available) {
    if (best === null) {
      best = weight
      continue
    }
    const delta = Math.abs(weight - requested)
    const bestDelta = Math.abs(best - requested)
    if (delta < bestDelta || (delta === bestDelta && weight < best)) best = weight
  }
  return best
}

export interface SystemFontIndexDeps {
  loadFaces: () => Promise<FcFontFace[]>
  readBytes: (filePath: string) => Promise<Uint8Array>
}

function defaultDeps(): SystemFontIndexDeps {
  return {
    loadFaces: async () => {
      const { stdout } = await execFileAsync(
        'fc-list',
        ['-f', '%{family[0]}|%{style[0]}|%{weight}|%{file}\n'],
        { maxBuffer: 16 * 1024 * 1024 }
      )
      return parseFcList(stdout)
    },
    readBytes: (filePath) => readFile(filePath)
  }
}

/**
 * Installed fonts through fontconfig, enumerated lazily once per session and
 * cached. Systems without `fc-list` (Windows, macOS) enumerate as empty; the
 * bundled Noto Sans remains the guaranteed fallback everywhere.
 */
export class SystemFontIndex {
  private readonly deps: SystemFontIndexDeps
  private facesPromise: Promise<FcFontFace[]> | null = null

  constructor(deps: SystemFontIndexDeps = defaultDeps()) {
    this.deps = deps
  }

  private faces(): Promise<FcFontFace[]> {
    this.facesPromise ??= this.deps.loadFaces().catch((error: unknown) => {
      console.warn('OpenAnimator: system font enumeration failed', error)
      return []
    })
    return this.facesPromise
  }

  async list(): Promise<SystemFont[]> {
    const byFamily = new Map<string, Set<number>>()
    for (const face of await this.faces()) {
      let weights = byFamily.get(face.family)
      if (!weights) {
        weights = new Set()
        byFamily.set(face.family, weights)
      }
      weights.add(face.weight)
    }
    return [...byFamily.entries()]
      .map(([family, weights]) => ({ family, weights: [...weights].sort((a, b) => a - b) }))
      .sort((a, b) => a.family.localeCompare(b.family))
  }

  /** Raw bytes of the face nearest to (family, weight, style), or null when
   * the family has no matching face or its file cannot be read. */
  async read(family: string, weight: number, italic = false): Promise<Uint8Array | null> {
    const key = family.trim().toLowerCase()
    const candidates = (await this.faces()).filter(
      (face) => face.family.toLowerCase() === key && face.italic === italic
    )
    if (candidates.length === 0) return null
    const chosen = pickNearestWeight(
      candidates.map((face) => face.weight),
      weight
    )
    if (chosen === null) return null
    const face = candidates.find((candidate) => candidate.weight === chosen)
    if (!face) return null
    try {
      return await this.deps.readBytes(face.file)
    } catch (error) {
      console.warn('OpenAnimator: font file could not be read', error)
      return null
    }
  }
}

/**
 * Font embedding policy store: a JSON file in the application's user-data
 * directory listing extra allow rules and deny patterns, merged over the
 * built-in redistributable-families allowlist. Invalid entries are skipped;
 * a missing or corrupted file reads as the built-in defaults.
 */
export class FontPolicyStore {
  private readonly filePath: string

  constructor(baseDir: string) {
    this.filePath = join(baseDir, 'font-embedding.json')
  }

  async effective(): Promise<FontEmbeddingPolicy> {
    const user = await this.loadUserRules()
    const seen = new Set<string>()
    const allow: FontEmbeddingRule[] = []
    // User rules come first so they can override a built-in license label;
    // deduplication keeps the effective list free of shadowed patterns.
    for (const rule of [...(user?.allow ?? []), ...DEFAULT_EMBEDDING_ALLOWLIST]) {
      const pattern = rule.pattern.trim()
      const key = pattern.toLowerCase()
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      allow.push({ pattern, license: rule.license })
    }
    return { allow, deny: user?.deny ?? [] }
  }

  private async loadUserRules(): Promise<{ allow: FontEmbeddingRule[]; deny: string[] } | null> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'))
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null) return null
    const source = parsed as { allow?: unknown; deny?: unknown }
    const allow: FontEmbeddingRule[] = []
    if (Array.isArray(source.allow)) {
      for (const entry of source.allow) {
        if (typeof entry !== 'object' || entry === null) continue
        const rule = entry as { pattern?: unknown; license?: unknown }
        if (typeof rule.pattern !== 'string' || typeof rule.license !== 'string') continue
        if (rule.pattern.trim() === '' || rule.license.trim() === '') continue
        allow.push({ pattern: rule.pattern, license: rule.license.trim() })
      }
    }
    const deny: string[] = []
    if (Array.isArray(source.deny)) {
      for (const entry of source.deny) {
        if (typeof entry === 'string' && entry.trim() !== '') deny.push(entry.trim())
      }
    }
    return { allow, deny }
  }
}

/** Registers the IPC handlers for system font enumeration and the font
 * embedding policy, backed by fontconfig and the user-data policy file. */
export function registerFontHandlers(): void {
  const index = new SystemFontIndex()
  const store = new FontPolicyStore(app.getPath('userData'))
  ipcMain.handle(FONT_LIST_CHANNEL, (): Promise<SystemFont[]> => index.list())
  ipcMain.handle(
    FONT_READ_CHANNEL,
    async (_event, family: unknown, weight: unknown, italic: unknown): Promise<FontReadResult> => {
      if (typeof family !== 'string' || family.trim() === '' || typeof weight !== 'number' || !Number.isFinite(weight)) {
        return { ok: false, error: 'readSystemFont: family must be a name and weight a finite number' }
      }
      const style = italic === true
      const bytes = await index.read(family, weight, style)
      if (!bytes) {
        return {
          ok: false,
          error: `no installed ${style ? 'italic ' : ''}face covers "${family}" near weight ${Math.round(weight)}`
        }
      }
      return { ok: true, bytes }
    }
  )
  ipcMain.handle(FONT_POLICY_CHANNEL, (): Promise<FontEmbeddingPolicy> => store.effective())
}
