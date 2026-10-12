import { _electron as electron, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Playwright transpiles this suite to CommonJS, so `__dirname` is available.
const appRoot = join(__dirname, '..')

/** userData dirs by application: `evaluate` no longer works once the app is gone. */
const userDataDirs = new WeakMap<ElectronApplication, string>()

export interface DialogPatches {
  /** Every save dialog (Save As…, export destination) resolves to this path. */
  savePath?: string
  /** Every open dialog (Open…) resolves to this path. */
  openPath?: string
}

/**
 * Launches a fresh instance of the built application with a private userData
 * directory (recovery snapshots, recent files and the library cannot leak
 * across tests; the main process honors `OPENANIMATOR_USER_DATA_DIR`). Native
 * file dialogs are replaced in the main process so tests can drive
 * save/open/export flows without a human picking files.
 */
export async function launchApp(
  patches: DialogPatches = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'openanimator-e2e-'))
  const args = ['out/main/index.js']
  if (process.platform === 'linux') {
    // Headless CI runs under xvfb without working GL.
    args.push('--disable-gpu')
  }
  const app = await electron.launch({
    args,
    cwd: appRoot,
    env: { ...process.env, OPENANIMATOR_USER_DATA_DIR: userDataDir }
  })
  userDataDirs.set(app, userDataDir)
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

/**
 * True once the application is gone. `app.process()` throws after the app's
 * Playwright dispatcher has been disposed — the client dereferences a removed
 * dispatch entry — which is exactly the already-closed case.
 */
function processExited(app: ElectronApplication): boolean {
  try {
    const child = app.process()
    return child.exitCode !== null || child.signalCode !== null
  } catch {
    return true
  }
}

/**
 * Closes the application at the end of a test. A window close with a dirty
 * document shows the in-app unsaved-changes prompt, so the helper clicks
 * **Discard** when the prompt appears and waits for the process to exit. A
 * test that already closed the app itself is a no-op for the window flow.
 * The private userData directory is removed either way.
 */
export async function closeApp(app: ElectronApplication, page: Page): Promise<void> {
  const userDataDir = userDataDirs.get(app)
  try {
    if (processExited(app)) return

    const closed = app.waitForEvent('close')
    await app
      .evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.close()
      })
      .catch(() => undefined)

    const discard = page.locator('.modal-overlay .modal-actions button', { hasText: 'Discard' })
    const promptHandled = discard
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => discard.click())
      .catch(() => undefined)
    await Promise.race([closed, promptHandled])
    await closed
  } finally {
    if (userDataDir?.includes('openanimator-e2e-')) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
