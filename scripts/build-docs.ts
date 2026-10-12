import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Marked } from 'marked'
import type { Tokens } from 'marked'

import { renderSchemaJson, schemaFileName } from '../src/cli/schema'
import { renderScriptingReference } from '../src/shared/scripting/referenceMarkdown'
import { renderShortcutMarkdown } from '../src/shared/shortcuts'

/**
 * Builds the GitHub Pages documentation site into `site/` (gitignored):
 *
 * 1. Regenerates `docs/scripting-reference.md` from `COMMANDS_SCHEMA` and the
 *    field metadata and `docs/shortcuts.md` from the shortcut table — the same
 *    functions the drift unit tests compare against, so the committed files
 *    cannot go stale.
 * 2. Renders every page (README, the `docs/*.md` guides, CONTRIBUTING) to
 *    static HTML with one shared template and nav.
 * 3. Copies the stylesheet, the sample projects/previews and the JSON
 *    schemas (`schemas/commands-v1.json`, `schemas/document-v7.json`) into
 *    the site so everything is downloadable from one place.
 *
 * tsx runs this file as CommonJS: `__dirname`, no `import.meta`.
 */

const ROOT = join(__dirname, '..')
const SITE_DIR = join(ROOT, 'site')

interface Page {
  /** Nav label; also the fallback page title. */
  label: string
  /** Markdown source, relative to the repository root. */
  source: string
  /** Output file name inside `site/`. */
  out: string
}

const PAGES: Page[] = [
  { label: 'Home', source: 'README.md', out: 'index.html' },
  { label: 'Getting started', source: 'docs/getting-started.md', out: 'getting-started.html' },
  { label: 'Features', source: 'docs/features.md', out: 'features.html' },
  { label: 'Scripting', source: 'docs/scripting.md', out: 'scripting.html' },
  { label: 'Reference', source: 'docs/scripting-reference.md', out: 'reference.html' },
  { label: 'Shortcuts', source: 'docs/shortcuts.md', out: 'shortcuts.html' },
  { label: 'Export formats', source: 'docs/export-formats.md', out: 'export-formats.html' },
  { label: 'SVG import', source: 'docs/svg-import.md', out: 'svg-import.html' },
  { label: 'Fonts', source: 'docs/font-embedding.md', out: 'fonts.html' },
  { label: 'Gallery', source: 'docs/gallery.md', out: 'gallery.html' },
  { label: 'Roadmap', source: 'docs/roadmap.md', out: 'roadmap.html' },
  { label: 'Contributing', source: 'CONTRIBUTING.md', out: 'contributing.html' }
]

/** Cross-document `.md` hrefs → site page. Both the root-relative and the
 * `docs/`-relative spelling of every source is mapped. */
const LINK_MAP = new Map<string, string>()
for (const page of PAGES) {
  LINK_MAP.set(page.source, page.out)
  if (page.source.startsWith('docs/')) {
    LINK_MAP.set(page.source.slice('docs/'.length), page.out)
  }
}

function rewriteHref(href: string): string {
  const hashIndex = href.indexOf('#')
  const path = (hashIndex === -1 ? href : href.slice(0, hashIndex)).replace(/^\.\//, '')
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex)
  if (path === '' || /^[a-z][a-z0-9+.-]*:/i.test(path)) return href
  const mapped = LINK_MAP.get(path)
  return mapped ? `${mapped}${hash}` : href
}

/** GitHub-style heading anchor: lowercase, punctuation dropped, spaces → `-`. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const marked = new Marked({
  renderer: {
    heading({ tokens, depth }: Tokens.Heading): string {
      const text = this.parser.parseInline(tokens)
      const plain = text.replace(/<[^>]+>/g, '')
      return `<h${depth} id="${slugify(plain)}">${text}</h${depth}>\n`
    }
  }
})
marked.use({
  walkTokens(token) {
    if (token.type === 'link') token.href = rewriteHref(token.href)
  }
})

/** First `# ` heading of the markdown, backticks stripped; fallback: `label`. */
function titleOf(markdown: string, label: string): string {
  const match = /^# (.+)$/m.exec(markdown)
  if (!match) return label
  return match[1].replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim() || label
}

const BRAND = 'OpenAnimator'

function renderPage(page: Page, title: string, body: string): string {
  const nav = PAGES.map(
    (entry) =>
      `        <a href="${entry.out}"${entry.out === page.out ? ' class="active"' : ''}>${entry.label}</a>`
  ).join('\n')
  const fullTitle = title === BRAND ? BRAND : `${title} — ${BRAND}`
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(fullTitle)}</title>
    <link rel="stylesheet" href="assets/site.css" />
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="index.html">OpenAnimator</a>
      <nav class="site-nav">
${nav}
      </nav>
    </header>
    <main>
${body}
    </main>
    <footer class="site-footer">
      <p>
        OpenAnimator — an open-source vector animation tool for the desktop.
        <a href="https://github.com/DidierHoarau/OpenAnimator">Source, releases and issues on GitHub</a>.
      </p>
    </footer>
  </body>
</html>
`
}

async function copySamples(): Promise<void> {
  const sourceDir = join(ROOT, 'docs/samples')
  const targetDir = join(SITE_DIR, 'samples')
  await mkdir(targetDir, { recursive: true })
  const entries = await readdir(sourceDir)
  for (const entry of entries) {
    await copyFile(join(sourceDir, entry), join(targetDir, entry))
  }
  console.log(`site/samples/ (${entries.length} files)`)
}

async function writeSchemas(): Promise<void> {
  const targetDir = join(SITE_DIR, 'schemas')
  await mkdir(targetDir, { recursive: true })
  for (const kind of ['commands', 'document'] as const) {
    const name = schemaFileName(kind)
    await writeFile(join(targetDir, name), renderSchemaJson(kind))
    console.log(`site/schemas/${name}`)
  }
}

async function main(): Promise<void> {
  // 1. Regenerate the committed generated docs in place.
  await writeFile(join(ROOT, 'docs/scripting-reference.md'), renderScriptingReference())
  console.log('docs/scripting-reference.md regenerated')
  await writeFile(join(ROOT, 'docs/shortcuts.md'), renderShortcutMarkdown())
  console.log('docs/shortcuts.md regenerated')

  // 2. Render every page.
  await rm(SITE_DIR, { recursive: true, force: true })
  await mkdir(join(SITE_DIR, 'assets'), { recursive: true })
  await copyFile(join(ROOT, 'docs/assets/site.css'), join(SITE_DIR, 'assets/site.css'))
  for (const page of PAGES) {
    const markdown = await readFile(join(ROOT, page.source), 'utf8')
    const body = await marked.parse(markdown)
    await writeFile(join(SITE_DIR, page.out), renderPage(page, titleOf(markdown, page.label), body))
    console.log(`site/${page.out}`)
  }

  // 3. Ship the downloadable artifacts alongside the pages.
  await copySamples()
  await writeSchemas()
}

void main()
