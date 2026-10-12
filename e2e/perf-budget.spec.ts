/**
 * Deterministic performance regression guard: opens the generated 500-node /
 * 120-frame benchmark project (`perfFixture.ts`) in the built application and
 * measures four interactive paths — full stage re-render on seek, per-move
 * cost of a stage drag, playback frame rate and a 24-frame png-sequence
 * export. Every metric is logged as `perf: <name>=<value><unit>` so the PR
 * body can quote before/after columns from the same spec.
 *
 * The budgets in `PERF_BUDGETS` are exported so later roadmap groups reuse
 * them unchanged; they are calibrated between the pre-change (v0.21.0) and
 * post-change (v0.22.0) measurements from the introducing PR, keeping at
 * least 4× headroom over the post-change number while staying strictly below
 * the pre-change number. Only large regressions fail the gate.
 */
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeApp, dismissStartup, launchApp } from './helpers'
import { generatePerfProject, PERF_FPS, PERF_FRAME_WIDTH, PERF_PROBE_ID } from './perfFixture'

/**
 * Budgets for the generated benchmark (see CONTRIBUTING.md → Performance
 * benchmark). Generous absolute ceilings calibrated from the measurements
 * recorded in the introducing PR (v0.22.0) — a failure here is a large
 * regression (a multiple of the observed cost), never noise: the measured
 * scenario barely differs between v0.21.0 and v0.22.0 on some axes (seek
 * 28→24 ms, drag 44.5→37 ms/move, playback ≈30 fps both, export ≈1.5 s), so
 * tight between-branch splits would flake on slower CI hardware instead of
 * guarding anything.
 */
export const PERF_BUDGETS = {
  /** Seek at frame 60 + full re-render of the 500-node stage, two rAFs settled. */
  fullRenderMs: 200,
  /** Per `pointermove` during a 30-step stage drag (includes its render). */
  dragMsPerMove: 120,
  /** Sustained playback rate: at least this fraction of the document fps. */
  playbackMinFpsRatio: 0.5,
  /** No single inter-frame gap during the playback window exceeds this. */
  playbackMaxGapMs: 250,
  /** Sanity floor for the playback window (not a performance budget). */
  playbackMinTicks: 20,
  /** 24 frames of png-sequence export at 0.5× resolution, file written. */
  export24FramesMs: 15_000
}

let app: ElectronApplication | undefined
let launchedPage: Page | undefined

test.afterEach(async () => {
  if (app && launchedPage) await closeApp(app, launchedPage)
  app = undefined
  launchedPage = undefined
})

function log(name: string, value: number, unit: string): void {
  console.log(`perf: ${name}=${value}${unit}`)
}

/**
 * Seeks through the timeline without a real pointer: the tracks seek by
 * geometry (`clientX` relative to the track), so a synthetic `pointerdown`
 * with a computed `clientX` works for frames beyond the visible strip and
 * behaves identically on the pre-change baseline. Returns the handler +
 * render elapsed time and the frame the app actually reports.
 */
async function seekSynthetic(page: Page, frame: number): Promise<{ elapsedMs: number; frame: number }> {
  return page.evaluate(
    async ([targetFrame, frameWidth]) => {
      const track = document.querySelector<HTMLElement>('.tl-track[data-frames]')
      if (!track) throw new Error('no seekable timeline track')
      const rect = track.getBoundingClientRect()
      const clientX = rect.left + targetFrame * frameWidth + frameWidth / 2
      const clientY = rect.top + rect.height / 2
      const start = performance.now()
      track.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button: 0,
          pointerId: 1
        })
      )
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      const elapsedMs = performance.now() - start
      const text = document.querySelector('footer.statusbar')?.textContent ?? ''
      const match = /frame (\d+) \/ (\d+)/.exec(text)
      return { elapsedMs, frame: match ? Number(match[1]) - 1 : -1 }
    },
    [frame, PERF_FRAME_WIDTH] as const
  )
}

test('meets the performance budgets on the generated 500-node benchmark', async () => {
  test.setTimeout(240_000)
  const dir = await mkdtemp(join(tmpdir(), 'openanimator-perf-'))
  const projectPath = join(dir, 'perf.oanim')
  const exportPath = join(dir, 'perf-export.zip')
  await writeFile(projectPath, generatePerfProject())

  const launched = await launchApp({ openPath: projectPath, savePath: exportPath })
  app = launched.app
  launchedPage = launched.page
  const page = launched.page
  await dismissStartup(page)

  await page.getByRole('button', { name: 'Open…', exact: true }).click()
  await expect(page.locator('footer.statusbar')).toContainText('frame 1 / 120')
  await expect
    .poll(() => page.locator('svg.stage *').count(), { timeout: 30_000 })
    .toBeGreaterThan(400)

  // --- full render: warm-up seek, then a measured seek to frame 60 -------
  await seekSynthetic(page, 55)
  const full = await seekSynthetic(page, 60)
  expect(full.frame).toBe(60)
  log('full-render', Math.round(full.elapsedMs), 'ms')

  // --- drag render: 30 pointer moves of 2 px on the probe node -----------
  // Expand the first layer so the probe's timeline row shows its selection.
  await page.locator('.tl-toggle').first().click()
  const probeRow = page.locator(`.tl-shape-row[data-shape-id="${PERF_PROBE_ID}"]`)
  await expect(probeRow).toBeAttached()
  // The probe is the topmost node of the current layer at the stage center.
  const target = await page.evaluate(() => {
    const svg = document.querySelector<SVGSVGElement>('svg.stage')
    const ctm = svg?.getScreenCTM()
    if (!svg || !ctm) throw new Error('stage is not laid out')
    const point = new DOMPoint(960, 540).matrixTransform(ctm)
    return { x: point.x, y: point.y }
  })
  await page.mouse.move(target.x, target.y)
  await page.evaluate(() => {
    const state = { first: 0, count: 0 }
    ;(window as unknown as { __perfDrag: typeof state }).__perfDrag = state
    document.querySelector('svg.stage')?.addEventListener(
      'pointermove',
      () => {
        if (state.first === 0) state.first = performance.now()
        state.count += 1
      },
      { capture: true }
    )
  })
  await page.mouse.down()
  for (let step = 1; step <= 30; step++) {
    await page.mouse.move(target.x + step * 2, target.y)
  }
  await page.mouse.up()
  const drag = await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
    const state = (window as unknown as { __perfDrag: { first: number; count: number } }).__perfDrag
    return { totalMs: state.first === 0 ? 0 : performance.now() - state.first, moves: state.count }
  })
  expect(drag.moves).toBeGreaterThanOrEqual(30)
  // The press must have grabbed the probe, not run a marquee on empty stage.
  await expect(probeRow).toHaveClass(/selected/)
  const dragMsPerMove = drag.totalMs / 30
  log('drag-render', Math.round(dragMsPerMove * 100) / 100, 'ms/move')

  // Let the post-drag autosave (idle-debounced) complete before sampling
  // playback, so a snapshot write cannot show up as a frame-rate hiccup.
  await page.waitForTimeout(4000)

  // --- playback: rate and worst inter-frame gap over a 2 s window --------
  await seekSynthetic(page, 0)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  const playback = await page.evaluate(async (windowMs) => {
    const el = document.querySelector('footer.statusbar')
    if (!el) throw new Error('no statusbar')
    const ticks: number[] = []
    let last = -1
    const observer = new MutationObserver(() => {
      const match = /frame (\d+) \/ (\d+)/.exec(el.textContent ?? '')
      if (!match) return
      const frame = Number(match[1])
      if (frame === last) return
      last = frame
      ticks.push(performance.now())
    })
    observer.observe(el, { subtree: true, childList: true, characterData: true })
    await new Promise<void>((resolve) => setTimeout(resolve, windowMs))
    observer.disconnect()
    let maxGapMs = 0
    for (let i = 1; i < ticks.length; i++) {
      maxGapMs = Math.max(maxGapMs, ticks[i] - ticks[i - 1])
    }
    const span = ticks.length > 1 ? ticks[ticks.length - 1] - ticks[0] : 0
    return {
      ticks: ticks.length,
      rateFps: span > 0 ? ((ticks.length - 1) / span) * 1000 : 0,
      maxGapMs
    }
  }, 2000)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  log('playback-rate', Math.round(playback.rateFps * 10) / 10, 'fps')
  log('playback-max-gap', Math.round(playback.maxGapMs), 'ms')

  // --- export: 24 frames of png-sequence at 0.5× scale --------------------
  await page.locator('header.toolbar').getByRole('button', { name: 'Export…', exact: true }).click()
  const modal = page.locator('.export-modal')
  await expect(modal).toBeVisible()
  await modal.locator('.export-format').selectOption('png-sequence')
  const range = modal.locator('.export-field', { hasText: 'Frame range' }).locator('input')
  await range.nth(0).fill('1')
  await range.nth(1).fill('24')
  const scale = modal.locator('.export-field', { hasText: 'Resolution scale' }).locator('input')
  await scale.fill('0.5')
  const exportStart = Date.now()
  await modal.locator('button.primary').click()
  // Success without diagnostics closes the modal; a failure keeps it open.
  await modal.waitFor({ state: 'detached', timeout: 120_000 })
  const exportMs = Date.now() - exportStart
  log('export-24-frames', Math.round(exportMs), 'ms')

  // --- budgets: asserted after every metric is logged ---------------------
  expect(full.elapsedMs, 'full-render budget').toBeLessThan(PERF_BUDGETS.fullRenderMs)
  expect(dragMsPerMove, 'drag-render budget').toBeLessThan(PERF_BUDGETS.dragMsPerMove)
  expect(playback.ticks, 'playback window sanity').toBeGreaterThanOrEqual(
    PERF_BUDGETS.playbackMinTicks
  )
  expect(playback.rateFps, 'playback rate budget').toBeGreaterThanOrEqual(
    PERF_FPS * PERF_BUDGETS.playbackMinFpsRatio
  )
  expect(playback.maxGapMs, 'playback max-gap budget').toBeLessThan(PERF_BUDGETS.playbackMaxGapMs)
  expect(exportMs, 'export budget').toBeLessThan(PERF_BUDGETS.export24FramesMs)
})
