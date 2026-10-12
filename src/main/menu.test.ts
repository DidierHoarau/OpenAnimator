import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import type { MenuCommand } from '../shared/api'
import { menuShortcutRows } from '../shared/shortcuts'
import { buildMenuTemplate } from './menu'

function collectItems(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const entry of template) {
    out.push(entry)
    if (Array.isArray(entry.submenu)) out.push(...collectItems(entry.submenu))
  }
  return out
}

function build(dev = false): {
  template: MenuItemConstructorOptions[]
  commands: MenuCommand[]
  onCommand: ReturnType<typeof vi.fn>
} {
  const commands: MenuCommand[] = []
  const onCommand = vi.fn((command: MenuCommand) => {
    commands.push(command)
  })
  const template = buildMenuTemplate(onCommand, { dev })
  return { template, commands, onCommand }
}

describe('buildMenuTemplate', () => {
  it('has the full menu bar structure', () => {
    const { template } = build()
    expect(template.map((entry) => entry.label)).toEqual([
      'File',
      'Edit',
      'Insert',
      'Layer',
      'View',
      'Help',
      'Window'
    ])
  })

  it('exposes every menu-owned shortcut row as an item', () => {
    const { template, commands } = build()
    const items = collectItems(template)
    for (const row of menuShortcutRows()) {
      const matches = items.filter((entry) => entry.label === row.label)
      expect(matches.length, `missing menu item for ${row.id}`).toBeGreaterThanOrEqual(1)
      const target = matches[0]
      if (row.accelerator) {
        expect(target.accelerator, `accelerator mismatch on ${row.id}`).toBe(row.accelerator)
      }
      target.click?.(undefined as never, undefined as never, undefined as never)
      expect(commands[commands.length - 1]).toBe(row.id)
    }
  })

  it('routes the F-key and editing accelerators to their ids', () => {
    const { template, commands } = build()
    const items = collectItems(template)
    const byAccelerator = new Map(items.filter((entry) => entry.accelerator).map((entry) => [entry.accelerator as string, entry]))
    for (const [accelerator, id] of [
      ['CmdOrCtrl+N', 'file.new'],
      ['CmdOrCtrl+S', 'file.save'],
      ['CmdOrCtrl+Shift+S', 'file.saveAs'],
      ['CmdOrCtrl+E', 'file.export'],
      ['CmdOrCtrl+Z', 'edit.undo'],
      ['CmdOrCtrl+Shift+Z', 'edit.redo'],
      ['CmdOrCtrl+D', 'edit.duplicate'],
      ['Delete', 'edit.delete'],
      ['CmdOrCtrl+A', 'edit.selectAll'],
      ['CmdOrCtrl+,', 'edit.preferences'],
      ['F5', 'insert.frame'],
      ['F6', 'insert.keyframe'],
      ['F7', 'insert.blankCell'],
      ['F8', 'insert.symbol'],
      ['CmdOrCtrl+T', 'insert.tween'],
      ['CmdOrCtrl+G', 'insert.group'],
      ["CmdOrCtrl+'", 'view.toggleGrid'],
      ['F1', 'help.shortcuts']
    ] as const) {
      const entry = byAccelerator.get(accelerator)
      expect(entry, `missing item with accelerator ${accelerator}`).toBeDefined()
      entry?.click?.(undefined as never, undefined as never, undefined as never)
      expect(commands[commands.length - 1]).toBe(id)
    }
  })

  it('nests the align and distribute items under the Align submenu', () => {
    const { template, commands } = build()
    const edit = template.find((entry) => entry.label === 'Edit')
    const align = (edit?.submenu as MenuItemConstructorOptions[]).find((entry) => entry.label === 'Align')
    expect(align).toBeDefined()
    const labels = (align?.submenu as MenuItemConstructorOptions[]).map((entry) => entry.label ?? entry.type)
    expect(labels).toEqual([
      'Align Left',
      'Align Horizontal Centers',
      'Align Right',
      'Align Top',
      'Align Vertical Centers',
      'Align Bottom',
      'separator',
      'Distribute Horizontally',
      'Distribute Vertically'
    ])
    for (const entry of align?.submenu as MenuItemConstructorOptions[]) {
      entry.click?.(undefined as never, undefined as never, undefined as never)
    }
    expect(commands).toEqual([
      'edit.alignLeft',
      'edit.alignCenterH',
      'edit.alignRight',
      'edit.alignTop',
      'edit.alignMiddle',
      'edit.alignBottom',
      'edit.distributeH',
      'edit.distributeV'
    ])
  })

  it('keeps window and quit roles', () => {
    const { template } = build()
    const items = collectItems(template)
    const roles = items.map((entry) => entry.role).filter(Boolean)
    expect(roles).toContain('quit')
    expect(roles).toContain('minimize')
    expect(roles).toContain('close')
    expect(roles).toContain('togglefullscreen')
  })

  it('adds Reload / Toggle DevTools only in development', () => {
    const production = collectItems(build(false).template).map((entry) => entry.role)
    expect(production).not.toContain('reload')
    expect(production).not.toContain('toggleDevTools')
    const dev = collectItems(build(true).template).map((entry) => entry.role)
    expect(dev).toContain('reload')
    expect(dev).toContain('toggleDevTools')
  })

  it('reaches every editor action: no menu row dispatches an unknown id', () => {
    const { template, commands } = build()
    const items = collectItems(template)
    for (const entry of items) {
      if (typeof entry.click === 'function' && entry.label) {
        entry.click(undefined as never, undefined as never, undefined as never)
      }
    }
    expect(commands.length).toBeGreaterThan(0)
    for (const command of commands) {
      expect(menuShortcutRows().some((row) => row.id === command)).toBe(true)
    }
  })
})
