/**
 * The single shortcut table: one row per editor action. It drives four
 * consumers from one source of truth — the Electron application menu
 * (`src/main/menu.ts`), the renderer keyboard dispatcher (`keyboard.ts`), the
 * cheat-sheet dialog (`shortcutHelp.ts`) and the generated `docs/shortcuts.md`
 * page. A unit test keeps every consumer in sync (uniqueness, accelerator
 * format, the plain-key/accelerator conflict matrix and the docs byte-drift).
 *
 * Rows are pure data: `owner: 'menu'` means the action lives in the
 * application menu (`accelerator` is the Electron accelerator); the page
 * dispatcher additionally matches the accelerator's normalized binding so the
 * same action works when the native menu cannot see the key (e.g. synthetic
 * events in tests). `owner: 'page'` rows are keyboard-only bindings.
 */

export type ShortcutId =
  | 'file.new'
  | 'file.open'
  | 'file.save'
  | 'file.saveAs'
  | 'file.importImage'
  | 'file.importAudio'
  | 'file.export'
  | 'file.purgeUnused'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.cut'
  | 'edit.copy'
  | 'edit.paste'
  | 'edit.duplicate'
  | 'edit.delete'
  | 'edit.selectAll'
  | 'edit.preferences'
  | 'edit.alignLeft'
  | 'edit.alignCenterH'
  | 'edit.alignRight'
  | 'edit.alignTop'
  | 'edit.alignMiddle'
  | 'edit.alignBottom'
  | 'edit.distributeH'
  | 'edit.distributeV'
  | 'insert.frame'
  | 'insert.keyframe'
  | 'insert.blankCell'
  | 'insert.tween'
  | 'insert.group'
  | 'insert.ungroup'
  | 'insert.symbol'
  | 'layer.addObject'
  | 'layer.addDrawing'
  | 'layer.addCamera'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.resetZoom'
  | 'view.toggleGrid'
  | 'view.toggleOnion'
  | 'view.toggleLibrary'
  | 'view.toggleProperties'
  | 'tool.select'
  | 'tool.direct'
  | 'tool.hand'
  | 'tool.brush'
  | 'tool.eraser'
  | 'tool.rect'
  | 'tool.ellipse'
  | 'tool.line'
  | 'tool.pen'
  | 'tool.text'
  | 'tool.vector'
  | 'tool.eyedropper'
  | 'tool.brushDown'
  | 'tool.brushUp'
  | 'stage.pan'
  | 'edit.nudge'
  | 'pen.finish'
  | 'editor.escape'
  | 'help.shortcuts'
  | 'help.documentation'
  | 'help.about'

export type ShortcutCategory = 'File' | 'Edit' | 'Insert' | 'Layer' | 'View' | 'Tools' | 'Stage' | 'Help'

export const SHORTCUT_CATEGORIES: readonly ShortcutCategory[] = [
  'File',
  'Edit',
  'Insert',
  'Layer',
  'View',
  'Tools',
  'Stage',
  'Help'
]

export interface ShortcutRow {
  id: ShortcutId
  /** Human label, used verbatim as the menu item label and cheat-sheet text. */
  label: string
  /** Display string ("Ctrl+S", "F5", "V"); `Ctrl` is shown as `⌘` on macOS. */
  keys?: string
  category: ShortcutCategory
  owner: 'menu' | 'page'
  /** Electron accelerator; menu items only. */
  accelerator?: string
  /** Extra page-dispatcher bindings beyond the accelerator. */
  bindings?: string[]
}

export const SHORTCUTS: readonly ShortcutRow[] = [
  // File
  { id: 'file.new', label: 'New Document', keys: 'Ctrl+N', category: 'File', owner: 'menu', accelerator: 'CmdOrCtrl+N' },
  { id: 'file.open', label: 'Open Project…', keys: 'Ctrl+O', category: 'File', owner: 'menu', accelerator: 'CmdOrCtrl+O' },
  { id: 'file.save', label: 'Save Project', keys: 'Ctrl+S', category: 'File', owner: 'menu', accelerator: 'CmdOrCtrl+S' },
  { id: 'file.saveAs', label: 'Save Project As…', keys: 'Ctrl+Shift+S', category: 'File', owner: 'menu', accelerator: 'CmdOrCtrl+Shift+S' },
  { id: 'file.importImage', label: 'Import Image…', keys: 'Ctrl+I', category: 'File', owner: 'menu', accelerator: 'CmdOrCtrl+I' },
  { id: 'file.importAudio', label: 'Import Audio…', category: 'File', owner: 'menu' },
  { id: 'file.export', label: 'Export…', keys: 'Ctrl+E', category: 'File', owner: 'menu', accelerator: 'CmdOrCtrl+E' },
  { id: 'file.purgeUnused', label: 'Purge Unused Resources', category: 'File', owner: 'menu' },

  // Edit
  { id: 'edit.undo', label: 'Undo', keys: 'Ctrl+Z', category: 'Edit', owner: 'menu', accelerator: 'CmdOrCtrl+Z' },
  { id: 'edit.redo', label: 'Redo', keys: 'Ctrl+Shift+Z / Ctrl+Y', category: 'Edit', owner: 'menu', accelerator: 'CmdOrCtrl+Shift+Z', bindings: ['ctrl+y'] },
  { id: 'edit.cut', label: 'Cut', keys: 'Ctrl+X', category: 'Edit', owner: 'menu', accelerator: 'CmdOrCtrl+X' },
  { id: 'edit.copy', label: 'Copy', keys: 'Ctrl+C', category: 'Edit', owner: 'menu', accelerator: 'CmdOrCtrl+C' },
  { id: 'edit.paste', label: 'Paste', keys: 'Ctrl+V', category: 'Edit', owner: 'menu', accelerator: 'CmdOrCtrl+V' },
  { id: 'edit.duplicate', label: 'Duplicate', keys: 'Ctrl+D', category: 'Edit', owner: 'menu', accelerator: 'CmdOrCtrl+D' },
  { id: 'edit.delete', label: 'Delete Selection', keys: 'Delete / Backspace', category: 'Edit', owner: 'menu', accelerator: 'Delete', bindings: ['backspace'] },
  { id: 'edit.selectAll', label: 'Select All Nodes', keys: 'Ctrl+A', category: 'Edit', owner: 'menu', accelerator: 'CmdOrCtrl+A' },
  { id: 'edit.preferences', label: 'Preferences…', keys: 'Ctrl+,', category: 'Edit', owner: 'menu', accelerator: 'CmdOrCtrl+,' },
  { id: 'edit.alignLeft', label: 'Align Left', category: 'Edit', owner: 'menu' },
  { id: 'edit.alignCenterH', label: 'Align Horizontal Centers', category: 'Edit', owner: 'menu' },
  { id: 'edit.alignRight', label: 'Align Right', category: 'Edit', owner: 'menu' },
  { id: 'edit.alignTop', label: 'Align Top', category: 'Edit', owner: 'menu' },
  { id: 'edit.alignMiddle', label: 'Align Vertical Centers', category: 'Edit', owner: 'menu' },
  { id: 'edit.alignBottom', label: 'Align Bottom', category: 'Edit', owner: 'menu' },
  { id: 'edit.distributeH', label: 'Distribute Horizontally', category: 'Edit', owner: 'menu' },
  { id: 'edit.distributeV', label: 'Distribute Vertically', category: 'Edit', owner: 'menu' },

  // Insert
  { id: 'insert.frame', label: 'Insert Frame', keys: 'F5', category: 'Insert', owner: 'menu', accelerator: 'F5' },
  { id: 'insert.keyframe', label: 'Insert Keyframe', keys: 'F6', category: 'Insert', owner: 'menu', accelerator: 'F6' },
  { id: 'insert.blankCell', label: 'Insert Blank Cell', keys: 'F7', category: 'Insert', owner: 'menu', accelerator: 'F7' },
  { id: 'insert.tween', label: 'Toggle Tween', keys: 'Ctrl+T', category: 'Insert', owner: 'menu', accelerator: 'CmdOrCtrl+T' },
  { id: 'insert.group', label: 'Group Selection', keys: 'Ctrl+G', category: 'Insert', owner: 'menu', accelerator: 'CmdOrCtrl+G' },
  { id: 'insert.ungroup', label: 'Ungroup Selection', keys: 'Ctrl+Shift+G', category: 'Insert', owner: 'menu', accelerator: 'CmdOrCtrl+Shift+G' },
  { id: 'insert.symbol', label: 'Save Selection as Symbol', keys: 'F8', category: 'Insert', owner: 'menu', accelerator: 'F8' },

  // Layer
  { id: 'layer.addObject', label: 'Add Object Layer', category: 'Layer', owner: 'menu' },
  { id: 'layer.addDrawing', label: 'Add Drawing Layer', category: 'Layer', owner: 'menu' },
  { id: 'layer.addCamera', label: 'Add Camera Layer', category: 'Layer', owner: 'menu' },

  // View
  { id: 'view.zoomIn', label: 'Zoom In', keys: 'Ctrl+= / +', category: 'View', owner: 'menu', accelerator: 'CmdOrCtrl+=', bindings: ['+', '='] },
  { id: 'view.zoomOut', label: 'Zoom Out', keys: 'Ctrl+- / -', category: 'View', owner: 'menu', accelerator: 'CmdOrCtrl+-', bindings: ['-'] },
  { id: 'view.resetZoom', label: 'Reset Zoom', keys: 'Ctrl+0 / 0', category: 'View', owner: 'menu', accelerator: 'CmdOrCtrl+0', bindings: ['0'] },
  { id: 'view.toggleGrid', label: 'Toggle Grid & Snapping', keys: "Ctrl+'", category: 'View', owner: 'menu', accelerator: "CmdOrCtrl+'" },
  { id: 'view.toggleOnion', label: 'Toggle Onion Skin', category: 'View', owner: 'menu' },
  { id: 'view.toggleLibrary', label: 'Toggle Library Panel', category: 'View', owner: 'menu' },
  { id: 'view.toggleProperties', label: 'Toggle Properties Panel', category: 'View', owner: 'menu' },

  // Tools
  { id: 'tool.select', label: 'Select Tool', keys: 'V', category: 'Tools', owner: 'page', bindings: ['v'] },
  { id: 'tool.direct', label: 'Direct Selection Tool', keys: 'A', category: 'Tools', owner: 'page', bindings: ['a'] },
  { id: 'tool.hand', label: 'Hand Tool', keys: 'H', category: 'Tools', owner: 'page', bindings: ['h'] },
  { id: 'tool.brush', label: 'Brush Tool', keys: 'B', category: 'Tools', owner: 'page', bindings: ['b'] },
  { id: 'tool.eraser', label: 'Eraser Tool', keys: 'E', category: 'Tools', owner: 'page', bindings: ['e'] },
  { id: 'tool.rect', label: 'Rectangle Tool', keys: 'R', category: 'Tools', owner: 'page', bindings: ['r'] },
  { id: 'tool.ellipse', label: 'Ellipse Tool', keys: 'O', category: 'Tools', owner: 'page', bindings: ['o'] },
  { id: 'tool.line', label: 'Line Tool', keys: 'L', category: 'Tools', owner: 'page', bindings: ['l'] },
  { id: 'tool.pen', label: 'Pen Tool', keys: 'P', category: 'Tools', owner: 'page', bindings: ['p'] },
  { id: 'tool.text', label: 'Text Tool', keys: 'T', category: 'Tools', owner: 'page', bindings: ['t'] },
  { id: 'tool.vector', label: 'Vector Tool', keys: 'N', category: 'Tools', owner: 'page', bindings: ['n'] },
  { id: 'tool.eyedropper', label: 'Eyedropper Tool', keys: 'I', category: 'Tools', owner: 'page', bindings: ['i'] },
  { id: 'tool.brushDown', label: 'Decrease Brush Size', keys: '[', category: 'Tools', owner: 'page', bindings: ['['] },
  { id: 'tool.brushUp', label: 'Increase Brush Size', keys: ']', category: 'Tools', owner: 'page', bindings: [']'] },

  // Stage
  { id: 'stage.pan', label: 'Pan Stage (hold) / Play-Pause (tap)', keys: 'Space', category: 'Stage', owner: 'page', bindings: [' '] },
  { id: 'edit.nudge', label: 'Nudge Selection', keys: 'Arrows (Shift: 10 px)', category: 'Stage', owner: 'page', bindings: ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'] },
  { id: 'pen.finish', label: 'Finish Pen Path', keys: 'Enter', category: 'Stage', owner: 'page', bindings: ['enter'] },
  { id: 'editor.escape', label: 'Cancel Pen / Stroke / Stop Playback', keys: 'Escape', category: 'Stage', owner: 'page', bindings: ['escape'] },

  // Help
  { id: 'help.shortcuts', label: 'Keyboard Shortcuts', keys: 'F1 / ?', category: 'Help', owner: 'menu', accelerator: 'F1', bindings: ['?'] },
  { id: 'help.documentation', label: 'Documentation', category: 'Help', owner: 'menu' },
  { id: 'help.about', label: 'About OpenAnimator', category: 'Help', owner: 'menu' }
]

/** Rows the application menu owns (used by the menu template and its test). */
export function menuShortcutRows(): ShortcutRow[] {
  return SHORTCUTS.filter((row) => row.owner === 'menu')
}

/** Normalizes an Electron accelerator to the page-dispatcher binding form
 * (`CmdOrCtrl+Shift+S` → `ctrl+shift+s`). */
export function normalizeAccelerator(accelerator: string): string {
  return accelerator.replace(/CmdOrCtrl|CommandOrControl/gi, 'ctrl').toLowerCase()
}

/** All page bindings of a row: its explicit bindings plus the accelerator's
 * normalized form (so menu-owned keys also work when the page sees them). */
export function bindingsFor(row: ShortcutRow): string[] {
  const bindings = [...(row.bindings ?? [])]
  if (row.accelerator) bindings.push(normalizeAccelerator(row.accelerator))
  return bindings
}

/** The structural subset of `KeyboardEvent` the dispatcher needs. */
export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * Normalizes a keydown event to a binding string. The primary modifier
 * (Ctrl, or Cmd on macOS) maps to `ctrl`; Shift is only part of the binding
 * when it does not change the produced character (so Ctrl+Shift+S is
 * `ctrl+shift+s`, while Shift+/ — which produces `?` — is just `?`, and
 * Shift+Arrow/Shift+F5 stay `arrowleft`/`f5`).
 */
export function bindingKeyFor(event: KeyEventLike): string | null {
  if (!event.key || event.key === 'Dead' || event.key === 'Unidentified') return null
  const primary = event.ctrlKey || event.metaKey
  const parts: string[] = []
  if (primary) parts.push('ctrl')
  if (event.altKey) parts.push('alt')
  if (primary && event.shiftKey) parts.push('shift')
  parts.push(event.key.toLowerCase())
  return parts.join('+')
}

/** Every binding of the whole table, resolved to its row. */
export const SHORTCUT_BINDINGS: ReadonlyMap<string, ShortcutRow> = (() => {
  const map = new Map<string, ShortcutRow>()
  for (const row of SHORTCUTS) {
    for (const binding of bindingsFor(row)) map.set(binding, row)
  }
  return map
})()

/** Resolves a key event to its shortcut row (or null when unbound). */
export function matchShortcut(event: KeyEventLike): ShortcutRow | null {
  const binding = bindingKeyFor(event)
  if (!binding) return null
  return SHORTCUT_BINDINGS.get(binding) ?? null
}

/** Shortcuts that still act while a text field has focus: document-level file
 * operations and Help. Everything else stays native inside fields. */
export const TEXT_FIELD_SAFE: ReadonlySet<ShortcutId> = new Set<ShortcutId>([
  'file.save',
  'file.saveAs',
  'file.open',
  'file.importImage',
  'help.shortcuts'
])

/** Platform-appropriate key display: macOS shows `⌘`/`⇧`/`⌥` instead of
 * `Ctrl`/`Shift`/`Alt`. */
export function displayKeysForPlatform(keys: string | undefined, isMac: boolean): string {
  if (!keys) return ''
  if (!isMac) return keys
  return keys
    .split(' / ')
    .map((chord) =>
      chord
        .split('+')
        .map((part) => (part === 'Ctrl' ? '⌘' : part === 'Shift' ? '⇧' : part === 'Alt' ? '⌥' : part))
        .join('+')
        .replace(/([⌘⇧⌥])\+/g, '$1')
    )
    .join(' / ')
}

/** Deterministic Markdown rendering of the table for `docs/shortcuts.md`. */
export function renderShortcutMarkdown(): string {
  let out = '# Keyboard shortcuts\n\n'
  out +=
    '> Generated from `src/shared/shortcuts.ts` by `scripts/build-docs.ts` — do not edit by hand.\n' +
    '> Run `npm run docs:build` after changing the shortcut table.\n\n'
  out += 'On macOS every `Ctrl` below is `Cmd`.\n\n'
  for (const category of SHORTCUT_CATEGORIES) {
    const rows = SHORTCUTS.filter((row) => row.category === category)
    if (rows.length === 0) continue
    out += `## ${category}\n\n`
    out += '| Shortcut | Action |\n| --- | --- |\n'
    for (const row of rows) {
      const keys = row.keys ? `\`${row.keys}\`` : '—'
      out += `| ${keys} | ${row.label} |\n`
    }
    out += '\n'
  }
  out += '## Context notes\n\n'
  out +=
    '- `Ctrl+C` / `Ctrl+V` act on the timeline keyframe clipboard while the timeline was the last clicked surface, otherwise on the selected scene nodes.\n'
  out += '- `Ctrl+X` (cut) and `Ctrl+D` (duplicate) always act on scene nodes.\n'
  out += '- Holding `Space` pans the stage; tapping it plays or pauses playback.\n'
  out +=
    '- The plain keys `+`, `-` and `0` zoom like their `Ctrl` counterparts; inside text fields native text editing wins over every binding except the File menu shortcuts and `F1`.\n'
  return out
}
