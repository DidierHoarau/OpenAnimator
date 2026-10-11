import {
  addLayer as addLayerOp,
  addNodeToLayer,
  cloneDocument,
  createDocument,
  documentDuration,
  evaluateLayerAtFrame,
  findKeyframeAtFrame,
  findKeyframeIndexForFrame,
  findNearestNodeKeyframeIndex,
  getLayer,
  insertBlankKeyframe,
  insertFrame,
  moveLayer as moveLayerOp,
  removeFrame,
  removeLayer as removeLayerOp,
  removeNodeFromAllKeyframes,
  removeNodeFromLayer,
  renameLayer as renameLayerOp,
  renameNodeInLayer,
  setKeyframeTween,
  updateNodeInLayer
} from '@shared/document'
import type { EasingName } from '@shared/easing'
import { nodeBounds } from '@shared/hitTesting'
import type { Rect } from '@shared/hitTesting'
import { groupNodes, ungroupNode } from '@shared/groups'
import { cloneNode } from '@shared/model'
import type { AnimatorDocument, GroupNode, Layer, SceneNode } from '@shared/model'
import { createId } from '@shared/document'
import { ResourceCache } from './resourceCache'

export type Tool = 'select' | 'rect' | 'ellipse' | 'hand'

export type SelectionMode = 'replace' | 'add' | 'toggle'

/**
 * Editor state shared by the stage and timeline views. Owns the current
 * document, playhead, selection, active tool, playback loop and the
 * snapshot-based undo/redo history, and notifies views through three
 * channels: document changes, frame changes and UI state changes (tool,
 * playback, selection).
 */
export class Editor {
  /** Maximum number of undo snapshots kept in memory. */
  static readonly HISTORY_LIMIT = 100

  document: AnimatorDocument
  /** Content-addressed binary resources of the session (image blobs etc.). */
  readonly resources = new ResourceCache()
  currentFrame = 0
  currentLayerId: string
  /** Selected node ids in click order; the last one is the primary selection. */
  selectedNodeIds: string[] = []
  tool: Tool = 'select'
  playing = false
  loop = true
  onionSkin = false
  /** Path of the project file the document was loaded from / saved to. */
  filePath: string | null = null
  dirty = false

  private readonly undoStack: AnimatorDocument[] = []
  private readonly redoStack: AnimatorDocument[] = []
  /** Depth of the coalesced interaction currently open (drags push once). */
  private interactionDepth = 0

  private readonly docListeners = new Set<() => void>()
  private readonly frameListeners = new Set<() => void>()
  private readonly uiListeners = new Set<() => void>()
  private readonly messageListeners = new Set<(message: string) => void>()
  private rafId: number | null = null
  private lastTick: number | null = null
  private accumulator = 0

  constructor(document: AnimatorDocument) {
    this.document = document
    this.currentLayerId = document.layers[0]?.id ?? ''
  }

  get duration(): number {
    return documentDuration(this.document)
  }

  get currentLayer(): Layer | undefined {
    return getLayer(this.document, this.currentLayerId)
  }

  /** The most recently selected node (drives the properties panel). */
  get primarySelectedNodeId(): string | null {
    return this.selectedNodeIds.length > 0
      ? this.selectedNodeIds[this.selectedNodeIds.length - 1]
      : null
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  onDocChange(listener: () => void): void {
    this.docListeners.add(listener)
  }

  onFrameChange(listener: () => void): void {
    this.frameListeners.add(listener)
  }

  onUiChange(listener: () => void): void {
    this.uiListeners.add(listener)
  }

  onMessage(listener: (message: string) => void): void {
    this.messageListeners.add(listener)
  }

  private docChanged(): void {
    this.dirty = true
    for (const listener of this.docListeners) listener()
  }

  private frameChanged(): void {
    for (const listener of this.frameListeners) listener()
  }

  private uiChanged(): void {
    for (const listener of this.uiListeners) listener()
  }

  /** Surfaces a transient status-bar message (import feedback, hints…). */
  showMessage(message: string): void {
    for (const listener of this.messageListeners) listener(message)
  }

  /**
   * Pushes the current document onto the undo stack before a mutation. Skipped
   * inside a coalesced interaction so a whole drag becomes a single entry.
   */
  private pushHistory(): void {
    if (this.interactionDepth > 0) return
    this.pushSnapshot()
  }

  private pushSnapshot(): void {
    this.undoStack.push(cloneDocument(this.document))
    if (this.undoStack.length > Editor.HISTORY_LIMIT) this.undoStack.shift()
    this.redoStack.length = 0
  }

  /**
   * Opens a coalesced interaction (e.g. a pointer drag): exactly one history
   * entry is committed for everything mutated until `endInteraction`.
   */
  beginInteraction(): void {
    this.interactionDepth += 1
    this.pushSnapshot()
  }

  endInteraction(): void {
    this.interactionDepth = Math.max(0, this.interactionDepth - 1)
  }

  undo(): void {
    const snapshot = this.undoStack.pop()
    if (!snapshot) {
      this.showMessage('Nothing to undo')
      return
    }
    this.redoStack.push(cloneDocument(this.document))
    this.applySnapshot(snapshot, 'Undo')
  }

  redo(): void {
    const snapshot = this.redoStack.pop()
    if (!snapshot) {
      this.showMessage('Nothing to redo')
      return
    }
    this.undoStack.push(cloneDocument(this.document))
    this.applySnapshot(snapshot, 'Redo')
  }

  private applySnapshot(snapshot: AnimatorDocument, message: string): void {
    this.document = snapshot
    const clamped = Math.min(this.currentFrame, Math.max(0, this.duration - 1))
    const frameMoved = clamped !== this.currentFrame
    this.currentFrame = clamped
    if (!getLayer(this.document, this.currentLayerId)) {
      this.currentLayerId = this.document.layers[0]?.id ?? ''
    }
    this.pruneSelection()
    this.docChanged()
    if (frameMoved) this.frameChanged()
    this.uiChanged()
    this.showMessage(message)
  }

  setDocument(document: AnimatorDocument, resources: Record<string, Uint8Array> = {}): void {
    this.pause()
    this.document = document
    this.resources.reset(resources)
    this.currentLayerId = document.layers[0]?.id ?? ''
    this.currentFrame = 0
    this.selectedNodeIds = []
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.interactionDepth = 0
    this.docChanged()
    this.uiChanged()
  }

  newDocument(): void {
    this.setDocument(createDocument('Untitled', 960, 540, 24))
  }

  /** Records a successful save to the given file path and clears the dirty flag. */
  markSaved(filePath: string | null): void {
    this.filePath = filePath
    this.dirty = false
    this.uiChanged()
  }

  setFrame(frame: number): void {
    const clamped = Math.min(Math.max(0, Math.floor(frame)), Math.max(0, this.duration - 1))
    if (clamped === this.currentFrame) return
    this.currentFrame = clamped
    this.frameChanged()
  }

  /**
   * Moves the playhead within the visible grid, extending the authored
   * timeline when seeking past its end so keyframes can be added after the
   * last one. Playback advances through setFrame and is unaffected.
   */
  seekToFrame(frame: number): void {
    const target = Math.max(0, Math.floor(frame))
    if (target >= this.duration) {
      this.pushHistory()
      this.document.frames = target + 1
      this.docChanged()
    }
    this.setFrame(target)
  }

  setTool(tool: Tool): void {
    if (this.tool === tool) return
    this.tool = tool
    this.uiChanged()
  }

  /**
   * Replaces or updates the selection set. `replace` selects exactly `ids`,
   * `add` merges them into the selection and `toggle` flips the membership of
   * every id (shift-click and shift-marquee semantics).
   */
  selectNodes(ids: string[], mode: SelectionMode): void {
    let next: string[]
    if (mode === 'replace') {
      next = [...ids]
    } else if (mode === 'add') {
      const merged = new Set(this.selectedNodeIds)
      for (const id of ids) merged.add(id)
      next = [...merged]
    } else {
      const merged = new Set(this.selectedNodeIds)
      for (const id of ids) {
        if (merged.has(id)) merged.delete(id)
        else merged.add(id)
      }
      next = [...merged]
    }
    if (
      next.length === this.selectedNodeIds.length &&
      next.every((id, index) => id === this.selectedNodeIds[index])
    ) {
      return
    }
    this.selectedNodeIds = next
    this.uiChanged()
  }

  /** Drops selection ids that no longer exist anywhere in the document. */
  private pruneSelection(): void {
    if (this.selectedNodeIds.length === 0) return
    const present = new Set<string>()
    for (const layer of this.document.layers) {
      for (const keyframe of layer.keyframes) {
        for (const node of keyframe.nodes) present.add(node.id)
      }
    }
    this.selectedNodeIds = this.selectedNodeIds.filter((id) => present.has(id))
  }

  /** Union of the rotation-aware bounds of the evaluated selected nodes. */
  getSelectionBounds(): Rect | null {
    const layer = this.currentLayer
    if (!layer) return null
    let bounds: Rect | null = null
    for (const node of evaluateLayerAtFrame(layer, this.currentFrame)) {
      if (!this.selectedNodeIds.includes(node.id)) continue
      const box = nodeBounds(node)
      if (!bounds) {
        bounds = { ...box }
        continue
      }
      const minX = Math.min(bounds.x, box.x)
      const minY = Math.min(bounds.y, box.y)
      const maxX = Math.max(bounds.x + bounds.width, box.x + box.width)
      const maxY = Math.max(bounds.y + bounds.height, box.y + box.height)
      bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    }
    return bounds
  }

  togglePlay(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  play(): void {
    if (this.playing || this.duration <= 1) return
    this.playing = true
    this.lastTick = null
    this.accumulator = 0
    this.uiChanged()
    this.startLoop()
  }

  pause(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.lastTick = null
    this.accumulator = 0
    if (!this.playing) return
    this.playing = false
    this.uiChanged()
  }

  stopPlayback(): void {
    this.pause()
    this.setFrame(0)
  }

  toggleLoop(): void {
    this.loop = !this.loop
    this.uiChanged()
  }

  toggleOnionSkin(): void {
    this.onionSkin = !this.onionSkin
    this.uiChanged()
    this.frameChanged()
  }

  setFps(fps: number): void {
    if (!Number.isFinite(fps) || fps < 1 || fps > 120 || fps === this.document.fps) return
    this.pushHistory()
    this.document.fps = Math.round(fps)
    this.docChanged()
  }

  addNode(node: SceneNode): void {
    const layer = this.currentLayer
    if (!layer || layer.locked || !layer.visible) return
    this.pushHistory()
    // Auto-key: the new node gets its own pose at the current frame instead
    // of bleeding into an earlier keyframe's hold; other objects hold through.
    if (!findKeyframeAtFrame(layer, this.currentFrame)) {
      insertBlankKeyframe(layer, this.currentFrame)
    }
    addNodeToLayer(layer, this.currentFrame, node)
    this.selectedNodeIds = [node.id]
    this.docChanged()
    this.uiChanged()
  }

  /** Updates the primary selected node, auto-keying it first. One history entry. */
  updateSelectedNode(update: (node: SceneNode) => void): boolean {
    const primary = this.primarySelectedNodeId
    if (!primary) return false
    return this.updateNodesById([primary], update)
  }

  /**
   * Updates every selected node of the current layer, auto-keying each one
   * first (object-level keyframes; other objects hold through). One history
   * entry for the whole set.
   */
  updateSelectedNodes(update: (node: SceneNode) => void): boolean {
    return this.updateNodesById(this.selectedNodeIds, update)
  }

  private updateNodesById(ids: string[], update: (node: SceneNode) => void): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked) return false
    const keyable = ids.filter(
      (id) => findNearestNodeKeyframeIndex(layer, id, this.currentFrame) !== -1
    )
    if (keyable.length === 0) return false
    this.pushHistory()
    let changed = false
    for (const id of keyable) {
      if (this.ensureNodeKeyframeMutation(layer, id)) changed = true
      if (updateNodeInLayer(layer, this.currentFrame, id, update)) changed = true
    }
    if (changed) this.docChanged()
    return changed
  }

  nudgeSelected(dx: number, dy: number): void {
    this.updateSelectedNodes((node) => {
      node.center.x += dx
      node.center.y += dy
    })
  }

  /** Deletes every selected node of the current layer at the current frame. */
  deleteSelected(): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
    const removable = this.selectedNodeIds.filter((id) =>
      this.isNodeInActiveKeyframe(layer, id)
    )
    if (removable.length === 0) return
    this.pushHistory()
    let removed = false
    for (const id of removable) {
      if (removeNodeFromLayer(layer, this.currentFrame, id)) removed = true
    }
    if (removed) {
      this.pruneSelection()
      this.docChanged()
      this.uiChanged()
    }
  }

  private isNodeInActiveKeyframe(layer: Layer, nodeId: string): boolean {
    const index = findKeyframeIndexForFrame(layer, this.currentFrame)
    return index !== -1 && layer.keyframes[index].nodes.some((node) => node.id === nodeId)
  }

  /**
   * Adds a keyframe for every selected object at the current frame (F6): only
   * the selected objects get a pose, every other object keeps holding through.
   * Returns true when a keyframe was created.
   */
  insertKeyframeHere(): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked) return false
    const ids = this.selectedNodeIds.filter(
      (id) => findNearestNodeKeyframeIndex(layer, id, this.currentFrame) !== -1
    )
    if (ids.length === 0) return false
    this.pushHistory()
    let created = false
    for (const id of ids) {
      if (this.ensureNodeKeyframeMutation(layer, id)) created = true
    }
    if (created) {
      this.docChanged()
      this.showMessage('New keyframe created')
    }
    return created
  }

  /**
   * Returns true when the given node has its own keyframe exactly at the
   * given frame (content merely holding through from an earlier keyframe does
   * not count).
   */
  hasNodeKeyframeAt(layerId: string, nodeId: string, frame: number): boolean {
    const layer = getLayer(this.document, layerId)
    if (!layer) return false
    const keyframe = layer.keyframes.find((keyframe) => keyframe.frame === frame)
    return keyframe?.nodes.some((n) => n.id === nodeId) ?? false
  }

  /**
   * Ensures the node has its own pose at the current frame: creates the
   * keyframe when missing — object-level, holding only this node, so every
   * other object keeps holding through — and copies the node in from its
   * nearest keyframe when the keyframe lacks it.
   * Returns true when the document content changed.
   */
  ensureNodeKeyframe(nodeId: string): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked) return false
    if (!this.canKeyNode(layer, nodeId)) return false
    this.pushHistory()
    if (!this.ensureNodeKeyframeMutation(layer, nodeId)) return false
    this.docChanged()
    this.showMessage('New keyframe created')
    return true
  }

  /**
   * Auto-key primitive for edits of the selection: guarantees every selected
   * node has a pose at the current frame. Pushes history unless inside a
   * coalesced interaction. Returns true when the document content changed.
   */
  ensureSelectedNodesKeyframes(): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked) return false
    const ids = this.selectedNodeIds.filter((id) => this.canKeyNode(layer, id))
    if (ids.length === 0) return false
    this.pushHistory()
    let changed = false
    for (const id of ids) {
      if (this.ensureNodeKeyframeMutation(layer, id)) changed = true
    }
    if (changed) this.docChanged()
    return changed
  }

  private canKeyNode(layer: Layer, nodeId: string): boolean {
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (keyframe?.nodes.some((n) => n.id === nodeId)) return false
    return findNearestNodeKeyframeIndex(layer, nodeId, this.currentFrame) !== -1
  }

  private ensureNodeKeyframeMutation(layer: Layer, nodeId: string): boolean {
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (keyframe?.nodes.some((n) => n.id === nodeId)) return false
    const sourceIndex = findNearestNodeKeyframeIndex(layer, nodeId, this.currentFrame)
    const sourceNode =
      sourceIndex === -1
        ? undefined
        : layer.keyframes[sourceIndex].nodes.find((n) => n.id === nodeId)
    if (!sourceNode) return false
    const target = keyframe ?? insertBlankKeyframe(layer, this.currentFrame)
    if (!target) return false
    target.nodes.push(cloneNode(sourceNode))
    return true
  }

  /**
   * Groups the selected nodes of the current layer into one group node
   * (Ctrl+G): every selected node is auto-keyed first, then the nodes present
   * in the keyframe at the current frame are replaced by the group at the
   * topmost grouped child's index (z-order preserved). One undo step.
   * Returns true when a group was created.
   */
  groupSelection(): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked) return false
    const keyable = this.selectedNodeIds.filter((id) => this.canKeyNode(layer, id))
    this.pushHistory()
    for (const id of keyable) {
      this.ensureNodeKeyframeMutation(layer, id)
    }
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe) {
      this.showMessage('Select objects on the stage to group them')
      return false
    }
    const selected = new Set(this.selectedNodeIds)
    let topmostIndex = -1
    const members: SceneNode[] = []
    keyframe.nodes.forEach((node, index) => {
      if (selected.has(node.id)) {
        members.push(node)
        topmostIndex = index
      }
    })
    if (members.length === 0) {
      this.showMessage('Select objects on the stage to group them')
      return false
    }
    const group = groupNodes(members, createId('node'))
    // Remove the members highest-index first so earlier indexes stay valid,
    // then place the group where its topmost child was (z-order preserved).
    for (let index = keyframe.nodes.length - 1; index >= 0; index--) {
      if (selected.has(keyframe.nodes[index].id)) keyframe.nodes.splice(index, 1)
    }
    keyframe.nodes.splice(topmostIndex - members.length + 1, 0, group)
    this.selectedNodeIds = [group.id]
    this.docChanged()
    this.uiChanged()
    return true
  }

  /**
   * Ungroups every selected group present in the keyframe at the current
   * frame (Ctrl+Shift+G): each group is replaced by its children composed
   * back into the layer space, which become the new selection. One undo step
   * for the whole set. Returns true when a group was dissolved.
   */
  ungroupSelection(): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked) return false
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe) return false
    const groups = keyframe.nodes.filter(
      (node): node is GroupNode => node.type === 'group' && this.selectedNodeIds.includes(node.id)
    )
    if (groups.length === 0) return false
    this.pushHistory()
    const insertedIds: string[] = []
    for (const group of groups) {
      const index = keyframe.nodes.indexOf(group)
      if (index === -1) continue
      const children = ungroupNode(group)
      keyframe.nodes.splice(index, 1, ...children)
      insertedIds.push(...children.map((child) => child.id))
    }
    this.selectedNodeIds = insertedIds
    this.docChanged()
    this.uiChanged()
    return true
  }

  insertFrameHere(): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
    this.pushHistory()
    insertFrame(this.document, this.currentLayerId, this.currentFrame)
    this.docChanged()
  }

  /**
   * Removes the frame at the current frame: keyframes after it shift one
   * frame earlier on every layer and the keyframe at the frame itself is
   * deleted (unless it is a layer's last one). The playhead is clamped to
   * the shortened timeline. Returns true when the timeline changed.
   */
  removeFrameHere(): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked) return false
    this.pushHistory()
    removeFrame(this.document, this.currentFrame)
    this.currentFrame = Math.min(this.currentFrame, Math.max(0, this.duration - 1))
    this.docChanged()
    this.frameChanged()
    return true
  }

  /**
   * Removes this node's keyframe at the current frame: the node then holds
   * its previous pose — or, when this was its last keyframe, leaves the stage
   * after the previous one. Only the node's own keyframe at exactly the
   * current frame is removed. Returns true when content changed.
   */
  removeNodeKeyframe(nodeId: string): boolean {
    const layer = this.currentLayer
    if (!layer || layer.locked) return false
    if (!this.hasNodeKeyframeAt(this.currentLayerId, nodeId, this.currentFrame)) return false
    this.pushHistory()
    if (!removeNodeFromLayer(layer, this.currentFrame, nodeId)) return false
    this.docChanged()
    return true
  }

  /**
   * Removes the selected object's keyframe at the current frame, so the
   * object holds its previous pose — or leaves the stage when the removed
   * keyframe was its last one. Returns true when content changed.
   */
  removeKeyframeHere(): boolean {
    const primary = this.primarySelectedNodeId
    if (!primary) return false
    return this.removeNodeKeyframe(primary)
  }

  toggleTweenHere(): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe) return
    this.pushHistory()
    setKeyframeTween(layer, this.currentFrame, keyframe.tween ? undefined : { easing: 'ease-in-out' })
    this.docChanged()
    this.uiChanged()
  }

  setTweenEasingHere(easing: EasingName): void {
    const layer = this.currentLayer
    if (!layer || layer.locked) return
    const keyframe = findKeyframeAtFrame(layer, this.currentFrame)
    if (!keyframe?.tween) return
    this.pushHistory()
    setKeyframeTween(layer, this.currentFrame, { easing })
    this.docChanged()
  }

  setCurrentLayer(layerId: string): void {
    if (!getLayer(this.document, layerId) || this.currentLayerId === layerId) return
    this.currentLayerId = layerId
    this.uiChanged()
    this.frameChanged()
  }

  /** Adds a new layer at the bottom of the stack and makes it current. */
  addLayerAtBottom(): void {
    this.pushHistory()
    const layer = addLayerOp(this.document, `Layer ${this.document.layers.length + 1}`, 'bottom')
    this.currentLayerId = layer.id
    this.docChanged()
    this.uiChanged()
  }

  /** Removes a layer by id (the last remaining layer is never removed). */
  removeLayer(layerId: string): void {
    if (this.document.layers.length <= 1 || !getLayer(this.document, layerId)) return
    this.pushHistory()
    removeLayerOp(this.document, layerId)
    if (this.currentLayerId === layerId) {
      this.currentLayerId = this.document.layers[0]?.id ?? ''
    }
    this.pruneSelection()
    this.docChanged()
    this.uiChanged()
  }

  removeCurrentLayer(): void {
    this.removeLayer(this.currentLayerId)
  }

  /** Reorders a layer: index 0 is the topmost row of the stack. */
  moveLayer(layerId: string, toIndex: number): void {
    const fromIndex = this.document.layers.findIndex((layer) => layer.id === layerId)
    if (fromIndex === -1) return
    const clamped = Math.min(Math.max(0, toIndex), this.document.layers.length - 1)
    if (clamped === fromIndex) return
    this.pushHistory()
    moveLayerOp(this.document, layerId, clamped)
    this.docChanged()
    this.uiChanged()
  }

  renameLayer(layerId: string, name: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer) return
    this.pushHistory()
    renameLayerOp(this.document, layerId, name)
    this.docChanged()
  }

  /** Deletes a node from every keyframe of its layer. */
  deleteNode(layerId: string, nodeId: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer || layer.locked) return
    if (!layer.keyframes.some((keyframe) => keyframe.nodes.some((node) => node.id === nodeId))) {
      return
    }
    this.pushHistory()
    removeNodeFromAllKeyframes(layer, nodeId)
    this.selectedNodeIds = this.selectedNodeIds.filter((id) => id !== nodeId)
    this.docChanged()
    this.uiChanged()
  }

  /** Renames a node in every keyframe of its layer. */
  renameNode(layerId: string, nodeId: string, name: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer) return
    if (!layer.keyframes.some((keyframe) => keyframe.nodes.some((node) => node.id === nodeId))) {
      return
    }
    this.pushHistory()
    renameNodeInLayer(layer, nodeId, name)
    this.docChanged()
  }

  toggleLayerVisibility(layerId: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer) return
    this.pushHistory()
    layer.visible = !layer.visible
    this.docChanged()
    this.uiChanged()
  }

  toggleLayerLock(layerId: string): void {
    const layer = getLayer(this.document, layerId)
    if (!layer) return
    this.pushHistory()
    layer.locked = !layer.locked
    this.docChanged()
    this.uiChanged()
  }

  private startLoop(): void {
    const tick = (now: number): void => {
      if (!this.playing) return
      if (this.lastTick !== null) {
        this.accumulator += now - this.lastTick
        const frameMs = 1000 / this.document.fps
        let moved = false
        while (this.accumulator >= frameMs) {
          this.accumulator -= frameMs
          if (this.currentFrame + 1 >= this.duration) {
            if (this.loop) {
              this.currentFrame = 0
              moved = true
            } else {
              this.pause()
              return
            }
          } else {
            this.currentFrame += 1
            moved = true
          }
        }
        if (moved) this.frameChanged()
      }
      this.lastTick = now
      this.rafId = window.requestAnimationFrame(tick)
    }
    this.rafId = window.requestAnimationFrame(tick)
  }
}
