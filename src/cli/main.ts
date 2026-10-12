import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import process from 'node:process'

import { documentDuration } from '../shared/document'
import {
  exportExtension,
  exportFrameCount,
  exportPixelSize,
  sanitizeExportOptions,
  EXPORT_FORMATS
} from '../shared/exportOptions'
import type { ExportFormat, ExportOptions } from '../shared/exportOptions'
import { validateDocumentPayload, validateScriptPayload } from '../shared/scripting/commands'
import {
  createResourceResolver,
  extensionToFormat,
  loadDocumentAndResources,
  renderToFile,
  withEmbeddedFontFiles
} from './render'
import { renderSchemaJson, schemaFileName } from './schema'
import type { SchemaKind } from './schema'

/**
 * OpenAnimator headless CLI. Run via `npm run cli -- <command>` (or the
 * `bin/openanimator.mjs` shim):
 *
 *   render <project.oanim|document.json> --out <file|directory>
 *          [--format f]... [--scale s] [--fps n] [--from N] [--to N]
 *          [--transparent] [--gif-palette p] [--gif-dither] [--gif-loop n]
 *          [--quality tier]
 *   validate <payload.json> [--kind commands|document]
 *   schema [--kind commands|document] [--out file]
 *
 * Exit code 0 on success, 1 with a message on failure — the machine surface
 * for the validate-and-retry flow.
 */

const USAGE = `OpenAnimator CLI

Commands:
  render <project.oanim|document.json> --out <file|directory>
      [--format png-sequence|gif|webm|mp4|lottie|dotlottie|svg-animation|spritesheet]
                                            output format; repeat the flag to
                                            render several formats into the
                                            --out directory (e.g. --format gif
                                            --format lottie). Default: from the
                                            --out extension (.json → lottie,
                                            .lottie → dotLottie, .svg → animated
                                            SVG; spritesheet requires --format
                                            spritesheet)
      [--scale 0.25..4]                     resolution multiplier (default 1;
                                            the Lottie formats ignore it)
      [--fps 1..60]                         output fps (default: document fps)
      [--from N] [--to N]                   0-based inclusive frame range (default: full document)
      [--transparent]                       alpha for png-sequence/gif/spritesheet/
                                            lottie/dotlottie/svg-animation and webm
                                            (VP9 alpha); MP4 is always opaque
      [--gif-palette perFrame|global]       GIF color strategy (default perFrame)
      [--gif-dither]                        Floyd–Steinberg dithering for GIF
      [--gif-loop N]                        GIF loop count: 0 = forever (default),
                                            -1 = play once, N = repeat N times
      [--quality low|medium|high]           MP4/WebM quality tier (default high)
  validate <payload.json> [--kind commands|document]
                                            prints schema errors, exit 1 on invalid
  schema [--kind commands|document] [--out file]
                                            prints the JSON Schema (draft-07) to
                                            stdout, or writes it to --out
  help                                      this message

Lottie, dotLottie and animated-SVG exports are built natively (no ffmpeg);
video and audio mixdown need ffmpeg on PATH.
`

type FlagValue = string | boolean | string[]

interface CliArgs {
  positional: string[]
  flags: Map<string, FlagValue>
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = []
  const flags = new Map<string, FlagValue>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        // Repeated value flags accumulate (e.g. --format gif --format lottie).
        const existing = flags.get(key)
        if (typeof existing === 'string') flags.set(key, [existing, next])
        else if (Array.isArray(existing)) existing.push(next)
        else flags.set(key, next)
        index += 1
      } else {
        flags.set(key, true)
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

function stringFlag(flags: CliArgs['flags'], key: string): string | undefined {
  const value = flags.get(key)
  return typeof value === 'string' ? value : undefined
}

/** Every occurrence of a value flag, in command-line order. */
function stringFlags(flags: CliArgs['flags'], key: string): string[] {
  const value = flags.get(key)
  if (value === undefined || typeof value === 'boolean') return []
  return Array.isArray(value) ? value : [value]
}

function booleanFlag(flags: CliArgs['flags'], key: string): boolean {
  return flags.has(key)
}

function numberFlag(flags: CliArgs['flags'], key: string): number | undefined {
  const value = stringFlag(flags, key)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function runRender(args: CliArgs): Promise<string> {
  const input = args.positional[0]
  const outPath = stringFlag(args.flags, 'out')
  if (!input || outPath === undefined) {
    throw new Error(`Usage: render <project.oanim|document.json> --out <file|directory>\n${USAGE}`)
  }
  // --format may be repeated: several formats render into the --out directory.
  const formatFlags = stringFlags(args.flags, 'format')
  let formats: ExportFormat[]
  if (formatFlags.length > 0) {
    for (const raw of formatFlags) {
      if (!EXPORT_FORMATS.some((entry) => entry.format === raw)) {
        throw new Error(
          `Unknown --format "${raw}". Valid formats: ${EXPORT_FORMATS.map((entry) => entry.format).join(', ')}`
        )
      }
    }
    formats = formatFlags as ExportFormat[]
  } else {
    const derived = extensionToFormat(outPath)
    if (!derived) {
      throw new Error(
        `Cannot derive the output format from "${outPath}"; pass --format with one of: ${EXPORT_FORMATS.map((entry) => entry.format).join(', ')}`
      )
    }
    formats = [derived]
  }
  const { document, resources } = await loadDocumentAndResources(input)
  const multi = formats.length > 1
  if (multi) await mkdir(outPath, { recursive: true })
  const inputBase = basename(input, extname(input))
  return withEmbeddedFontFiles(document, resources, async (fontFiles) => {
    const summaries: string[] = []
    for (const format of formats) {
      const options = sanitizeExportOptions(
        {
          format,
          scale: numberFlag(args.flags, 'scale'),
          fps: numberFlag(args.flags, 'fps'),
          fromFrame: numberFlag(args.flags, 'from') ?? 0,
          toFrame: numberFlag(args.flags, 'to') ?? documentDuration(document) - 1,
          transparent: booleanFlag(args.flags, 'transparent'),
          gifPalette: stringFlag(args.flags, 'gif-palette') as ExportOptions['gifPalette'],
          gifDither: booleanFlag(args.flags, 'gif-dither'),
          gifLoop: numberFlag(args.flags, 'gif-loop'),
          videoQuality: stringFlag(args.flags, 'quality') as ExportOptions['videoQuality']
        },
        document
      )
      const target = multi ? join(outPath, `${inputBase}.${exportExtension(format)}`) : outPath
      const outcome = await renderToFile(
        document,
        options,
        createResourceResolver(resources),
        target,
        fontFiles,
        undefined,
        resources
      )
      const size = exportPixelSize(document, options)
      let summary = `Wrote ${target} — ${exportFrameCount(options)} frame(s) ${size.width}x${size.height} at ${options.fps} fps`
      const diagnostics = outcome.diagnostics ?? []
      if (diagnostics.length > 0) {
        summary += ` (${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'})`
        for (const message of diagnostics) summary += `\n  - ${message}`
      }
      summaries.push(summary)
    }
    return summaries.join('\n')
  })
}

async function runValidate(args: CliArgs): Promise<string> {
  const input = args.positional[0]
  if (!input) {
    throw new Error(`Usage: validate <payload.json> [--kind commands|document]\n${USAGE}`)
  }
  const raw: unknown = JSON.parse(await readFile(input, 'utf8'))
  if (args.flags.get('kind') === 'document') {
    const { valid, errors } = validateDocumentPayload(raw)
    if (!valid) throw new Error(`Schema errors (${errors.length}):\n${errors.join('\n')}`)
    return 'Document payload is valid against the v7 schema.'
  }
  const { commands, errors } = validateScriptPayload(raw)
  if (errors.length > 0) throw new Error(`Schema errors (${errors.length}):\n${errors.join('\n')}`)
  return `Command payload is valid — ${commands.length} command(s).`
}

async function runSchema(args: CliArgs): Promise<string> {
  const kindFlag = args.flags.get('kind')
  if (kindFlag !== undefined && kindFlag !== 'commands' && kindFlag !== 'document') {
    throw new Error(`--kind must be "commands" or "document".\n${USAGE}`)
  }
  const kind: SchemaKind = kindFlag === 'document' ? 'document' : 'commands'
  const json = renderSchemaJson(kind)
  const outPath = args.flags.get('out')
  if (typeof outPath === 'string') {
    await writeFile(outPath, json, 'utf8')
    return `Wrote ${outPath} (${json.length} bytes, ${schemaFileName(kind)}).`
  }
  process.stdout.write(json)
  return ''
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  try {
    if (!command || command === 'help' || command === '--help') {
      process.stdout.write(USAGE)
      return
    }
    const args = parseArgs(rest)
    if (command === 'render') {
      process.stdout.write(`${await runRender(args)}\n`)
    } else if (command === 'validate') {
      process.stdout.write(`${await runValidate(args)}\n`)
    } else if (command === 'schema') {
      const summary = await runSchema(args)
      if (summary !== '') process.stdout.write(`${summary}\n`)
    } else {
      throw new Error(`Unknown command "${command}"\n${USAGE}`)
    }
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}

void main()
