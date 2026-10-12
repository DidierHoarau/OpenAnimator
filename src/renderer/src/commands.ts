import type { ShortcutId } from '@shared/shortcuts'
import { isCameraLayer, isDrawingLayer } from '@shared/model'

import { getActiveSurface } from './activeSurface'
import { DOCS_URL, showAboutDialog } from './aboutDialog'
import { importAudioViaDialog } from './audioImport'
import type { Editor } from './editor'
import { showExportDialog } from './exportDialog'
import { importImageViaDialog } from './imageImport'
import { newDocument, openDocument, saveDocument } from './projects'
import { showPreferencesDialog } from './preferencesDialog'
import { showShortcutHelp } from './shortcutHelp'
import type { StageView } from './stage'
import type { TimelineView } from './timeline'

/**
 * The single command router: every menu item and every page key binding
 * dispatches through here, so both triggers behave identically. Commands
 * that need event data (nudge direction, Shift modifiers, the Space hold
 * release) are handled by the keyboard dispatcher itself and never reach
 * this router.
 */

export interface CommandDeps {
  editor: Editor
  stageView: StageView
  timelineView: TimelineView
  panels: {
    toggleLibrary: () => void
    toggleProperties: () => void
  }
}

/** Asks the main process to drop resources no object of the document
 * references, and reports the outcome (shared by the toolbar and the menu). */
export function purgeUnusedResources(editor: Editor): void {
  void window.api.purgeUnusedResources(editor.document).then((result) => {
    editor.showMessage(
      result.removed === 0 ? 'No unused resources' : `Purged ${result.removed} unused resource(s)`
    )
  })
}

export function runEditorCommand(command: ShortcutId, deps: CommandDeps): void {
  const { editor, stageView, timelineView, panels } = deps
  switch (command) {
    case 'file.new':
      void newDocument(editor)
      return
    case 'file.open':
      void openDocument(editor)
      return
    case 'file.save':
      void saveDocument(editor, { as: false })
      return
    case 'file.saveAs':
      void saveDocument(editor, { as: true })
      return
    case 'file.importImage':
      void importImageViaDialog(editor)
      return
    case 'file.importAudio':
      void importAudioViaDialog(editor)
      return
    case 'file.export':
      showExportDialog(editor)
      return
    case 'file.purgeUnused':
      purgeUnusedResources(editor)
      return
    case 'edit.undo':
      editor.undo()
      return
    case 'edit.redo':
      editor.redo()
      return
    case 'edit.cut':
      editor.cutSelectedNodes()
      return
    case 'edit.copy':
      // Surface-scoped: the timeline keeps its own keyframe clipboard, the
      // stage copies scene nodes (see docs/shortcuts.md context notes).
      if (getActiveSurface() === 'timeline') timelineView.copyKeyframes()
      else editor.copySelectedNodes()
      return
    case 'edit.paste':
      if (getActiveSurface() === 'timeline') timelineView.pasteKeyframes()
      else editor.pasteNodes()
      return
    case 'edit.duplicate':
      editor.duplicateSelectedNodes()
      return
    case 'edit.delete':
      // The direct tool deletes the selected path anchor when there is one;
      // otherwise (and with any other tool) the node selection is deleted.
      if (editor.tool === 'direct' && stageView.deleteAnchorSelection()) return
      editor.deleteSelected()
      return
    case 'edit.selectAll':
      editor.selectAllNodes()
      return
    case 'edit.preferences':
      showPreferencesDialog(editor)
      return
    case 'edit.alignLeft':
      editor.alignSelected('left')
      return
    case 'edit.alignCenterH':
      editor.alignSelected('centerH')
      return
    case 'edit.alignRight':
      editor.alignSelected('right')
      return
    case 'edit.alignTop':
      editor.alignSelected('top')
      return
    case 'edit.alignMiddle':
      editor.alignSelected('middle')
      return
    case 'edit.alignBottom':
      editor.alignSelected('bottom')
      return
    case 'edit.distributeH':
      editor.distributeSelected('h')
      return
    case 'edit.distributeV':
      editor.distributeSelected('v')
      return
    case 'insert.frame':
      editor.insertFrameHere()
      return
    case 'insert.keyframe': {
      // Drawing layers key cells, object layers key their selected objects.
      const layer = editor.currentLayer
      if (layer && isDrawingLayer(layer)) void editor.insertCellHere()
      else editor.insertKeyframeHere()
      return
    }
    case 'insert.blankCell': {
      const layer = editor.currentLayer
      if (layer && isDrawingLayer(layer)) void editor.insertBlankCellHere()
      return
    }
    case 'insert.tween': {
      const layer = editor.currentLayer
      if (layer && isCameraLayer(layer)) editor.toggleCameraTweenHere()
      else editor.toggleTweenHere()
      return
    }
    case 'insert.group':
      editor.groupSelection()
      return
    case 'insert.ungroup':
      editor.ungroupSelection()
      return
    case 'insert.symbol':
      editor.saveSelectionAsSymbol()
      return
    case 'layer.addObject':
      editor.addLayerAtBottom('object')
      return
    case 'layer.addDrawing':
      editor.addLayerAtBottom('drawing')
      return
    case 'layer.addCamera':
      editor.addCameraLayer()
      return
    case 'view.zoomIn':
      stageView.zoomIn()
      return
    case 'view.zoomOut':
      stageView.zoomOut()
      return
    case 'view.resetZoom':
      stageView.resetView()
      return
    case 'view.toggleGrid':
      editor.toggleGrid()
      return
    case 'view.toggleOnion':
      editor.toggleOnionSkin()
      return
    case 'view.toggleLibrary':
      panels.toggleLibrary()
      return
    case 'view.toggleProperties':
      panels.toggleProperties()
      return
    case 'tool.select':
      editor.setTool('select')
      return
    case 'tool.direct':
      editor.setTool('direct')
      return
    case 'tool.hand':
      editor.setTool('hand')
      return
    case 'tool.brush':
      editor.setTool('brush')
      return
    case 'tool.eraser':
      editor.setTool('eraser')
      return
    case 'tool.rect':
      editor.setTool('rect')
      return
    case 'tool.ellipse':
      editor.setTool('ellipse')
      return
    case 'tool.line':
      editor.setTool('line')
      return
    case 'tool.pen':
      editor.setTool('pen')
      return
    case 'tool.text':
      editor.setTool('text')
      return
    case 'tool.vector':
      editor.setTool('vector')
      return
    case 'tool.eyedropper':
      editor.setTool('eyedropper')
      return
    case 'tool.brushDown':
      editor.setBrushSize(editor.brushSize - 1)
      return
    case 'tool.brushUp':
      editor.setBrushSize(editor.brushSize + 1)
      return
    case 'stage.pan':
      stageView.setSpacePressed(true)
      return
    case 'edit.nudge':
      // Direction and Shift are event data; the keyboard dispatcher handles
      // the actual nudges (this case exists for switch exhaustiveness).
      return
    case 'pen.finish':
      if (editor.tool === 'pen') stageView.finishPen()
      return
    case 'editor.escape':
      // Cancel an in-progress pen path or vector stroke, drop the direct
      // tool's anchor selection, otherwise stop playback.
      if (editor.tool === 'pen') stageView.cancelPen()
      else if (editor.tool === 'vector') stageView.cancelVectorStroke()
      else if (editor.tool === 'direct' && stageView.clearAnchorSelection()) return
      else editor.stopPlayback()
      return
    case 'help.shortcuts':
      showShortcutHelp()
      return
    case 'help.documentation':
      void window.api.openExternal(DOCS_URL).then((result) => {
        if (!result.ok) editor.showMessage(`Could not open the documentation: ${result.error}`)
      })
      return
    case 'help.about':
      showAboutDialog()
      return
    default: {
      const unhandled: never = command
      void unhandled
    }
  }
}
