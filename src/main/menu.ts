import { Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

import type { MenuCommand } from '../shared/api'
import { SHORTCUTS } from '../shared/shortcuts'
import type { ShortcutId, ShortcutRow } from '../shared/shortcuts'

/**
 * The application menu, built from the single shortcut table
 * (`src/shared/shortcuts.ts`): every action's label and accelerator come from
 * its row, and every click dispatches the row id through the same command
 * router the keyboard uses — there is no second code path. Roles remain for
 * the window-management items (quit, fullscreen, minimize, close) and for the
 * development-only Reload / Toggle DevTools entries.
 *
 * Menu accelerators are consumed natively: the renderer never sees the
 * keydown, so exactly one trigger fires in real flows. Synthetic key events
 * (E2E) bypass the native menu and are handled by the renderer's keyboard
 * dispatcher, which shares the same table.
 */

export interface MenuBuildOptions {
  /** Adds the development-only Reload / Toggle DevTools items. */
  dev?: boolean
}

const ROWS_BY_ID = new Map<ShortcutId, ShortcutRow>(SHORTCUTS.map((row) => [row.id, row]))

const separator: MenuItemConstructorOptions = { type: 'separator' }

function item(id: ShortcutId, onCommand: (command: MenuCommand) => void): MenuItemConstructorOptions {
  const row = ROWS_BY_ID.get(id)
  if (!row) throw new Error(`Unknown shortcut id "${id}"`)
  const menuItem: MenuItemConstructorOptions = {
    label: row.label,
    click: () => onCommand(row.id)
  }
  if (row.accelerator) menuItem.accelerator = row.accelerator
  return menuItem
}

/** Pure template builder (no Electron runtime needed beyond types). */
export function buildMenuTemplate(
  onCommand: (command: MenuCommand) => void,
  options: MenuBuildOptions = {}
): MenuItemConstructorOptions[] {
  const viewSubmenu: MenuItemConstructorOptions[] = [
    item('view.zoomIn', onCommand),
    item('view.zoomOut', onCommand),
    item('view.resetZoom', onCommand),
    separator,
    item('view.toggleGrid', onCommand),
    item('view.toggleOnion', onCommand),
    separator,
    item('view.toggleLibrary', onCommand),
    item('view.toggleProperties', onCommand),
    separator,
    { role: 'togglefullscreen' }
  ]
  if (options.dev) {
    viewSubmenu.push(separator, { role: 'reload' }, { role: 'toggleDevTools' })
  }

  return [
    {
      label: 'File',
      submenu: [
        item('file.new', onCommand),
        item('file.open', onCommand),
        item('file.save', onCommand),
        item('file.saveAs', onCommand),
        separator,
        item('file.importImage', onCommand),
        item('file.importAudio', onCommand),
        separator,
        item('file.export', onCommand),
        item('file.purgeUnused', onCommand),
        separator,
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        item('edit.undo', onCommand),
        item('edit.redo', onCommand),
        separator,
        item('edit.cut', onCommand),
        item('edit.copy', onCommand),
        item('edit.paste', onCommand),
        item('edit.duplicate', onCommand),
        item('edit.delete', onCommand),
        item('edit.selectAll', onCommand),
        separator,
        {
          label: 'Align',
          submenu: [
            item('edit.alignLeft', onCommand),
            item('edit.alignCenterH', onCommand),
            item('edit.alignRight', onCommand),
            item('edit.alignTop', onCommand),
            item('edit.alignMiddle', onCommand),
            item('edit.alignBottom', onCommand),
            separator,
            item('edit.distributeH', onCommand),
            item('edit.distributeV', onCommand)
          ]
        },
        separator,
        item('edit.preferences', onCommand)
      ]
    },
    {
      label: 'Insert',
      submenu: [
        item('insert.keyframe', onCommand),
        item('insert.frame', onCommand),
        item('insert.blankCell', onCommand),
        separator,
        item('insert.tween', onCommand),
        item('insert.group', onCommand),
        item('insert.ungroup', onCommand),
        item('insert.symbol', onCommand)
      ]
    },
    {
      label: 'Layer',
      submenu: [
        item('layer.addObject', onCommand),
        item('layer.addDrawing', onCommand),
        item('layer.addCamera', onCommand),
        separator,
        item('file.importAudio', onCommand)
      ]
    },
    {
      label: 'View',
      submenu: viewSubmenu
    },
    {
      label: 'Help',
      submenu: [
        item('help.shortcuts', onCommand),
        item('help.documentation', onCommand),
        separator,
        item('help.about', onCommand)
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }]
    }
  ]
}

/** Builds and installs the application menu (electron entry point). */
export function installApplicationMenu(
  onCommand: (command: MenuCommand) => void,
  options: MenuBuildOptions = {}
): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(onCommand, options)))
}
