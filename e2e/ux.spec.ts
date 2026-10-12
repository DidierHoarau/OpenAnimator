import { expect, test } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'

import { closeApp, dismissStartup, launchApp } from './helpers'

let app: ElectronApplication | undefined
let launchedPage: Page | undefined

test.afterEach(async () => {
  if (app && launchedPage) await closeApp(app, launchedPage)
  app = undefined
  launchedPage = undefined
})

async function start(): Promise<Page> {
  const launched = await launchApp()
  app = launched.app
  launchedPage = launched.page
  return launched.page
}

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Element is not visible')
  return box
}

test('copies, pastes and duplicates stage nodes with single undo steps', async () => {
  const page = await start()
  await dismissStartup(page)

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect(page.locator('footer.statusbar')).toContainText('file: unsaved')

  // Expand the single layer so its object rows become visible.
  await page.locator('.tl-toggle').first().click()
  await expect(page.getByText('no objects on this layer')).toBeVisible()

  // Draw a rectangle at the stage centre with the rect tool.
  await page.locator('.tool-button[data-tool="rect"]').click()
  const stageBox = await boxOf(page.locator('svg.stage'))
  const centerX = stageBox.x + stageBox.width / 2
  const centerY = stageBox.y + stageBox.height / 2
  await page.mouse.move(centerX - 90, centerY - 60)
  await page.mouse.down()
  await page.mouse.move(centerX + 90, centerY + 60, { steps: 8 })
  await page.mouse.up()

  // Real object rows carry data-shape-id; the empty-layer placeholder row
  // ("no objects on this layer") does not.
  const shapeRows = page.locator('.tl-shape-row[data-shape-id]')
  await expect(shapeRows).toHaveCount(1)
  await expect(page.getByText('no objects on this layer')).toHaveCount(0)

  // Select the rectangle (select tool, click its centre on the stage).
  await page.locator('.tool-button[data-tool="select"]').click()
  await page.mouse.click(centerX, centerY)

  // Ctrl+C / Ctrl+V on the stage act on the node clipboard.
  await page.keyboard.press('Control+c')
  await expect(page.locator('footer.statusbar')).toContainText('Copied 1 object')
  await page.keyboard.press('Control+v')
  await expect(shapeRows).toHaveCount(2)
  await expect(page.locator('footer.statusbar')).toContainText('Pasted 1 object')

  // Ctrl+D duplicates the pasted copy without touching the clipboard;
  // the copies stay inside the keyframe at frame 1 (track preserved).
  await page.keyboard.press('Control+d')
  await expect(shapeRows).toHaveCount(3)
  await expect(page.locator('footer.statusbar')).toContainText('Duplicated 1 object')

  // Each clipboard action is exactly one undo step.
  await page.keyboard.press('Control+z')
  await expect(shapeRows).toHaveCount(2)
  await expect(page.locator('footer.statusbar')).toContainText('Undo: Duplicate nodes')
  await page.keyboard.press('Control+z')
  await expect(shapeRows).toHaveCount(1)
  await expect(page.locator('footer.statusbar')).toContainText('Undo: Paste nodes')
  await page.keyboard.press('Control+z')
  await expect(shapeRows).toHaveCount(0)
  await expect(page.getByText('no objects on this layer')).toBeVisible()
  await expect(page.locator('footer.statusbar')).toContainText('Undo: Add node')
})

test('opens the shortcut cheat sheet with F1 and closes it with Escape', async () => {
  const page = await start()
  await dismissStartup(page)

  await page.keyboard.press('F1')
  const overlay = page.locator('.modal-overlay')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('.modal-title')).toHaveText('Keyboard Shortcuts')
  // Rows come from the single shortcut table, grouped by category.
  await expect(overlay).toContainText('Toggle Grid & Snapping')
  await expect(overlay).toContainText('Duplicate')
  await expect(overlay.locator('.shortcut-table').first()).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.locator('.modal-overlay')).toHaveCount(0)

  // A second F1 after closing reopens the sheet.
  await page.keyboard.press('F1')
  await expect(page.locator('.modal-overlay')).toBeVisible()
  await page.locator('.modal-overlay .modal-close').click()
  await expect(page.locator('.modal-overlay')).toHaveCount(0)
})

test('reveals a created object and seeks from the frame ruler', async () => {
  const page = await start()
  await dismissStartup(page)

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect(page.locator('footer.statusbar')).toContainText('file: unsaved')

  // Draw a rectangle WITHOUT expanding the layer first: the new selection
  // auto-expands its owning layer, so the object row shows up on its own.
  await page.locator('.tool-button[data-tool="rect"]').click()
  const stageBox = await boxOf(page.locator('svg.stage'))
  const centerX = stageBox.x + stageBox.width / 2
  const centerY = stageBox.y + stageBox.height / 2
  await page.mouse.move(centerX - 90, centerY - 60)
  await page.mouse.down()
  await page.mouse.move(centerX + 90, centerY + 60, { steps: 8 })
  await page.mouse.up()

  const shapeRows = page.locator('.tl-shape-row[data-shape-id]')
  await expect(shapeRows).toHaveCount(1)
  await expect(shapeRows.first()).toHaveClass(/selected/)
  await expect(page.getByText('no objects on this layer')).toHaveCount(0)
  await expect(page.locator('.tl-toggle').first()).toHaveText('▾')

  // Extend the timeline to 10 frames: + Frame grows the authored length to
  // the playhead + 2 at most, so advance the playhead between the clicks.
  const addFrame = page.getByRole('button', { name: '+ Frame', exact: true })
  const seekTrack = async (frame: number): Promise<void> => {
    const box = await boxOf(shapeRows.first().locator('.tl-track'))
    await page.mouse.click(box.x + frame * 14 + 7, box.y + box.height / 2)
  }
  for (let last = 1; last <= 9; last++) {
    await addFrame.click()
    await seekTrack(last)
  }
  await expect(page.locator('footer.statusbar')).toContainText('frame 10 / 10')

  // Geometry of the ruler: the frame strip starts after the 180px row head
  // and every frame is 14px wide (same constants as the timeline source).
  const rulerBox = await boxOf(page.locator('.tl-ruler'))
  const frameX = (frame: number): number => rulerBox.x + 180 + frame * 14 + 7

  // A plain click on the ruler seeks: the click on the 6th displayed frame
  // moves the playhead (frames are selectable on long timelines).
  await page.mouse.click(frameX(5), rulerBox.y + 9)
  await expect(page.locator('footer.statusbar')).toContainText('frame 6 / 10')

  // Dragging across the ruler still marks the copy-range band, without
  // moving the playhead.
  await page.mouse.move(frameX(2), rulerBox.y + 9)
  await page.mouse.down()
  await page.mouse.move(frameX(4), rulerBox.y + 9, { steps: 4 })
  await expect(page.locator('.tl-range')).toBeVisible()
  await page.mouse.up()
  await expect(page.locator('.tl-range')).toBeVisible()
  await expect(page.locator('footer.statusbar')).toContainText('frame 6 / 10')
})
