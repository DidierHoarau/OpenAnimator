import { join } from 'node:path'

import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

import { APP_API_CHANNEL, APP_MENU_COMMAND_CHANNEL, APP_OPEN_FILE_CHANNEL } from '../shared/api'
import type { AppVersions, MenuCommand } from '../shared/api'
import { registerExportHandlers } from './exports'
import { registerFontHandlers } from './fonts'
import { registerLibraryHandlers } from './library'
import { projectPathFromArgv } from './openFiles'
import { registerPaletteHandlers } from './palette'
import { registerProjectHandlers } from './projects'
import { registerRecoveryHandlers } from './recovery'
import { registerUpdateHandlers, setupAutoUpdates } from './updates'

let mainWindow: BrowserWindow | null = null
/** Whether the current window's page finished its first load (the renderer
 * listener for open-file deliveries only exists from then on). */
let mainWindowLoaded = false
/** `.oanim` path delivered before the renderer was ready to receive it. */
let pendingProjectPath: string | null = null

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

/**
 * Explicit application menu. The default menu's role items swallow the
 * Ctrl+Z / Ctrl+Shift+Z accelerators as web-page edits, so the Edit menu
 * routes Undo/Redo into the renderer's document history instead. The View
 * menu omits the browser zoom roles: Ctrl+0 and Ctrl+-/Ctrl++ belong to the
 * stage view.
 */
function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [{ role: 'quit' }]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendMenuCommand('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendMenuCommand('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'OpenAnimator',
    autoHideMenuBar: true,
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
    registerFontHandlers()
    registerRecoveryHandlers()
    registerUpdateHandlers()
    installApplicationMenu()

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

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
