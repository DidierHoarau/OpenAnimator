import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  SHORTCUTS,
  SHORTCUT_BINDINGS,
  SHORTCUT_CATEGORIES,
  TEXT_FIELD_SAFE,
  bindingKeyFor,
  bindingsFor,
  displayKeysForPlatform,
  matchShortcut,
  menuShortcutRows,
  normalizeAccelerator,
  renderShortcutMarkdown
} from './shortcuts'
import type { ShortcutId } from './shortcuts'

const DOCS_PATH = fileURLToPath(new URL('../../docs/shortcuts.md', import.meta.url))

/** Snapshot of the id union: adding a ShortcutId without a table row (or vice
 * versa) fails this list, so typecheck and runtime stay in sync. */
const ALL_IDS: ShortcutId[] = [
  'file.new', 'file.open', 'file.save', 'file.saveAs', 'file.importImage', 'file.importAudio',
  'file.export', 'file.purgeUnused',
  'edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.duplicate',
  'edit.delete', 'edit.selectAll', 'edit.preferences',
  'edit.alignLeft', 'edit.alignCenterH', 'edit.alignRight', 'edit.alignTop', 'edit.alignMiddle',
  'edit.alignBottom', 'edit.distributeH', 'edit.distributeV',
  'insert.frame', 'insert.keyframe', 'insert.blankCell', 'insert.tween', 'insert.group',
  'insert.ungroup', 'insert.symbol',
  'layer.addObject', 'layer.addDrawing', 'layer.addCamera',
  'view.zoomIn', 'view.zoomOut', 'view.resetZoom', 'view.toggleGrid', 'view.toggleOnion',
  'view.toggleLibrary', 'view.toggleProperties',
  'tool.select', 'tool.direct', 'tool.hand', 'tool.brush', 'tool.eraser', 'tool.rect', 'tool.ellipse',
  'tool.line', 'tool.pen', 'tool.text', 'tool.vector', 'tool.brushDown', 'tool.brushUp',
  'stage.pan', 'edit.nudge', 'pen.finish', 'editor.escape',
  'help.shortcuts', 'help.documentation', 'help.about'
]

const ACCELERATOR_PATTERN = /^(?:(?:CmdOrCtrl|Ctrl|CommandOrControl|Alt|Shift)\+)*[A-Za-z0-9'\-=,]+$/

describe('shortcut table', () => {
  it('has exactly one row per ShortcutId and no duplicates', () => {
    const ids = SHORTCUTS.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual([...ALL_IDS].sort())
  })

  it('covers every cheat-sheet category', () => {
    for (const category of SHORTCUT_CATEGORIES) {
      expect(SHORTCUTS.some((row) => row.category === category)).toBe(true)
    }
    for (const row of SHORTCUTS) {
      expect(SHORTCUT_CATEGORIES).toContain(row.category)
    }
  })

  it('keeps accelerators unique, valid Electron accelerators on menu rows only', () => {
    const seen = new Set<string>()
    for (const row of SHORTCUTS) {
      if (!row.accelerator) continue
      expect(row.owner, `${row.id} has an accelerator but is page-owned`).toBe('menu')
      expect(row.accelerator).toMatch(ACCELERATOR_PATTERN)
      expect(seen.has(row.accelerator)).toBe(false)
      seen.add(row.accelerator)
    }
    expect(seen.size).toBeGreaterThan(20)
  })

  it('keeps every binding unique across the table', () => {
    const seen = new Map<string, ShortcutId>()
    for (const row of SHORTCUTS) {
      for (const binding of bindingsFor(row)) {
        expect(seen.has(binding), `binding ${binding} of ${row.id} collides with ${seen.get(binding)}`).toBe(false)
        seen.set(binding, row.id)
      }
    }
    expect(SHORTCUT_BINDINGS.size).toBe(seen.size)
  })

  it('never lets a plain page binding collide with a menu accelerator', () => {
    const plain = new Set<string>()
    for (const row of SHORTCUTS) {
      for (const binding of row.bindings ?? []) {
        if (!binding.includes('+')) plain.add(binding)
      }
    }
    const accelerators = new Set(SHORTCUTS.filter((row) => row.accelerator).map((row) => normalizeAccelerator(row.accelerator as string)))
    for (const binding of plain) {
      expect(accelerators.has(binding), `plain binding ${binding} collides with a menu accelerator`).toBe(false)
    }
  })

  it('lists the menu rows for the menu template', () => {
    const rows = menuShortcutRows()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.owner === 'menu')).toBe(true)
    expect(rows.map((row) => row.id)).toContain('file.new')
    expect(rows.map((row) => row.id)).toContain('edit.alignLeft')
    expect(rows.map((row) => row.id)).toContain('help.about')
    expect(rows.map((row) => row.id)).not.toContain('tool.select')
  })

  it('marks only document-level actions as text-field safe', () => {
    expect([...TEXT_FIELD_SAFE].sort()).toEqual(
      ['file.importImage', 'file.open', 'file.save', 'file.saveAs', 'help.shortcuts'].sort()
    )
  })
})

describe('bindingKeyFor', () => {
  const base = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }
  it('normalizes modifiers to ctrl', () => {
    expect(bindingKeyFor({ ...base, key: 's', ctrlKey: true })).toBe('ctrl+s')
    expect(bindingKeyFor({ ...base, key: 'S', ctrlKey: true, shiftKey: true })).toBe('ctrl+shift+s')
    expect(bindingKeyFor({ ...base, key: 's', metaKey: true })).toBe('ctrl+s')
    expect(bindingKeyFor({ ...base, key: 'y', ctrlKey: true })).toBe('ctrl+y')
    expect(bindingKeyFor({ ...base, key: "'", ctrlKey: true })).toBe("ctrl+'")
    expect(bindingKeyFor({ ...base, key: ',', ctrlKey: true })).toBe('ctrl+,')
  })

  it('folds shifted characters into the produced key', () => {
    expect(bindingKeyFor({ ...base, key: '?' , shiftKey: true })).toBe('?')
    expect(bindingKeyFor({ ...base, key: '+' , shiftKey: true })).toBe('+')
    expect(bindingKeyFor({ ...base, key: 'V', shiftKey: true })).toBe('v')
    expect(bindingKeyFor({ ...base, key: '=' })).toBe('=')
  })

  it('keeps named keys stable regardless of shift', () => {
    expect(bindingKeyFor({ ...base, key: 'ArrowLeft', shiftKey: true })).toBe('arrowleft')
    expect(bindingKeyFor({ ...base, key: 'F5', shiftKey: true })).toBe('f5')
    expect(bindingKeyFor({ ...base, key: ' ' })).toBe(' ')
    expect(bindingKeyFor({ ...base, key: 'Escape' })).toBe('escape')
  })

  it('rejects dead and unidentified keys', () => {
    expect(bindingKeyFor({ ...base, key: 'Dead' })).toBeNull()
    expect(bindingKeyFor({ ...base, key: 'Unidentified' })).toBeNull()
    expect(bindingKeyFor({ ...base, key: '' })).toBeNull()
  })
})

describe('matchShortcut', () => {
  const base = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }
  it('resolves menu-owned keys through their accelerator', () => {
    expect(matchShortcut({ ...base, key: 's', ctrlKey: true })?.id).toBe('file.save')
    expect(matchShortcut({ ...base, key: 'S', ctrlKey: true, shiftKey: true })?.id).toBe('file.saveAs')
    expect(matchShortcut({ ...base, key: 'F5' })?.id).toBe('insert.frame')
    expect(matchShortcut({ ...base, key: 'Delete' })?.id).toBe('edit.delete')
    expect(matchShortcut({ ...base, key: 'Backspace' })?.id).toBe('edit.delete')
    expect(matchShortcut({ ...base, key: "'", ctrlKey: true })?.id).toBe('view.toggleGrid')
  })

  it('resolves page-owned keys', () => {
    expect(matchShortcut({ ...base, key: 'v' })?.id).toBe('tool.select')
    expect(matchShortcut({ ...base, key: 'V' })?.id).toBe('tool.select')
    expect(matchShortcut({ ...base, key: 'a' })?.id).toBe('tool.direct')
    expect(matchShortcut({ ...base, key: '[' })?.id).toBe('tool.brushDown')
    expect(matchShortcut({ ...base, key: ' ' })?.id).toBe('stage.pan')
    expect(matchShortcut({ ...base, key: 'ArrowLeft', shiftKey: true })?.id).toBe('edit.nudge')
    expect(matchShortcut({ ...base, key: '?' , shiftKey: true})?.id).toBe('help.shortcuts')
    expect(matchShortcut({ ...base, key: 'y', ctrlKey: true })?.id).toBe('edit.redo')
  })

  it('returns null for unbound keys', () => {
    expect(matchShortcut({ ...base, key: 'q' })).toBeNull()
    expect(matchShortcut({ ...base, key: 'k', ctrlKey: true })).toBeNull()
  })
})

describe('displayKeysForPlatform', () => {
  it('keeps Ctrl on non-mac platforms', () => {
    expect(displayKeysForPlatform('Ctrl+Shift+Z / Ctrl+Y', false)).toBe('Ctrl+Shift+Z / Ctrl+Y')
    expect(displayKeysForPlatform(undefined, false)).toBe('')
  })

  it('renders macOS symbols compactly', () => {
    expect(displayKeysForPlatform('Ctrl+Shift+Z / Ctrl+Y', true)).toBe('⌘⇧Z / ⌘Y')
    expect(displayKeysForPlatform('Ctrl+= / +', true)).toBe('⌘= / +')
    expect(displayKeysForPlatform('F1 / ?', true)).toBe('F1 / ?')
  })
})

describe('renderShortcutMarkdown', () => {
  it('matches the committed docs/shortcuts.md (drift gate)', () => {
    const committed = readFileSync(DOCS_PATH, 'utf8')
    expect(renderShortcutMarkdown()).toBe(committed)
  })

  it('lists every row and both clipboard context notes', () => {
    const markdown = renderShortcutMarkdown()
    for (const row of SHORTCUTS) {
      expect(markdown).toContain(row.label)
    }
    for (const category of SHORTCUT_CATEGORIES) {
      expect(markdown).toContain(`## ${category}`)
    }
    expect(markdown).toContain('timeline keyframe clipboard')
    expect(markdown).toContain('scene nodes')
  })

  it('is deterministic', () => {
    expect(renderShortcutMarkdown()).toBe(renderShortcutMarkdown())
  })
})
