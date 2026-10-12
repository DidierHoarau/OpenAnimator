import { isDrawingLayer } from '@shared/model'

import type { Editor } from './editor'
import { importImageViaDialog } from './imageImport'
import { openDocument, saveDocument } from './projects'
import type { StageView } from './stage'
import type { TimelineView } from './timeline'

/**
 * Application-wide keyboard shortcuts. Registered once per window; the
 * timeline clipboard shortcuts (Ctrl+C/Ctrl+V) are ignored inside form fields
 * so native text editing keeps working there.
 */
export function registerKeyboard(editor: Editor, stageView: StageView, timelineView: TimelineView): void {
  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null
    const inTextField =
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        void saveDocument(editor, { as: event.shiftKey })
      } else if (key === 'o') {
        event.preventDefault()
        void openDocument(editor)
      } else if (key === 'i') {
        event.preventDefault()
        void importImageViaDialog(editor)
      } else if (inTextField) {
        // Let native text undo/redo keep working inside fields.
        return
      } else if (key === 'c') {
        event.preventDefault()
        timelineView.copyKeyframes()
      } else if (key === 'v') {
        event.preventDefault()
        timelineView.pasteKeyframes()
      } else if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) editor.redo()
        else editor.undo()
      } else if (key === 'y') {
        event.preventDefault()
        editor.redo()
      } else if (key === 'g' && !inTextField) {
        event.preventDefault()
        if (event.shiftKey) editor.ungroupSelection()
        else editor.groupSelection()
      } else if (key === '0') {
        event.preventDefault()
        stageView.resetView()
      }
      return
    }
    if (inTextField) return
    switch (event.key) {
      case 'v':
      case 'V':
        editor.setTool('select')
        break
      case 'h':
      case 'H':
        editor.setTool('hand')
        break
      case 'b':
      case 'B':
        editor.setTool('brush')
        break
      case 'e':
      case 'E':
        editor.setTool('eraser')
        break
      case '[':
        event.preventDefault()
        editor.setBrushSize(editor.brushSize - 1)
        break
      case ']':
        event.preventDefault()
        editor.setBrushSize(editor.brushSize + 1)
        break
      case 'r':
      case 'R':
        editor.setTool('rect')
        break
      case 'o':
      case 'O':
        editor.setTool('ellipse')
        break
      case 'l':
      case 'L':
        editor.setTool('line')
        break
      case 'p':
      case 'P':
        editor.setTool('pen')
        break
      case 't':
      case 'T':
        editor.setTool('text')
        break
      case 'Enter':
        // Enter commits an open pen path.
        if (editor.tool === 'pen') {
          event.preventDefault()
          stageView.finishPen()
        }
        break
      case '+':
      case '=':
        event.preventDefault()
        stageView.zoomIn()
        break
      case '-':
        event.preventDefault()
        stageView.zoomOut()
        break
      case ' ':
        event.preventDefault()
        stageView.setSpacePressed(true)
        break
      case 'Escape':
        // Escape cancels an in-progress pen path, otherwise playback.
        if (editor.tool === 'pen') stageView.cancelPen()
        else editor.stopPlayback()
        break
      case 'F5':
        event.preventDefault()
        editor.insertFrameHere()
        break
      case 'F6': {
        event.preventDefault()
        // Drawing layers key cells, object layers key their selected nodes.
        const layer = editor.currentLayer
        if (layer && isDrawingLayer(layer)) void editor.insertCellHere()
        else editor.insertKeyframeHere()
        break
      }
      case 'F7': {
        const layer = editor.currentLayer
        if (layer && isDrawingLayer(layer)) {
          event.preventDefault()
          void editor.insertBlankCellHere()
        }
        break
      }
      case 'F8':
        event.preventDefault()
        editor.saveSelectionAsSymbol()
        break
      case 'Delete':
      case 'Backspace':
        event.preventDefault()
        editor.deleteSelected()
        break
      case 'ArrowLeft':
        event.preventDefault()
        editor.nudgeSelected(event.shiftKey ? -10 : -1, 0)
        break
      case 'ArrowRight':
        event.preventDefault()
        editor.nudgeSelected(event.shiftKey ? 10 : 1, 0)
        break
      case 'ArrowUp':
        event.preventDefault()
        editor.nudgeSelected(0, event.shiftKey ? -10 : -1)
        break
      case 'ArrowDown':
        event.preventDefault()
        editor.nudgeSelected(0, event.shiftKey ? 10 : 1)
        break
      default:
        break
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
