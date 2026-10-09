import { join } from 'node:path'

import { app, BrowserWindow, ipcMain, shell } from 'electron'

import { APP_API_CHANNEL } from '../shared/api'
import type { AppVersions } from '../shared/api'
import { registerProjectHandlers } from './projects'

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
