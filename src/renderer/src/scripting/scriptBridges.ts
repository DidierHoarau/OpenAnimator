import { isAudioLayer, isObjectLayer } from '@shared/model'

import type { Editor } from '../editor'
import { createDefaultExportRunnerDeps, runExport } from '../export/runExport'
import { importAudioBytes, pickAudioFile } from '../audioImport'
import { importImageBytes, pickImageFile } from '../imageImport'
import type {
  ScriptExportBridge,
  ScriptImportAudioBridge,
  ScriptImportImageBridge
} from './execute'

/**
 * Renderer implementations of the environment bridges the executor leaves
 * open: the export pipeline and the native file pickers behind `export`,
 * `importImage` and `importAudio`. They reuse the toolbar flows' byte paths
 * (no second implementation), and the script console passes them so the
 * commands behave like the corresponding UI actions — a headless executor
 * without them reports a clear per-command error instead.
 */

/** Export bridge: runs the sanitized options through the app's export
 * pipeline. `out` skips the save dialog (script replay); without it the
 * native save dialog picks the destination. */
export function createScriptExportBridge(editor: Editor): ScriptExportBridge {
  return async (options, out) => {
    const deps = createDefaultExportRunnerDeps(editor)
    let destination: string | null = null
    const pick = deps.pickExportPath
    deps.pickExportPath = async (request) => {
      if (out === undefined) {
        const result = await pick(request)
        if (!result.canceled) destination = result.path
        return result
      }
      destination = out
      return { canceled: false, path: out }
    }
    const written = await runExport(editor, options, deps, { canceled: false })
    const path = destination
    if (!written || path === null) {
      return { ok: false, error: 'the export did not complete — see the status bar for details' }
    }
    return { ok: true, path }
  }
}

/** Image import bridge: picks a file through the OS dialog, imports it via
 * the existing byte path on the requested layer/frame, then applies the
 * scripted size/name overrides — all inside the command's undo entry. */
export function createScriptImportImageBridge(editor: Editor): ScriptImportImageBridge {
  return async (request) => {
    const targetId = request.layerId ?? editor.currentLayerId
    const layer = editor.document.layers.find((entry) => entry.id === targetId)
    if (!layer || !isObjectLayer(layer) || layer.locked || !layer.visible) {
      return {
        ok: false,
        error:
          request.layerId !== undefined
            ? `layer "${request.layerId}" is not a visible, unlocked object layer`
            : 'the current layer is not a visible, unlocked object layer'
      }
    }
    const picked = await pickImageFile()
    if (!picked) return { ok: false, error: 'no image file was chosen' }
    if (request.frame !== undefined) editor.setFrame(request.frame)
    editor.setCurrentLayer(targetId)
    const added = await importImageBytes(editor, picked.fileName, picked.bytes, request.at)
    if (!added) return { ok: false, error: `"${picked.fileName}" could not be imported` }
    const nodeId = editor.selectedNodeIds[editor.selectedNodeIds.length - 1]
    if (nodeId === undefined) {
      return { ok: false, error: `"${picked.fileName}" was imported but no node was selected` }
    }
    const patch: Record<string, unknown> = {}
    if (request.width !== undefined) patch.width = request.width
    if (request.height !== undefined) patch.height = request.height
    if (request.name !== undefined) patch.name = request.name
    if (Object.keys(patch).length > 0) {
      editor.updateSelectedNode((node) => Object.assign(node, patch))
    }
    return { ok: true, nodeId }
  }
}

/** Audio import bridge: picks a file through the OS dialog and runs the
 * existing audio import byte path (resource store + audio layer at the
 * requested start frame; the new layer becomes current). */
export function createScriptImportAudioBridge(editor: Editor): ScriptImportAudioBridge {
  return async (request) => {
    const picked = await pickAudioFile()
    if (!picked) return { ok: false, error: 'no audio file was chosen' }
    const added = await importAudioBytes(
      editor,
      picked.fileName,
      picked.bytes,
      request.startFrame ?? 0
    )
    if (!added) return { ok: false, error: `"${picked.fileName}" could not be imported` }
    const layer = editor.document.layers.find((entry) => entry.id === editor.currentLayerId)
    if (!layer || !isAudioLayer(layer)) {
      return { ok: false, error: 'the imported audio layer could not be located' }
    }
    return { ok: true, layerId: layer.id }
  }
}
