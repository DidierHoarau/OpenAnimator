import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { unzipSync, strFromU8 } from 'fflate'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLottieRenderHarness } from '../test-utils/lottieRender'

import { closeApp, dismissStartup, launchApp } from './helpers'
import type { DialogPatches } from './helpers'

/**
 * Interchange golden path: an SVG carrying a linear and a radial gradient is
 * imported as editable vectors, a scripted gradient node is animated, the
 * document is exported as dotLottie through the script console's export
 * bridge, and the archive is validated twice — structurally (the `gf` items
 * carry the expected stops and keyframes) and visually (the real lottie-web
 * player renders start/mid/end frames from the baked keys, not flat fills).
 */

/** The SVG import source: a horizontal linear gradient with a 50% alpha stop
 * and a centered radial gradient, painted onto a rect and a circle. */
const SVG_SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160">' +
  '<defs>' +
  '<linearGradient id="sky" x1="0" y1="0" x2="1" y2="0">' +
  '<stop offset="0" stop-color="#ff0000"/>' +
  '<stop offset="1" stop-color="#0000ff" stop-opacity="0.5"/>' +
  '</linearGradient>' +
  '<radialGradient id="spot" cx="0.5" cy="0.5" r="0.5">' +
  '<stop offset="0" stop-color="#ffff00"/>' +
  '<stop offset="1" stop-color="#00ff00"/>' +
  '</radialGradient>' +
  '</defs>' +
  '<rect x="20" y="20" width="200" height="60" fill="url(#sky)"/>' +
  '<circle cx="120" cy="120" r="30" fill="url(#spot)"/>' +
  '</svg>'

/** Stops of the scripted node: distinct colors so its gradient fill is
 * unambiguous in the archive and in the rendered SVG. */
const SCRIPTED_STOPS = [
  { offset: 0, color: '#22d3ee' },
  { offset: 1, color: '#7c2d12' }
]

let app: ElectronApplication | undefined
let launchedPage: Page | undefined

test.afterEach(async () => {
  if (app && launchedPage) await closeApp(app, launchedPage)
  app = undefined
  launchedPage = undefined
})

async function start(patches: DialogPatches = {}): Promise<Page> {
  const launched = await launchApp(patches)
  app = launched.app
  launchedPage = launched.page
  return launched.page
}

function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'openanimator-e2e-'))
}

interface ValueChannel {
  a: number
  k: number[] | Array<{ t: number; s: number[] }>
}

interface GradientFillItem {
  ty: string
  t: number
  s: ValueChannel
  e: ValueChannel
  g: { p: number; k: ValueChannel }
}

/** Every `gf` (gradient fill) item in the archive, at any nesting depth. */
function collectGradientFills(value: unknown, found: GradientFillItem[] = []): GradientFillItem[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectGradientFills(entry, found)
    return found
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.ty === 'gf') found.push(record as unknown as GradientFillItem)
    for (const entry of Object.values(record)) collectGradientFills(entry, found)
  }
  return found
}

/** Static stop values `[offset, r, g, b, …]` of a gradient fill item. */
function stopsOf(fill: GradientFillItem): number[] {
  const channel = fill.g.k
  if (channel.a !== 0 || !Array.isArray(channel.k) || typeof channel.k[0] !== 'number') {
    throw new Error('expected a static gradient stop channel')
  }
  return channel.k as number[]
}

function keysOf(channel: ValueChannel): Array<{ t: number; s: number[] }> {
  if (channel.a !== 1 || !Array.isArray(channel.k)) {
    throw new Error('expected a keyed gradient channel')
  }
  return channel.k as Array<{ t: number; s: number[] }>
}

function arraysClose(actual: number[], expected: number[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => Math.abs(value - expected[index]) <= 1e-6)
  )
}

/** The `<linearGradient …>` element (attributes plus stops) whose markup
 * contains `needle`, e.g. one stop color. */
function gradientTagWithStopColor(markup: string, needle: string): string {
  const chunks = markup.split('<linearGradient').slice(1)
  for (const chunk of chunks) {
    const tag = '<linearGradient' + chunk.slice(0, chunk.indexOf('</linearGradient>'))
    if (tag.includes(needle)) return tag
  }
  throw new Error(`no <linearGradient> containing ${needle} in the rendered markup`)
}

function numericAttr(tag: string, name: string): number {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  if (!match) throw new Error(`attribute ${name} is missing on ${tag}`)
  return Number(match[1])
}

test('imports an SVG with gradients, animates and exports a gradient Lottie that renders in lottie-web', async () => {
  const dir = await tempDir()
  const svgPath = join(dir, 'gradients.svg')
  const lottiePath = join(dir, 'scene.lottie')
  await writeFile(svgPath, SVG_SOURCE, 'utf8')
  const page = await start({ openPath: svgPath, savePath: lottiePath })
  await dismissStartup(page)

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect(page.locator('footer.statusbar')).toContainText('file: unsaved')

  // Import the SVG through the toolbar (the patched open dialog returns the
  // file written above); the vector importer converts it to gradient nodes.
  await page.getByRole('button', { name: 'Import Image…', exact: true }).click()

  // Stage: both gradients became native paints and both shapes render with
  // `url(#…)` fills through the stage's `<defs>`.
  const stage = page.locator('svg.stage')
  await expect(stage.locator('.stage__content rect[fill^="url(#"]')).toHaveCount(1)
  await expect(stage.locator('.stage__content ellipse[fill^="url(#"]')).toHaveCount(1)
  const linear = stage.locator('defs linearGradient')
  await expect(linear).toHaveCount(1)
  await expect(linear).toHaveAttribute('x1', '0')
  await expect(linear).toHaveAttribute('y1', '0.5')
  await expect(linear).toHaveAttribute('x2', '1')
  await expect(linear).toHaveAttribute('y2', '0.5')
  const linearStops = linear.locator('stop')
  await expect(linearStops).toHaveCount(2)
  await expect(linearStops.nth(0)).toHaveAttribute('offset', '0')
  await expect(linearStops.nth(0)).toHaveAttribute('stop-color', '#ff0000')
  await expect(linearStops.nth(1)).toHaveAttribute('offset', '1')
  await expect(linearStops.nth(1)).toHaveAttribute('stop-color', '#0000ff')
  await expect(linearStops.nth(1)).toHaveAttribute('stop-opacity', '0.5')
  const radial = stage.locator('defs radialGradient')
  await expect(radial).toHaveCount(1)
  await expect(radial).toHaveAttribute('cx', '0.5')
  await expect(radial).toHaveAttribute('cy', '0.5')
  await expect(radial).toHaveAttribute('r', '0.5')
  const radialStops = radial.locator('stop')
  await expect(radialStops).toHaveCount(2)
  await expect(radialStops.nth(0)).toHaveAttribute('stop-color', '#ffff00')
  await expect(radialStops.nth(1)).toHaveAttribute('stop-color', '#00ff00')
  const importedRect = stage.locator('.stage__content rect[fill^="url(#"]')
  await expect(importedRect).toHaveAttribute('width', '200')
  await expect(importedRect).toHaveAttribute('height', '60')
  const importedEllipse = stage.locator('.stage__content ellipse[fill^="url(#"]')
  await expect(importedEllipse).toHaveAttribute('rx', '30')
  await expect(importedEllipse).toHaveAttribute('ry', '30')

  // Animate a gradient node through the script console and export the
  // document as dotLottie; `out` exercises the console's export bridge (no
  // save dialog).
  const payload = {
    commands: [
      { op: 'setDuration', frames: 13 },
      { op: 'addLayer', kind: 'object', name: 'Gradient' },
      {
        op: 'addNode',
        frame: 0,
        node: {
          type: 'primitive',
          primitive: 'rect',
          id: 'grad-rect',
          name: 'GradRect',
          width: 160,
          height: 120,
          center: { x: 480, y: 270 },
          rotation: 0,
          opacity: 1,
          fill: { type: 'linear', angle: 0, stops: SCRIPTED_STOPS }
        }
      },
      { op: 'setTween', frame: 0, easing: 'linear' },
      {
        op: 'updateNode',
        nodeId: 'grad-rect',
        frame: 12,
        patch: { fill: { type: 'linear', angle: 90, stops: SCRIPTED_STOPS } }
      },
      { op: 'export', format: 'dotlottie', out: lottiePath, fromFrame: 0, toFrame: 12 }
    ]
  }
  await page.getByRole('button', { name: 'Script…', exact: true }).click()
  const scriptModal = page.locator('.script-modal')
  await expect(scriptModal).toBeVisible()
  await scriptModal.locator('.script-input').fill(JSON.stringify(payload))
  await scriptModal.getByRole('button', { name: 'Run script' }).click()
  const output = scriptModal.locator('.script-output')
  await expect(output).toContainText('Applied 6 of 6 command(s)')
  await expect(output).toContainText('export: exported to')
  await expect(output).not.toContainText('[error]')
  await scriptModal.locator('.modal-close').click()
  await expect(scriptModal).toHaveCount(0)

  await expect
    .poll(
      async () => {
        try {
          return (await readFile(lottiePath)).length
        } catch {
          return 0
        }
      },
      { timeout: 45_000, message: 'the dotLottie export should be written' }
    )
    .toBeGreaterThan(0)

  // Archive: the imported gradients export as static `gf` items carrying the
  // SVG stops (alpha folded into the trailing stop-opacity section), and the
  // scripted gradient exports as an item whose geometry is keyed per output
  // frame (the stops themselves stay static).
  const archive = unzipSync(new Uint8Array(await readFile(lottiePath)))
  expect(Object.keys(archive).sort()).toEqual(['animations/animation.json', 'manifest.json'])
  const animationData = JSON.parse(strFromU8(archive['animations/animation.json'])) as Record<
    string,
    unknown
  >
  const fills = collectGradientFills(animationData)

  const importedLinear = fills.find(
    (fill) => fill.t === 1 && arraysClose(stopsOf(fill), [0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0.5])
  )
  expect(importedLinear, 'the imported linear gradient stops should export').toBeTruthy()
  expect(importedLinear!.g.p).toBe(2)

  const importedRadialFill = fills.find(
    (fill) => fill.t === 2 && arraysClose(stopsOf(fill), [0, 1, 1, 0, 1, 0, 1, 0])
  )
  expect(importedRadialFill, 'the imported radial gradient stops should export').toBeTruthy()
  expect(importedRadialFill!.g.p).toBe(2)

  const scripted = fills.find((fill) => fill.s.a === 1)
  expect(scripted, 'the animated gradient should export keyed geometry').toBeTruthy()
  expect(scripted!.t).toBe(1)
  expect(scripted!.g.p).toBe(2)
  // #22d3ee → #7c2d12 as round4 channel fractions, no alpha section.
  expect(arraysClose(stopsOf(scripted!), [0, 0.1333, 0.8275, 0.9333, 1, 0.4863, 0.1765, 0.0706])).toBe(
    true
  )
  const startKeys = keysOf(scripted!.s)
  const endKeys = keysOf(scripted!.e)
  expect(startKeys).toHaveLength(13)
  expect(endKeys).toHaveLength(13)
  // Frames 0/6/12 of the angle 0 → 90 tween: -80..80, ±45° geometry, 0..±60.
  expect(startKeys[0].t).toBe(0)
  expect(startKeys[0].s[0]).toBeCloseTo(-80, 6)
  expect(startKeys[0].s[1]).toBeCloseTo(0, 6)
  expect(endKeys[0].s[0]).toBeCloseTo(80, 6)
  expect(startKeys[6].s[0]).toBeCloseTo(-56.5685, 3)
  expect(startKeys[6].s[1]).toBeCloseTo(-42.4264, 3)
  expect(startKeys[12].t).toBe(12)
  expect(startKeys[12].s[0]).toBeCloseTo(0, 6)
  expect(startKeys[12].s[1]).toBeCloseTo(-60, 6)
  expect(endKeys[12].s[1]).toBeCloseTo(60, 6)

  // Render gate: the real lottie-web player renders the exported archive;
  // start/mid/end frames must show the gradient (with its stops) at the baked
  // geometry — a flat-fill fallback would drop the <linearGradient> entirely.
  const harness = await createLottieRenderHarness()

  const atStart = harness.renderAt(animationData, 0)
  const startTag = gradientTagWithStopColor(atStart, '34,211,238')
  expect(startTag).toContain('stop-color="rgb(34,211,238)"')
  expect(startTag).toContain('stop-color="rgb(124,45,18)"')
  expect(numericAttr(startTag, 'x1')).toBeCloseTo(-80, 1)
  expect(numericAttr(startTag, 'y1')).toBeCloseTo(0, 1)
  expect(numericAttr(startTag, 'x2')).toBeCloseTo(80, 1)
  expect(numericAttr(startTag, 'y2')).toBeCloseTo(0, 1)
  expect(atStart).toMatch(/fill="url\(#/)
  expect(atStart).not.toContain('fill="rgb(34,211,238)"')
  // The imported gradients render too: the linear one keeps its 50% alpha
  // stop, the radial one its stops.
  expect(atStart).toContain('stop-opacity="0.5"')
  expect(atStart).toContain('stop-color="rgb(255,255,0)"')

  const atMid = harness.renderAt(animationData, 6)
  const midTag = gradientTagWithStopColor(atMid, '34,211,238')
  expect(numericAttr(midTag, 'x1')).toBeCloseTo(-56.5685, 1)
  expect(numericAttr(midTag, 'y1')).toBeCloseTo(-42.4264, 1)
  expect(numericAttr(midTag, 'x2')).toBeCloseTo(56.5685, 1)
  expect(numericAttr(midTag, 'y2')).toBeCloseTo(42.4264, 1)
  expect(atMid).not.toContain('fill="rgb(34,211,238)"')

  const atEnd = harness.renderAt(animationData, 12)
  const endTag = gradientTagWithStopColor(atEnd, '34,211,238')
  expect(numericAttr(endTag, 'x1')).toBeCloseTo(0, 1)
  expect(numericAttr(endTag, 'y1')).toBeCloseTo(-60, 1)
  expect(numericAttr(endTag, 'x2')).toBeCloseTo(0, 1)
  expect(numericAttr(endTag, 'y2')).toBeCloseTo(60, 1)
  expect(atEnd).not.toContain('fill="rgb(34,211,238)"')
})
