import { _electron as electron, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { join } from 'node:path'

// Playwright transpiles this suite to CommonJS, so `__dirname` is available.
const appRoot = join(__dirname, '..')

export interface DialogPatches {
  /** Every save dialog (Save As…, export destination) resolves to this path. */
  savePath?: string
  /** Every open dialog (Open…) resolves to this path. */
  openPath?: string
}

/**
 * Launches a fresh instance of the built application. Each test owns its
 * instance; native file dialogs are replaced in the main process so tests can
 * drive save/open/export flows without a human picking files.
 */
export async function launchApp(
  patches: DialogPatches = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  const args = ['out/main/index.js']
  if (process.platform === 'linux') {
    // Headless CI runs under xvfb without working GL.
    args.push('--disable-gpu')
  }
  const app = await electron.launch({ args, cwd: appRoot })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await patchDialogs(app, patches)
  return { app, page }
}

/** Replaces the native file dialogs in the main process. */
export async function patchDialogs(app: ElectronApplication, patches: DialogPatches): Promise<void> {
  const { savePath, openPath } = patches
  if (!savePath && !openPath) return
  await app.evaluate(({ dialog }, paths) => {
    if (paths.savePath) {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.savePath! })
    }
    if (paths.openPath) {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.openPath!] })
    }
  }, { savePath, openPath })
}

/** Closes the startup dialog through its × button. */
export async function dismissStartup(page: Page): Promise<void> {
  const overlay = page.locator('.modal-overlay')
  await expect(overlay).toBeVisible()
  await overlay.locator('.modal-close').click()
  await expect(page.locator('.modal-overlay')).toHaveCount(0)
}
