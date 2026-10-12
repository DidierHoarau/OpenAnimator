import type { ScriptCommand, ScriptIssue } from '@shared/scripting/commands'
import type { SceneNode, NodeBase } from '@shared/model'
import { MAX_PALETTE_COLORS, createId, extractKeyframeChunk } from '@shared/document'
import { isObjectLayer } from '@shared/model'

import type { Editor } from '../editor'
import { applyTextMetrics } from '@shared/textModel'
import type { MeasureLineWidth } from '@shared/textModel'
import type { Easing } from '@shared/easing'

const NODE_KINDS = new Set(['primitive', 'path', 'text', 'image', 'group', 'symbol'])

/**
 * Executes validated script commands through the public Editor API — the
 * exact pipeline UI gestures use (same validation, same undo entries). Each
 * command runs in its own coalesced interaction, so it is atomic: either all
 * of its editor mutations land as one undo entry, or a failure leaves the
 * document untouched. Every outcome is collected as a warning or error so a
 * calling LLM can repair and retry (validate-and-repair flow).
 */
export interface ScriptRunResult {
  /** Commands that mutated the document (best effort count on success). */
  applied: number
  issues: ScriptIssue[]
}

export function executeScriptCommands(editor: Editor, commands: readonly ScriptCommand[]): ScriptRunResult {
  const issues: ScriptIssue[] = []
  let applied = 0
  commands.forEach((command, index) => {
    try {
      editor.beginInteraction()
      const changed = applyCommand(editor, command, index, issues)
      if (changed) applied += 1
    } catch (error) {
      issues.push({
        index,
        message: error instanceof Error ? error.message : String(error),
        severity: 'error'
      })
    } finally {
      editor.endInteraction()
    }
  })
  if (applied > 0) editor.showMessage(`Script: applied ${applied} of ${commands.length} command(s)`)
  return { applied, issues }
}

function issue(issues: ScriptIssue[], index: number, message: string, severity: ScriptIssue['severity'] = 'error'): void {
  issues.push({ index, message, severity })
}

function applyCommand(
  editor: Editor,
  command: ScriptCommand,
  index: number,
  issues: ScriptIssue[]
): boolean {
  switch (command.op) {
    case 'addLayer': {
      editor.addLayerAtBottom(command.kind ?? 'object')
      if (command.name) editor.renameLayer(editor.currentLayerId, command.name)
      return true
    }
    case 'renameLayer': {
      if (!findLayer(editor, command.layerId)) {
        issue(issues, index, `renameLayer: layer ${command.layerId} not found`)
        return false
      }
      editor.renameLayer(command.layerId, command.name)
      return true
    }
    case 'removeLayer': {
      if (!findLayer(editor, command.layerId)) {
        issue(issues, index, `removeLayer: layer ${command.layerId} not found`)
        return false
      }
      editor.removeLayer(command.layerId)
      return true
    }
    case 'addNode':
      return applyAddNode(editor, command, index, issues)
    case 'updateNode':
      return applyNodePatch(editor, command.nodeId, command.layerId, command.frame ?? editor.currentFrame, command.patch, index, issues)
    case 'deleteNode': {
      const layerId = command.layerId ?? findLayerOfNode(editor, command.nodeId)
      if (!layerId) {
        issue(issues, index, `deleteNode: node ${command.nodeId} not found on any layer`)
        return false
      }
      const before = countNodeOccurrences(editor, layerId, command.nodeId)
      editor.deleteNode(layerId, command.nodeId)
      if (countNodeOccurrences(editor, layerId, command.nodeId) === before) {
        issue(issues, index, `deleteNode: node ${command.nodeId} not found (or layer locked)`)
        return false
      }
      return true
    }
    case 'setKeyframe': {
      const layerId = command.layerId ?? findLayerOfNode(editor, command.nodeId)
      if (!layerId) {
        issue(issues, index, `setKeyframe: node ${command.nodeId} not found on any layer`)
        return false
      }
      selectAndSeek(editor, layerId, command.nodeId, command.frame ?? editor.currentFrame)
      if (!editor.ensureNodeKeyframe(command.nodeId)) {
        issue(issues, index, `setKeyframe: could not key ${command.nodeId} at frame ${command.frame ?? editor.currentFrame} (node unknown, or a keyframe already exists there)`, 'warning')
        return false
      }
      if (command.patch) {
        applyNodePatch(editor, command.nodeId, layerId, editor.currentFrame, command.patch, index, issues)
      }
      return true
    }
    case 'removeNodeKeyframe': {
      const layerId = command.layerId ?? findLayerOfNode(editor, command.nodeId)
      if (!layerId) {
        issue(issues, index, `removeNodeKeyframe: node ${command.nodeId} not found`)
        return false
      }
      selectAndSeek(editor, layerId, command.nodeId, command.frame ?? editor.currentFrame)
      if (!editor.removeNodeKeyframe(command.nodeId)) {
        issue(issues, index, `removeNodeKeyframe: ${command.nodeId} has no own keyframe at frame ${editor.currentFrame}`, 'warning')
        return false
      }
      return true
    }
    case 'setTween': {
      const layerId = command.layerId ?? editor.currentLayerId
      const layer = findLayer(editor, layerId)
      if (!layer || !isObjectLayer(layer)) {
        issue(issues, index, `setTween: layer ${layerId} is not an object layer`)
        return false
      }
      editor.setCurrentLayer(layerId)
      editor.setFrame(command.frame ?? editor.currentFrame)
      const keyframe = layer.keyframes.find((entry) => entry.frame === editor.currentFrame)
      if (!keyframe) {
        issue(issues, index, `setTween: no keyframe at frame ${editor.currentFrame} on layer ${layerId}`)
        return false
      }
      if (command.easing === null) {
        if (keyframe.tween) editor.toggleTweenHere()
        return true
      }
      if (!keyframe.tween) editor.toggleTweenHere()
      editor.setTweenEasingHere((command.easing ?? 'ease-in-out') as Easing)
      if (command.path) editor.setTweenPathHere(command.path)
      return true
    }
    case 'moveKeyframe': {
      const layerId = command.layerId ?? findLayerOfNode(editor, command.nodeId)
      if (!layerId) {
        issue(issues, index, `moveKeyframe: node ${command.nodeId} not found on any layer`)
        return false
      }
      editor.setCurrentLayer(layerId)
      if (!editor.moveNodeKeyframeEntry(command.nodeId, command.fromFrame, command.toFrame, layerId)) {
        issue(
          issues,
          index,
          `moveKeyframe: ${command.nodeId} has no keyframe at frame ${command.fromFrame} (or the move is out of range or a no-op)`,
          'warning'
        )
        return false
      }
      return true
    }
    case 'copyKeyframes': {
      const layerId = command.layerId ?? findLayerOfNode(editor, command.nodeId)
      if (!layerId) {
        issue(issues, index, `copyKeyframes: node ${command.nodeId} not found on any layer`)
        return false
      }
      const layer = findLayer(editor, layerId)
      if (!layer || !isObjectLayer(layer)) {
        issue(issues, index, `copyKeyframes: layer ${layerId} is not an object layer`)
        return false
      }
      const toFrame = command.toFrame ?? command.fromFrame
      const chunk = extractKeyframeChunk(layer, command.fromFrame, toFrame, [command.nodeId])
      if (chunk.length === 0) {
        issue(
          issues,
          index,
          `copyKeyframes: ${command.nodeId} has no keyframe in frames ${command.fromFrame}–${toFrame}`,
          'warning'
        )
        return false
      }
      if (!editor.copyKeyframeChunk(layerId, chunk, command.targetFrame)) {
        issue(
          issues,
          index,
          `copyKeyframes: no copied entry lands inside the timeline at target frame ${command.targetFrame}`,
          'warning'
        )
        return false
      }
      return true
    }
    case 'setHoldStep': {
      const before = editor.holdStep
      editor.setHoldStep(command.step)
      if (editor.holdStep === before && before !== command.step) {
        issue(issues, index, `setHoldStep: step ${command.step} rejected (valid range 1–16)`, 'warning')
        return false
      }
      return true
    }
    case 'setCell': {
      const layerId = command.layerId ?? editor.currentLayerId
      const layer = findLayer(editor, layerId)
      if (!layer || layer.kind !== 'drawing') {
        issue(issues, index, `setCell: layer ${layerId} is not a drawing layer`)
        return false
      }
      if (!editor.setCell(layerId, command.frame ?? editor.currentFrame, command.resourceId)) {
        issue(issues, index, `setCell: frame or resource invalid (unknown resource ${command.resourceId}, locked layer, or negative frame)`)
        return false
      }
      return true
    }
    case 'setDuration': {
      if (!editor.setDuration(command.frames)) {
        issue(issues, index, `setDuration: timeline is already ${command.frames} frame(s)`, 'warning')
        return false
      }
      return true
    }
    case 'setFps': {
      const before = editor.document.fps
      editor.setFps(command.fps)
      if (editor.document.fps === before && before !== command.fps) {
        issue(issues, index, `setFps: ${command.fps} rejected (valid range 1–120)`, 'warning')
        return false
      }
      return true
    }
    case 'setPalette': {
      editor.setPalette(command.colors)
      if (editor.document.palette.length !== command.colors.length) {
        issue(
          issues,
          index,
          `setPalette: kept ${editor.document.palette.length} of ${command.colors.length} colors (invalid or duplicate entries dropped, max ${MAX_PALETTE_COLORS})`,
          'warning'
        )
      }
      return true
    }
    case 'seek': {
      const clamped = Math.min(editor.duration - 1, Math.max(0, Math.floor(command.frame)))
      if (clamped !== command.frame) {
        issue(issues, index, `seek: frame ${command.frame} clamped to ${clamped}`, 'warning')
      }
      editor.seekToFrame(command.frame)
      return true
    }
  }
}

function applyAddNode(
  editor: Editor,
  command: Extract<ScriptCommand, { op: 'addNode' }>,
  index: number,
  issues: ScriptIssue[]
): boolean {
  const node = normalizeNode(editor, command.node, index, issues)
  if (!node) return false
  if (command.layerId !== undefined) {
    const layer = findLayer(editor, command.layerId)
    if (!layer) {
      issue(issues, index, `addNode: layer ${command.layerId} not found`, 'warning')
    } else {
      editor.setCurrentLayer(layer.id)
    }
  }
  if (command.frame !== undefined) editor.setFrame(command.frame)
  const layer = editor.currentLayer
  if (!layer || !isObjectLayer(layer) || layer.locked || !layer.visible) {
    issue(issues, index, `addNode: the target layer is missing, locked or hidden`)
    return false
  }
  editor.addNode(node)
  return true
}

/**
 * Fills the optional base fields of a scripted node with document-derived
 * defaults and reports what it chose, then refreshes text metrics so text
 * nodes carry a layout box.
 */
function normalizeNode(
  editor: Editor,
  raw: Record<string, unknown>,
  index: number,
  issues: ScriptIssue[]
): SceneNode | null {
  if (typeof raw !== 'object' || raw === null || typeof raw.type !== 'string') {
    issue(issues, index, 'addNode: "node" must be an object with a "type"')
    return null
  }
  if (!NODE_KINDS.has(raw.type)) {
    issue(issues, index, `addNode: node type "${raw.type}" is not one of ${[...NODE_KINDS].join(', ')}`)
    return null
  }
  const node = { ...raw } as Record<string, unknown>
  const defaulted: string[] = []
  if (typeof node.id !== 'string' || node.id === '') {
    node.id = createId('node')
    defaulted.push(`id=${node.id as string}`)
  }
  if (typeof node.center !== 'object' || node.center === null) {
    node.center = { x: editor.document.width / 2, y: editor.document.height / 2 }
    defaulted.push(`center={${(node.center as { x: number }).x},${(node.center as { y: number }).y}}`)
  }
  if (typeof node.width !== 'number') {
    node.width = 100
    defaulted.push('width=100')
  }
  if (typeof node.height !== 'number') {
    node.height = 100
    defaulted.push('height=100')
  }
  if (typeof node.rotation !== 'number') {
    node.rotation = 0
    defaulted.push('rotation=0')
  }
  if (typeof node.opacity !== 'number') {
    node.opacity = 1
    defaulted.push('opacity=1')
  }
  if (defaulted.length > 0) {
    issue(issues, index, `addNode: defaulted ${defaulted.join(', ')}`, 'warning')
  }
  const sceneNode = node as unknown as SceneNode
  if (sceneNode.type === 'text') applyTextMetrics(sceneNode, editor.measureText)
  return sceneNode
}

function applyNodePatch(
  editor: Editor,
  nodeId: string,
  layerId: string | undefined,
  frame: number,
  patch: Record<string, unknown>,
  index: number,
  issues: ScriptIssue[]
): boolean {
  const resolvedLayerId = layerId ?? findLayerOfNode(editor, nodeId)
  if (!resolvedLayerId) {
    issue(issues, index, `updateNode: node ${nodeId} not found on any layer`)
    return false
  }
  selectAndSeek(editor, resolvedLayerId, nodeId, frame)
  const changed = editor.updateSelectedNode((node) => {
    applyPatchFields(node, patch, editor.measureText)
  })
  if (!changed) {
    issue(issues, index, `updateNode: ${nodeId} has no pose at frame ${editor.currentFrame} — set a keyframe first (setKeyframe)`)
    return false
  }
  return true
}

/** Applies the whitelisted patch fields (schema-validated) to a node. */
function applyPatchFields(
  node: SceneNode,
  patch: Record<string, unknown>,
  measureLineWidth: MeasureLineWidth
): void {
  const target = node as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'center' && typeof value === 'object' && value !== null) {
      const center = value as { x?: unknown; y?: unknown }
      if (typeof center.x === 'number') (node as NodeBase).center.x = center.x
      if (typeof center.y === 'number') (node as NodeBase).center.y = center.y
      continue
    }
    target[key] = value
  }
  if (node.type === 'text' && ('text' in patch || 'fontSize' in patch || 'align' in patch)) {
    applyTextMetrics(node, measureLineWidth)
  }
}

function selectAndSeek(editor: Editor, layerId: string, nodeId: string, frame: number): void {
  const layer = findLayer(editor, layerId)
  if (!layer) return
  editor.setCurrentLayer(layer.id)
  editor.setFrame(frame)
  editor.selectNodes([nodeId], 'replace')
}

function findLayer(editor: Editor, layerId: string) {
  return editor.document.layers.find((layer) => layer.id === layerId)
}

function findLayerOfNode(editor: Editor, nodeId: string): string | undefined {
  return editor.document.layers.find((layer) =>
    isObjectLayer(layer) && layer.keyframes.some((keyframe) => keyframe.nodes.some((node) => node.id === nodeId))
  )?.id
}

function countNodeOccurrences(editor: Editor, layerId: string, nodeId: string): number {
  const layer = findLayer(editor, layerId)
  if (!layer || !isObjectLayer(layer)) return 0
  return layer.keyframes.reduce(
    (total, keyframe) => total + keyframe.nodes.filter((node) => node.id === nodeId).length,
    0
  )
}
