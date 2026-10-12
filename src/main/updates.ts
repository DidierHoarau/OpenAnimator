import { app, ipcMain, net, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

import { APP_OPEN_RELEASE_CHANNEL, APP_UPDATE_AVAILABLE_CHANNEL } from '../shared/api'
import { isNewerVersion, latestVersionFromRelease, releasePageUrl, UPDATE_REPO } from '../shared/updates'

const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

function notifyUpdateAvailable(getWindow: () => BrowserWindow | null, version: string): void {
  getWindow()?.webContents.send(APP_UPDATE_AVAILABLE_CHANNEL, { version })
}

/**
 * Read-only update check for Linux installs electron-updater cannot update in
 * place (deb/rpm/Flatpak/tar.gz, i.e. everything but AppImage): queries the
 * GitHub Releases API and notifies when a newer release exists. One request
 * per launch stays far below the unauthenticated rate limit; nothing is ever
 * downloaded or executed.
 */
async function checkLinuxRelease(getWindow: () => BrowserWindow | null): Promise<void> {
  try {
    const response = await net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (!response.ok) return
    const latest = latestVersionFromRelease(await response.json())
    if (!latest || !isNewerVersion(app.getVersion(), latest)) return
    notifyUpdateAvailable(getWindow, latest)
  } catch (error) {
    console.warn('OpenAnimator: update check failed', error)
  }
}

/**
 * Wires update checks for packaged builds: electron-updater against the
 * pinned GitHub provider (updates are only ever checked, never downloaded —
 * `autoDownload` is off) with the REST fallback for non-AppImage Linux
 * installs. Development builds and check failures stay silent.
 */
export function setupAutoUpdates(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('update-available', (info) => notifyUpdateAvailable(getWindow, info.version))
  autoUpdater.on('error', (error) => {
    console.warn('OpenAnimator: update check failed', error)
  })

  if (process.platform === 'linux' && !process.env['APPIMAGE']) {
    void checkLinuxRelease(getWindow)
    return
  }
  autoUpdater.checkForUpdates().catch((error) => {
    console.warn('OpenAnimator: update check failed', error)
  })
}

/** IPC handlers for the update notification. */
export function registerUpdateHandlers(): void {
  ipcMain.handle(APP_OPEN_RELEASE_CHANNEL, (_event, version: unknown): void => {
    if (typeof version === 'string' && RELEASE_VERSION_PATTERN.test(version)) {
      void shell.openExternal(releasePageUrl(version))
    }
  })
}
