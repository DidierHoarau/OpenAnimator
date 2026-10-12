import { join } from 'node:path'

import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

import { APP_API_CHANNEL, APP_MENU_COMMAND_CHANNEL } from '../shared/api'
import type { AppVersions, MenuCommand } from '../shared/api'
import { registerExportHandlers } from './exports'
import { registerFontHandlers } from './fonts'
import { registerLibraryHandlers } from './library'
import { registerPaletteHandlers } from './palette'
import { registerProjectHandlers } from './projects'

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
  const mainWindow = new BrowserWindow({
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // electron-vite dev server URL in development, built renderer files otherwise.
  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerProjectHandlers()
  registerLibraryHandlers()
  registerExportHandlers()
  registerPaletteHandlers()
  registerFontHandlers()
  installApplicationMenu()

  ipcMain.handle(APP_API_CHANNEL, (): AppVersions => ({
    app: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown'
  }))

  createWindow()

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
