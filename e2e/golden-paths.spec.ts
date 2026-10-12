import { expect, test } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dismissStartup, launchApp } from './helpers'
import type { DialogPatches } from './helpers'

/** Timeline frame width in pixels (mirrors the app's timeline geometry). */
const FRAME_WIDTH = 14

let app: ElectronApplication | undefined

test.afterEach(async () => {
  await app?.close()
  app = undefined
})

async function start(patches: DialogPatches = {}): Promise<Page> {
  const launched = await launchApp(patches)
  app = launched.app
  return launched.page
}

function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'openanimator-e2e-'))
}

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Element is not visible')
  return box
}

/** Seeks by clicking a timeline track at a frame (tracks seek by geometry). */
async function seekTrack(page: Page, track: Locator, frame: number): Promise<void> {
  const box = await boxOf(track)
  await page.mouse.click(box.x + frame * FRAME_WIDTH + FRAME_WIDTH / 2, box.y + box.height / 2)
}

test('draws a rectangle, keys a held pose and tweens between the poses', async () => {
  const page = await start()
  await dismissStartup(page)

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect(page.locator('footer.statusbar')).toContainText('file: unsaved')

  // Expand the single layer so its object rows become visible.
  await page.locator('.tl-toggle').first().click()
  await expect(page.getByText('no objects on this layer')).toBeVisible()

  // Draw a rectangle on the stage with the rect tool.
  await page.locator('.tool-button[data-tool="rect"]').click()
  const stageBox = await boxOf(page.locator('svg.stage'))
  const centerX = stageBox.x + stageBox.width / 2
  const centerY = stageBox.y + stageBox.height / 2
  await page.mouse.move(centerX - 90, centerY - 60)
  await page.mouse.down()
  await page.mouse.move(centerX + 90, centerY + 60, { steps: 8 })
  await page.mouse.up()

  // The timeline grew an object row carrying the auto-key at frame 1.
  const shapeRow = page.locator('.tl-shape-row').first()
  await expect(page.getByText('no objects on this layer')).toHaveCount(0)
  await expect(shapeRow.locator('.tl-key')).toHaveCount(1)

  // Grow the timeline to 13 frames so frame 13 (0-based 12) is reachable.
  const addFrame = page.getByRole('button', { name: '+ Frame', exact: true })
  for (let last = 1; last <= 12; last++) {
    await addFrame.click()
    await seekTrack(page, shapeRow.locator('.tl-track'), last)
  }
  await expect(page.locator('footer.statusbar')).toContainText('frame 13 / 13')

  // Key the held pose at frame 13 through the properties button.
  const keyframeButton = page
    .locator('.properties-panel')
    .getByRole('button', { name: '+ Keyframe', exact: true })
  await expect(keyframeButton).toBeEnabled()
  await keyframeButton.click()
  await expect(shapeRow.locator('.tl-key')).toHaveCount(2)

  // At frame 7 the rectangle is on stage but unkeyed: dragging it auto-keys.
  await seekTrack(page, shapeRow.locator('.tl-track'), 6)
  await page.locator('.tool-button[data-tool="select"]').click()
  await page.mouse.move(centerX, centerY)
  await page.mouse.down()
  await page.mouse.move(centerX + 140, centerY - 90, { steps: 10 })
  await page.mouse.up()
  await expect(shapeRow.locator('.tl-key')).toHaveCount(3)

  // Back at frame 1, the properties Tween button bridges the first poses.
  await seekTrack(page, shapeRow.locator('.tl-track'), 0)
  const tweenButton = page
    .locator('.properties-panel')
    .getByRole('button', { name: 'Tween', exact: true })
    .filter({ visible: true })
  await expect(tweenButton).toBeEnabled()
  await tweenButton.click()
  await expect(page.locator('.tl-tween')).toHaveCount(1)
})

test('saves the starter demo and reopens it after a new project', async () => {
  const dir = await tempDir()
  const savePath = join(dir, 'roundtrip.oanim')
  const page = await start({ savePath, openPath: savePath })
  await dismissStartup(page)

  await page.getByRole('button', { name: 'Save As…', exact: true }).click()
  await expect(page.locator('footer.statusbar')).toContainText('file: roundtrip.oanim')
  const bytes = await readFile(savePath)
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect(page.locator('footer.statusbar')).toContainText('file: unsaved')
  await expect(page.locator('svg.stage ellipse')).toHaveCount(0)

  await page.getByRole('button', { name: 'Open…', exact: true }).click()
  await expect(page.locator('footer.statusbar')).toContainText('file: roundtrip.oanim')
  await expect(page.locator('svg.stage ellipse').first()).toBeVisible()
})

test('exports a GIF of a frame range', async () => {
  const dir = await tempDir()
  const gifPath = join(dir, 'export.gif')
  const page = await start({ savePath: gifPath })
  await dismissStartup(page)

  await page.locator('header.toolbar').getByRole('button', { name: 'Export…', exact: true }).click()
  const modal = page.locator('.export-modal')
  await expect(modal).toBeVisible()
  await modal.locator('.export-format').selectOption('gif')
  const range = modal.locator('.export-field', { hasText: 'Frame range' }).locator('input')
  await range.nth(0).fill('1')
  await range.nth(1).fill('5')
  await modal.locator('button.primary').click()

  await expect
    .poll(
      async () => {
        try {
          return (await readFile(gifPath)).length
        } catch {
          return 0
        }
      },
      { timeout: 45_000, message: 'the GIF export should be written' }
    )
    .toBeGreaterThan(1000)
  const bytes = await readFile(gifPath)
  expect(bytes.subarray(0, 6).toString('latin1')).toBe('GIF89a')
  await expect(modal).toHaveCount(0)
})

test('runs a script payload from the console', async () => {
  const page = await start()
  await dismissStartup(page)

  await page.getByRole('button', { name: 'Script…', exact: true }).click()
  const modal = page.locator('.script-modal')
  await expect(modal).toBeVisible()
  await modal.locator('.script-example').selectOption('0')
  await modal.getByRole('button', { name: 'Run script' }).click()

  const output = modal.locator('.script-output')
  await expect(output).toContainText('with no issues')
  await expect(page.locator('.tl-row', { hasText: 'Ball' })).toHaveCount(1)
})

test('startup dialog starts a fresh project', async () => {
  const page = await start()
  const modal = page.locator('.modal-overlay')
  await expect(modal).toBeVisible()
  await expect(modal.locator('.modal-title')).toHaveText('OpenAnimator')
  // The first-run demo is on the stage behind the dialog.
  await expect(page.locator('svg.stage ellipse').first()).toBeVisible()

  await modal.getByRole('button', { name: 'New project' }).click()
  await expect(page.locator('.modal-overlay')).toHaveCount(0)
  await expect(page.locator('footer.statusbar')).toContainText('file: unsaved')
  // The fresh project replaced the demo with a single empty layer.
  await expect(page.locator('.tl-row .name').first()).toHaveText('Layer 1')
  await expect(page.locator('svg.stage ellipse')).toHaveCount(0)
})
