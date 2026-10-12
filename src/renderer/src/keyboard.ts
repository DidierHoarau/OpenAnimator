import { TEXT_FIELD_SAFE, matchShortcut } from '@shared/shortcuts'
import type { ShortcutRow } from '@shared/shortcuts'

import { runEditorCommand } from './commands'
import type { CommandDeps } from './commands'

/**
 * Application-wide keyboard dispatcher. Every key event is resolved through
 * the single shortcut table (`src/shared/shortcuts.ts`) and routed to the one
 * command router — the same path the application menu uses, so a real key
 * press (consumed natively by the menu) and a synthetic one (E2E) behave
 * identically. Inside text fields native editing wins over every binding
 * except the TEXT_FIELD_SAFE list (File menu entries and F1).
 *
 * Page-only rows that need event data — nudge direction, the Space hold/release
 * pair — are handled here; everything else goes through the router.
 */
export function registerKeyboard(deps: CommandDeps): void {
  const { editor, stageView } = deps

  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null
    const inTextField =
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement
    const row = matchShortcut(event)
    if (!row) return
    if (inTextField && !TEXT_FIELD_SAFE.has(row.id)) return

    if (!dispatchSpecial(row, event, deps)) {
      event.preventDefault()
      runEditorCommand(row.id, deps)
    }
  })

  window.addEventListener('keyup', (event) => {
    if (event.key !== ' ') return
    const target = event.target as HTMLElement | null
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return
    stageView.setSpacePressed(false)
    // A plain Space tap keeps toggling playback; Space consumed by a pan
    // drag does not.
    if (!stageView.spaceUsed) editor.togglePlay()
  })
}

/**
 * Handles the page-only rows whose action needs the event itself. Returns
 * true when the event was consumed (the generic router path is skipped).
 */
function dispatchSpecial(row: ShortcutRow, event: KeyboardEvent, deps: CommandDeps): boolean {
  const { editor, stageView } = deps
  switch (row.id) {
    case 'stage.pan':
      event.preventDefault()
      stageView.setSpacePressed(true)
      return true
    case 'edit.nudge': {
      event.preventDefault()
      const distance = event.shiftKey ? 10 : 1
      if (event.key === 'ArrowLeft') editor.nudgeSelected(-distance, 0)
      else if (event.key === 'ArrowRight') editor.nudgeSelected(distance, 0)
      else if (event.key === 'ArrowUp') editor.nudgeSelected(0, -distance)
      else if (event.key === 'ArrowDown') editor.nudgeSelected(0, distance)
      return true
    }
    case 'pen.finish':
      // Only an open pen path consumes Enter, so focused buttons keep their
      // native Enter activation.
      if (editor.tool !== 'pen') return true
      event.preventDefault()
      stageView.finishPen()
      return true
    case 'editor.escape':
      // Escape stays passive (no preventDefault): modals handle their own.
      if (editor.tool === 'pen') stageView.cancelPen()
      else if (editor.tool === 'vector') stageView.cancelVectorStroke()
      else editor.stopPlayback()
      return true
    default:
      return false
  }
}
