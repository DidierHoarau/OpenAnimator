import { join } from 'node:path'

import { app, BrowserWindow, ipcMain, shell } from 'electron'

import { APP_API_CHANNEL, APP_CLOSE_REQUEST_CHANNEL, APP_CLOSE_RESPONSE_CHANNEL, APP_MENU_COMMAND_CHANNEL, APP_OPEN_EXTERNAL_CHANNEL, APP_OPEN_FILE_CHANNEL } from '../shared/api'
import type { AppVersions, MenuCommand, OpenExternalResult } from '../shared/api'
import { abortStagedExports, registerExportHandlers } from './exports'
import { registerExportPresetsHandlers } from './exportPresets'
import { registerFontHandlers } from './fonts'
import { registerLibraryHandlers } from './library'
import { installApplicationMenu } from './menu'
import { projectPathFromArgv } from './openFiles'
import { registerPaletteHandlers } from './palette'
import { registerPreferencesHandlers } from './preferences'
import { registerProjectHandlers } from './projects'
import { registerRecoveryHandlers } from './recovery'
import { registerUpdateHandlers, setupAutoUpdates } from './updates'

// Test hook: the E2E suite launches every instance with a fresh userData
// directory so recovery snapshots cannot leak from one test to the next.
if (process.env['OPENANIMATOR_USER_DATA_DIR']) {
  app.setPath('userData', process.env['OPENANIMATOR_USER_DATA_DIR'])
}

let mainWindow: BrowserWindow | null = null
/** Whether the current window's page finished its first load (the renderer
 * listener for open-file deliveries only exists from then on). */
let mainWindowLoaded = false
/** `.oanim` path delivered before the renderer was ready to receive it. */
let pendingProjectPath: string | null = null
/** Windows whose close the renderer already allowed (single window by design:
 * the application holds the single-instance lock). */
const closeConfirmed = new WeakSet<BrowserWindow>()
/** Whether a close request is awaiting the renderer's answer. */
let closeRequestPending = false
/** Whether the current close comes from quitting (Cmd+Q, File→Quit). */
let quitInProgress = false

/** Routes a `.oanim` path to the renderer, buffering it until the window's
 * page has finished loading. */
function deliverProjectPath(path: string): void {
  if (mainWindow && mainWindowLoaded) {
    mainWindow.webContents.send(APP_OPEN_FILE_CHANNEL, path)
  } else {
    pendingProjectPath = path
  }
}

function focusMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

/** Routes a menu command to the focused renderer. */
function sendMenuCommand(command: MenuCommand): void {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  target?.webContents.send(APP_MENU_COMMAND_CHANNEL, command)
}

/** Hosts the About dialog is allowed to open in the system browser. */
const EXTERNAL_URL_HOSTS = new Set(['github.com', 'didierhoarau.github.io'])

function registerOpenExternalHandler(): void {
  ipcMain.handle(APP_OPEN_EXTERNAL_CHANNEL, async (_event, url: unknown): Promise<OpenExternalResult> => {
    try {
      const parsed = new URL(String(url))
      if (parsed.protocol !== 'https:' || !EXTERNAL_URL_HOSTS.has(parsed.hostname)) {
        return { ok: false, error: 'Only https links to GitHub or the documentation site are allowed' }
      }
      await shell.openExternal(parsed.toString())
      return { ok: true }
    } catch {
      return { ok: false, error: 'Invalid URL' }
    }
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'OpenAnimator',
    // The full menu stays visible: it is the discoverability surface for
    // every action (and the accelerators work regardless of F10 focus).
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js')
    }
  })
  mainWindow = window

  window.on('ready-to-show', () => {
    window.show()
  })

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
      mainWindowLoaded = false
    }
    // An export interrupted by the close cannot keep its staged temp around.
    void abortStagedExports()
  })

  // Unsaved-changes protection: the renderer answers close requests (in-app
  // Save / Discard / Cancel prompt for dirty documents). A quit re-runs
  // app.quit() once the renderer allows the close.
  window.on('close', (event) => {
    if (closeConfirmed.has(window)) return
    if (window.webContents.isDestroyed()) return
    event.preventDefault()
    if (closeRequestPending) return
    closeRequestPending = true
    window.webContents.send(APP_CLOSE_REQUEST_CHANNEL)
  })

  window.webContents.on('did-start-loading', () => {
    mainWindowLoaded = false
  })

  window.webContents.on('did-finish-load', () => {
    mainWindowLoaded = true
    if (!pendingProjectPath) return
    const path = pendingProjectPath
    pendingProjectPath = null
    window.webContents.send(APP_OPEN_FILE_CHANNEL, path)
  })

  window.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // electron-vite dev server URL in development, built renderer files otherwise.
  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) {
  // A running instance owns the lock; it receives our argv via
  // 'second-instance' and this process exits.
  app.quit()
} else {
  // macOS delivers files opened from Finder / dropped on the dock icon
  // through this event, which can fire before the app is ready.
  app.on('open-file', (event, path) => {
    event.preventDefault()
    deliverProjectPath(path)
  })

  app.on('second-instance', (_event, argv) => {
    focusMainWindow()
    if (process.platform === 'darwin') return
    const path = projectPathFromArgv(argv)
    if (path) deliverProjectPath(path)
  })

  app.whenReady().then(() => {
    registerProjectHandlers()
    registerLibraryHandlers()
    registerExportHandlers()
    registerPaletteHandlers()
    registerExportPresetsHandlers()
    registerPreferencesHandlers()
    registerFontHandlers()
    registerRecoveryHandlers()
    registerUpdateHandlers()
    registerOpenExternalHandler()
    installApplicationMenu(sendMenuCommand, { dev: !app.isPackaged })

    ipcMain.handle(APP_CLOSE_RESPONSE_CHANNEL, (event, allow: boolean): void => {
      closeRequestPending = false
      if (!allow) {
        quitInProgress = false
        return
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return
      closeConfirmed.add(window)
      if (quitInProgress) app.quit()
      else window.close()
    })

    ipcMain.handle(APP_API_CHANNEL, (): AppVersions => ({
      app: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node ?? 'unknown'
    }))

    createWindow()
    setupAutoUpdates(() => mainWindow)

    // Launching with a `.oanim` argument (file association on Windows/Linux);
    // macOS hands the file over through 'open-file' instead.
    if (process.platform !== 'darwin') {
      const launchPath = projectPathFromArgv(process.argv)
      if (launchPath) deliverProjectPath(launchPath)
    }

    app.on('activate', () => {
      // Re-create the window on macOS when the dock icon is clicked.
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  app.on('before-quit', () => {
    quitInProgress = true
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
