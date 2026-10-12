import { readFile } from 'node:fs/promises'
import process from 'node:process'

import { documentDuration } from '../shared/document'
import {
  exportFrameCount,
  exportPixelSize,
  sanitizeExportOptions
} from '../shared/exportOptions'
import type { ExportFormat } from '../shared/exportOptions'
import { validateDocumentPayload, validateScriptPayload } from '../shared/scripting/commands'
import {
  createResourceResolver,
  extensionToFormat,
  loadDocumentAndResources,
  renderToFile,
  withEmbeddedFontFiles
} from './render'

/**
 * OpenAnimator headless CLI. Run via `npm run cli -- <command>` (or the
 * `bin/openanimator.mjs` shim):
 *
 *   render <project.oanim|document.json> --out <file> [--format f] [--scale s]
 *          [--fps n] [--from N] [--to N] [--transparent]
 *   validate <payload.json> [--kind commands|document]
 *
 * Exit code 0 on success, 1 with a message on failure — the machine surface
 * for the validate-and-retry flow.
 */

const USAGE = `OpenAnimator CLI

Commands:
  render <project.oanim|document.json> --out <file>
      [--format png-sequence|gif|webm|mp4|lottie|dotlottie|svg-animation|spritesheet]
                                            default: from the --out extension
                                            (.json → lottie, .lottie → dotLottie,
                                            .svg → animated SVG; spritesheet
                                            requires --format spritesheet)
      [--scale 0.25..4]                     resolution multiplier (default 1;
                                            the Lottie formats ignore it)
      [--fps 1..60]                         output fps (default: document fps)
      [--from N] [--to N]                   0-based inclusive frame range (default: full document)
      [--transparent]                       alpha for png-sequence/gif/spritesheet/
                                            lottie/dotlottie/svg-animation and webm
                                            (VP9 alpha); MP4 is always opaque
  validate <payload.json> [--kind commands|document]
                                            prints schema errors, exit 1 on invalid
  help                                      this message

Lottie, dotLottie and animated-SVG exports are built natively (no ffmpeg);
video and audio mixdown need ffmpeg on PATH.
`

interface CliArgs {
  positional: string[]
  flags: Map<string, string | boolean>
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = []
  const flags = new Map<string, string | boolean>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next)
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

function numberFlag(flags: CliArgs['flags'], key: string): number | undefined {
  const value = flags.get(key)
  if (typeof value !== 'string') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function runRender(args: CliArgs): Promise<string> {
  const input = args.positional[0]
  const outPath = args.flags.get('out')
  if (!input || typeof outPath !== 'string') {
    throw new Error(`Usage: render <project.oanim|document.json> --out <file>\n${USAGE}`)
  }
  const { document, resources } = await loadDocumentAndResources(input)
  const formatFlag = args.flags.get('format')
  const format =
    typeof formatFlag === 'string' ? (formatFlag as ExportFormat) : extensionToFormat(outPath)
  const options = sanitizeExportOptions(
    {
      format,
      scale: numberFlag(args.flags, 'scale'),
      fps: numberFlag(args.flags, 'fps'),
      fromFrame: numberFlag(args.flags, 'from') ?? 0,
      toFrame: numberFlag(args.flags, 'to') ?? documentDuration(document) - 1,
      transparent: Boolean(args.flags.get('transparent'))
    },
    document
  )
  const outcome = await withEmbeddedFontFiles(document, resources, (fontFiles) =>
    renderToFile(
      document,
      options,
      createResourceResolver(resources),
      outPath,
      fontFiles,
      undefined,
      resources
    )
  )
  const size = exportPixelSize(document, options)
  let summary = `Wrote ${outPath} — ${exportFrameCount(options)} frame(s) ${size.width}x${size.height} at ${options.fps} fps`
  const diagnostics = outcome.diagnostics ?? []
  if (diagnostics.length > 0) {
    summary += ` (${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'})`
    for (const message of diagnostics) summary += `\n  - ${message}`
  }
  return summary
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
    return 'Document payload is valid against the v6 schema.'
  }
  const { commands, errors } = validateScriptPayload(raw)
  if (errors.length > 0) throw new Error(`Schema errors (${errors.length}):\n${errors.join('\n')}`)
  return `Command payload is valid — ${commands.length} command(s).`
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
    } else {
      throw new Error(`Unknown command "${command}"\n${USAGE}`)
    }
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}

void main()
