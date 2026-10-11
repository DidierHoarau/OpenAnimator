import { evaluateEasing } from './easing'
import type { EasingName } from './easing'
import type { AnimatorDocument, Asset, DrawingCell, DrawingLayer, Keyframe, Layer, ObjectLayer, SceneNode } from './model'
import { cloneNode, isObjectLayer } from './model'
import { tweenNode } from './tween'

let idCounter = 0

/** Generates a reasonably unique, readable id for documents, layers and nodes. */
export function createId(prefix: string): string {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER
  return `${prefix}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function createLayer(name: string): ObjectLayer {
  return {
    kind: 'object',
    id: createId('layer'),
    name,
    visible: true,
    locked: false,
    keyframes: []
  }
}

/** A new drawing layer starts blank: its first cell appears on the first
 * stroke or cell operation. */
export function createDrawingLayer(name: string, resolutionScale = 1): DrawingLayer {
  return {
    kind: 'drawing',
    id: createId('layer'),
    name,
    visible: true,
    locked: false,
    resolutionScale,
    cells: []
  }
}

export function createDocument(name: string, width: number, height: number, fps: number): AnimatorDocument {
  const layer = createLayer('Layer 1')
  layer.keyframes.push({ frame: 0, nodes: [] })
  return {
    schemaVersion: 3,
    name,
    width,
    height,
    fps,
    background: '#10151b',
    layers: [layer],
    frames: 1,
    assets: []
  }
}

export function getLayer(document: AnimatorDocument, layerId: string): Layer | undefined {
  return document.layers.find((layer) => layer.id === layerId)
}

/** Total number of frames: the furthest keyframe or cell + 1 and the authored
 * length (`frames`), whichever is larger; at least 1. */
export function documentDuration(document: AnimatorDocument): number {
  let max = 0
  for (const layer of document.layers) {
    if (isObjectLayer(layer)) {
      for (const keyframe of layer.keyframes) {
        max = Math.max(max, keyframe.frame)
      }
    } else {
      for (const cell of layer.cells) {
        max = Math.max(max, cell.frame)
      }
    }
  }
  return Math.max(1, max + 1, document.frames ?? 0)
}

/** Index of the last keyframe at or before `frame`, or -1 when none exists. */
export function findKeyframeIndexForFrame(layer: ObjectLayer, frame: number): number {
  let index = -1
  for (let i = 0; i < layer.keyframes.length; i++) {
    if (layer.keyframes[i].frame <= frame) index = i
    else break
  }
  return index
}

export function findKeyframeAtFrame(layer: ObjectLayer, frame: number): Keyframe | undefined {
  return layer.keyframes.find((keyframe) => keyframe.frame === frame)
}

/** Index of the last cell at or before `frame`, or -1 when none exists. */
export function findCellIndexForFrame(layer: DrawingLayer, frame: number): number {
  let index = -1
  for (let i = 0; i < layer.cells.length; i++) {
    if (layer.cells[i].frame <= frame) index = i
    else break
  }
  return index
}

export function findCellAtFrame(layer: DrawingLayer, frame: number): DrawingCell | undefined {
  return layer.cells.find((cell) => cell.frame === frame)
}

/**
 * Resource id of the cell holding `frame`: the latest cell at or before it
 * (cells hold until the next cell), or null when the layer is blank there —
 * after the last cell a drawing layer shows nothing, consistent with the
 * per-object spans of object layers.
 */
export function resolveCellAtFrame(layer: DrawingLayer, frame: number): string | null {
  const index = findCellIndexForFrame(layer, frame)
  return index === -1 ? null : layer.cells[index].resourceId
}

/** Frame of the closest cell strictly before `frame`, or null. */
export function findPreviousCellFrame(layer: DrawingLayer, frame: number): number | null {
  let latest: number | null = null
  for (const cell of layer.cells) {
    if (cell.frame < frame) latest = cell.frame
    else break
  }
  return latest
}

/** Frame of the closest cell strictly after `frame`, or null. */
export function findNextCellFrame(layer: DrawingLayer, frame: number): number | null {
  for (const cell of layer.cells) {
    if (cell.frame > frame) return cell.frame
  }
  return null
}

/**
 * Index of the keyframe holding the most recent pose of `nodeId` at or
 * before `frame`. When the node only appears later on the layer, the
 * earliest keyframe containing it is returned instead, so callers can always
 * copy an existing pose forward. Returns -1 when the node never appears.
 */
export function findNearestNodeKeyframeIndex(layer: ObjectLayer, nodeId: string, frame: number): number {
  let latest = -1
  let earliest = -1
  for (let i = 0; i < layer.keyframes.length; i++) {
    if (!layer.keyframes[i].nodes.some((node) => node.id === nodeId)) continue
    if (earliest === -1) earliest = i
    if (layer.keyframes[i].frame <= frame) latest = i
  }
  return latest !== -1 ? latest : earliest
}

/**
 * Object-level content of a layer at a given frame: every node exists only
 * within its own span — from its first keyframe to its last keyframe — and
 * keeps the pose from its latest keyframe at or before `frame`, interpolated
 * toward that node's own next keyframe when the owning keyframe carries a
 * tween.
 */
export function evaluateLayerAtFrame(layer: ObjectLayer, frame: number): SceneNode[] {
  const last = new Map<string, number>()
  for (let i = 0; i < layer.keyframes.length; i++) {
    for (const node of layer.keyframes[i].nodes) {
      last.set(node.id, i)
    }
  }

  const order: string[] = []
  const latest = new Map<string, { index: number; node: SceneNode }>()
  for (let i = 0; i < layer.keyframes.length; i++) {
    const keyframe = layer.keyframes[i]
    if (keyframe.frame > frame) break
    for (const node of keyframe.nodes) {
      if (!latest.has(node.id)) order.push(node.id)
      latest.set(node.id, { index: i, node })
    }
  }

  const result: SceneNode[] = []
  for (const id of order) {
    const entry = latest.get(id)
    if (!entry) continue
    // Hidden after its last keyframe: an object is only on stage inside its
    // own span.
    const lastIndex = last.get(id)
    if (lastIndex !== undefined && layer.keyframes[lastIndex].frame < frame) continue
    const source = layer.keyframes[entry.index]
    if (source.tween) {
      let nextIndex = -1
      for (let i = entry.index + 1; i < layer.keyframes.length; i++) {
        if (layer.keyframes[i].nodes.some((node) => node.id === id)) {
          nextIndex = i
          break
        }
      }
      if (nextIndex !== -1) {
        const next = layer.keyframes[nextIndex]
        const target = next.nodes.find((node) => node.id === id)
        if (target) {
          const progress = (frame - source.frame) / (next.frame - source.frame)
          const eased = evaluateEasing(source.tween.easing, progress)
          result.push(tweenNode(entry.node, target, eased))
          continue
        }
      }
    }
    result.push(entry.node)
  }
  return result
}

/**
 * Inserts a keyframe at `frame` holding a copy of the content active at that
 * frame. Returns the created keyframe, or null when one already exists there.
 */
export function insertKeyframe(layer: ObjectLayer, frame: number): Keyframe | null {
  if (findKeyframeAtFrame(layer, frame)) return null
  const previous = findKeyframeIndexForFrame(layer, frame)
  const nodes = previous === -1 ? [] : layer.keyframes[previous].nodes.map(cloneNode)
  const keyframe: Keyframe = { frame, nodes }
  layer.keyframes.push(keyframe)
  layer.keyframes.sort((a, b) => a.frame - b.frame)
  return keyframe
}

/** Inserts a blank (empty) keyframe at `frame`. Returns null if one exists. */
export function insertBlankKeyframe(layer: ObjectLayer, frame: number): Keyframe | null {
  if (findKeyframeAtFrame(layer, frame)) return null
  const keyframe: Keyframe = { frame, nodes: [] }
  layer.keyframes.push(keyframe)
  layer.keyframes.sort((a, b) => a.frame - b.frame)
  return keyframe
}

/** Removes the keyframe at `frame`. Returns true when something was removed. */
export function removeKeyframe(layer: ObjectLayer, frame: number): boolean {
  const index = layer.keyframes.findIndex((keyframe) => keyframe.frame === frame)
  if (index === -1) return false
  layer.keyframes.splice(index, 1)
  return true
}

/**
 * Sets the content of the cell at `frame`: creates the cell when the frame
 * has none (auto-cell on draw), or re-points the existing one. Returns the cell.
 */
export function setCellContent(layer: DrawingLayer, frame: number, resourceId: string): DrawingCell {
  const existing = findCellAtFrame(layer, frame)
  if (existing) {
    existing.resourceId = resourceId
    return existing
  }
  const cell: DrawingCell = { frame, resourceId }
  layer.cells.push(cell)
  layer.cells.sort((a, b) => a.frame - b.frame)
  return cell
}

/**
 * Inserts a cell at `frame` holding `resourceId`. Returns the created cell,
 * or null when a cell already exists exactly at that frame.
 */
export function insertCell(layer: DrawingLayer, frame: number, resourceId: string): DrawingCell | null {
  if (findCellAtFrame(layer, frame)) return null
  return setCellContent(layer, frame, resourceId)
}

/** Removes the cell exactly at `frame`. Returns true when one was removed. */
export function removeCell(layer: DrawingLayer, frame: number): boolean {
  const index = layer.cells.findIndex((cell) => cell.frame === frame)
  if (index === -1) return false
  layer.cells.splice(index, 1)
  return true
}

/** Inclusive frame range of one cell: whether it is the layer's last one and
 * therefore holds to the end of the authored timeline. */
export interface CellRange {
  /** Frame the cell starts at. */
  cellFrame: number
  /** Inclusive last frame the cell holds. */
  endFrame: number
  /** True for the layer's last cell: it holds to the end of the timeline. */
  lastHolds: boolean
}

/**
 * Range of the cell holding `frame`: from its own frame to the frame before
 * the next cell — the layer's last cell holds to the end of the authored
 * timeline instead. Returns null when the layer is blank at `frame`.
 */
export function cellRangeAtFrame(
  layer: DrawingLayer,
  frame: number,
  totalFrames: number
): CellRange | null {
  const index = findCellIndexForFrame(layer, frame)
  if (index === -1) return null
  const cell = layer.cells[index]
  const next = layer.cells[index + 1]
  if (next) return { cellFrame: cell.frame, endFrame: next.frame - 1, lastHolds: false }
  return { cellFrame: cell.frame, endFrame: Math.max(cell.frame, totalFrames - 1), lastHolds: true }
}

/**
 * Moves the cell at `fromFrame` to `toFrame`, merging over a cell already
 * there — the moved cell's content wins, mirroring the replace semantics of
 * `setCellContent`. Returns false when no cell sits at `fromFrame` or the
 * move is a no-op.
 */
export function moveCell(layer: DrawingLayer, fromFrame: number, toFrame: number): boolean {
  const index = layer.cells.findIndex((cell) => cell.frame === fromFrame)
  if (index === -1 || fromFrame === toFrame) return false
  const [moving] = layer.cells.splice(index, 1)
  for (let i = layer.cells.length - 1; i >= 0; i--) {
    if (layer.cells[i].frame === toFrame) layer.cells.splice(i, 1)
  }
  moving.frame = toFrame
  layer.cells.push(moving)
  layer.cells.sort((a, b) => a.frame - b.frame)
  return true
}

/**
 * Sets the end frame of the cell holding `frame`, clamped to the cell's own
 * frame and the authored timeline. A next cell moves to `end + 1`; shortening
 * the layer's last cell — which otherwise holds to the timeline end — inserts
 * a blank cell at `end + 1` from `blankResourceId`. Returns false when
 * nothing changes or a required blank resource is missing.
 */
export function setCellEnd(
  layer: DrawingLayer,
  frame: number,
  newEndFrame: number,
  totalFrames: number,
  blankResourceId?: string
): boolean {
  const index = findCellIndexForFrame(layer, frame)
  if (index === -1) return false
  const cell = layer.cells[index]
  const end = Math.min(Math.max(Math.floor(newEndFrame), cell.frame), totalFrames - 1)
  const next = layer.cells[index + 1]
  if (next) {
    if (end === next.frame - 1) return false
    next.frame = end + 1
    return true
  }
  // The last cell holds to the timeline end: shortening it needs a blank
  // cell right after the new end to stop the hold.
  if (end >= totalFrames - 1 || !blankResourceId) return false
  insertCell(layer, end + 1, blankResourceId)
  return true
}

/** Sets or clears the tween on the keyframe at `frame`. */
export function setKeyframeTween(
  layer: ObjectLayer,
  frame: number,
  tween: Keyframe['tween']
): boolean {
  const keyframe = findKeyframeAtFrame(layer, frame)
  if (!keyframe) return false
  if (tween) keyframe.tween = { ...tween }
  else delete keyframe.tween
  return true
}

/** Inserts a frame on the timeline: shifts the keyframes of object layers and
 * the cells of drawing layers strictly after `frame` one frame later
 * (extending the hold of the content active at the playhead) and grows the
 * document's authored timeline so the playhead can move past the last content. */
export function insertFrame(document: AnimatorDocument, layerId: string, frame: number): void {
  const layer = getLayer(document, layerId)
  if (!layer) return
  for (const target of document.layers) {
    if (isObjectLayer(target)) {
      for (const keyframe of target.keyframes) {
        if (keyframe.frame > frame) keyframe.frame += 1
      }
    } else {
      for (const cell of target.cells) {
        if (cell.frame > frame) cell.frame += 1
      }
    }
  }
  document.frames = Math.max(document.frames ?? 0, frame + 2)
}

/** Adds a node to the keyframe content active at `frame`, creating a blank
 * keyframe first when the frame sits before the first keyframe. */
export function addNodeToLayer(layer: ObjectLayer, frame: number, node: SceneNode): void {
  let keyframe = findKeyframeAtFrame(layer, frame)
  if (!keyframe) {
    const index = findKeyframeIndexForFrame(layer, frame)
    if (index === -1) {
      keyframe = { frame, nodes: [] }
      layer.keyframes.push(keyframe)
      layer.keyframes.sort((a, b) => a.frame - b.frame)
    } else {
      keyframe = layer.keyframes[index]
    }
  }
  keyframe.nodes.push(node)
}

/**
 * Removes a node from the keyframe content active at `frame`. When the
 * keyframe becomes empty it is removed as well: the timeline has no blank
 * keyframes, so content before the frame holds through it.
 */
export function removeNodeFromLayer(layer: ObjectLayer, frame: number, nodeId: string): boolean {
  const index = findKeyframeIndexForFrame(layer, frame)
  if (index === -1) return false
  const keyframe = layer.keyframes[index]
  const nodeIndex = keyframe.nodes.findIndex((node) => node.id === nodeId)
  if (nodeIndex === -1) return false
  keyframe.nodes.splice(nodeIndex, 1)
  if (keyframe.nodes.length === 0) removeKeyframe(layer, keyframe.frame)
  return true
}

/** Updates a node inside the keyframe content active at `frame`. */
export function updateNodeInLayer(
  layer: ObjectLayer,
  frame: number,
  nodeId: string,
  update: (node: SceneNode) => void
): boolean {
  const index = findKeyframeIndexForFrame(layer, frame)
  if (index === -1) return false
  const node = layer.keyframes[index].nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return false
  update(node)
  return true
}

/**
 * Removes every occurrence of a node across all keyframes of a layer.
 * Keyframes emptied by the removal are dropped. Returns how many keyframes
 * contained the node.
 */
export function removeNodeFromAllKeyframes(layer: ObjectLayer, nodeId: string): number {
  let removed = 0
  for (let i = layer.keyframes.length - 1; i >= 0; i--) {
    const keyframe = layer.keyframes[i]
    const nodeIndex = keyframe.nodes.findIndex((node) => node.id === nodeId)
    if (nodeIndex === -1) continue
    keyframe.nodes.splice(nodeIndex, 1)
    removed += 1
    if (keyframe.nodes.length === 0) layer.keyframes.splice(i, 1)
  }
  return removed
}

/** Sets the display name of a node in every keyframe that contains it. */
export function renameNodeInLayer(layer: ObjectLayer, nodeId: string, name: string): boolean {
  let renamed = false
  for (const keyframe of layer.keyframes) {
    const node = keyframe.nodes.find((candidate) => candidate.id === nodeId)
    if (node) {
      node.name = name
      renamed = true
    }
  }
  return renamed
}

/**
 * Shifts every keyframe holding `nodeId` by `delta` frames, clamped so all of
 * them stay within `[0, totalFrames − 1]` — the object keeps its motion.
 * Destination keyframes keep their other objects; a keyframe emptied by the
 * move is dropped, like `removeNodeFromLayer` does. Returns false when the
 * node has no keyframe or nothing can move.
 */
export function moveNodeKeyframes(
  layer: ObjectLayer,
  nodeId: string,
  delta: number,
  totalFrames: number
): boolean {
  const moved: Array<{ frame: number; node: SceneNode }> = []
  for (const keyframe of layer.keyframes) {
    const node = keyframe.nodes.find((candidate) => candidate.id === nodeId)
    if (node) moved.push({ frame: keyframe.frame, node })
  }
  if (moved.length === 0) return false
  const first = Math.min(...moved.map((entry) => entry.frame))
  const last = Math.max(...moved.map((entry) => entry.frame))
  if (last - first > totalFrames - 1) return false
  const shift = delta > 0 ? Math.min(delta, totalFrames - 1 - last) : Math.max(delta, -first)
  if (shift === 0) return false
  // Detach the entries first, dropping the keyframes they alone occupied.
  for (let i = layer.keyframes.length - 1; i >= 0; i--) {
    const keyframe = layer.keyframes[i]
    const index = keyframe.nodes.findIndex((candidate) => candidate.id === nodeId)
    if (index === -1) continue
    keyframe.nodes.splice(index, 1)
    if (keyframe.nodes.length === 0) layer.keyframes.splice(i, 1)
  }
  // Re-attach them at the shifted frames, merging into existing keyframes.
  for (const entry of moved) {
    const frame = entry.frame + shift
    const existing = layer.keyframes.find((keyframe) => keyframe.frame === frame)
    if (existing) existing.nodes.push(entry.node)
    else layer.keyframes.push({ frame, nodes: [entry.node] })
  }
  layer.keyframes.sort((a, b) => a.frame - b.frame)
  return true
}

/**
 * Removes a frame from the timeline: keyframes of object layers and cells of
 * drawing layers after `frame` shift one frame earlier and the content exactly
 * at `frame` is deleted, so the content of frame `frame + 1` collapses into
 * `frame`. A layer's last remaining keyframe or cell is never removed.
 */
export function removeFrame(document: AnimatorDocument, frame: number): void {
  for (const layer of document.layers) {
    if (isObjectLayer(layer)) {
      for (const keyframe of layer.keyframes) {
        if (keyframe.frame > frame) keyframe.frame -= 1
      }
      if (layer.keyframes.length > 1) removeKeyframe(layer, frame)
    } else {
      for (const cell of layer.cells) {
        if (cell.frame > frame) cell.frame -= 1
      }
      if (layer.cells.length > 1) removeCell(layer, frame)
    }
  }
  if (document.frames !== undefined) {
    document.frames = Math.max(1, document.frames - 1)
  }
}

/** Moves a layer to `toIndex` (0 = topmost). Returns true when it moved. */
export function moveLayer(document: AnimatorDocument, layerId: string, toIndex: number): boolean {
  const fromIndex = document.layers.findIndex((layer) => layer.id === layerId)
  if (fromIndex === -1) return false
  const clamped = Math.min(Math.max(0, toIndex), document.layers.length - 1)
  if (clamped === fromIndex) return false
  const [layer] = document.layers.splice(fromIndex, 1)
  document.layers.splice(clamped, 0, layer)
  return true
}

/** Renames a layer. Returns false when the layer does not exist. */
export function renameLayer(document: AnimatorDocument, layerId: string, name: string): boolean {
  const layer = getLayer(document, layerId)
  if (!layer) return false
  layer.name = name
  return true
}

export function addLayer(
  document: AnimatorDocument,
  name: string,
  position?: 'top' | 'bottom',
  kind?: 'object'
): ObjectLayer
export function addLayer(
  document: AnimatorDocument,
  name: string,
  position: 'top' | 'bottom' | undefined,
  kind: 'drawing'
): DrawingLayer
export function addLayer(
  document: AnimatorDocument,
  name: string,
  position: 'top' | 'bottom' = 'top',
  kind: Layer['kind'] = 'object'
): Layer {
  const layer: Layer = kind === 'drawing' ? createDrawingLayer(name) : createLayer(name)
  if (isObjectLayer(layer)) {
    layer.keyframes.push({ frame: 0, nodes: [] })
  }
  // New layers go on top unless explicitly appended at the bottom.
  if (position === 'bottom') document.layers.push(layer)
  else document.layers.unshift(layer)
  return layer
}

export function removeLayer(document: AnimatorDocument, layerId: string): boolean {
  const index = document.layers.findIndex((layer) => layer.id === layerId)
  if (index === -1 || document.layers.length === 1) return false
  document.layers.splice(index, 1)
  return true
}

export function cloneDocument(document: AnimatorDocument): AnimatorDocument {
  return structuredClone(document)
}

const EASING_NAMES: EasingName[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out']

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Structural validation for one scene node, keyed on the `type`
 * discriminant; recursive for groups. */
export function isSceneNode(value: unknown): value is SceneNode {
  if (typeof value !== 'object' || value === null) return false
  const node = value as Record<string, unknown> & Partial<SceneNode>
  if (typeof node.id !== 'string') return false
  if (node.name !== undefined && typeof node.name !== 'string') return false
  if (
    typeof node.center !== 'object' ||
    node.center === null ||
    !isFiniteNumber((node.center as { x?: unknown }).x) ||
    !isFiniteNumber((node.center as { y?: unknown }).y)
  ) {
    return false
  }
  if (!isFiniteNumber(node.width) || !isFiniteNumber(node.height)) return false
  if (!isFiniteNumber(node.rotation)) return false
  if (!isFiniteNumber(node.opacity)) return false
  switch (node.type) {
    case 'primitive':
      return (
        (node.primitive === 'rect' || node.primitive === 'ellipse') &&
        typeof node.fill === 'string' &&
        (node.stroke === undefined || typeof node.stroke === 'string') &&
        (node.strokeWidth === undefined || isFiniteNumber(node.strokeWidth))
      )
    case 'image':
      return (
        typeof node.resourceId === 'string' &&
        isFiniteNumber(node.naturalWidth) &&
        isFiniteNumber(node.naturalHeight) &&
        typeof node.smoothing === 'boolean'
      )
    case 'group':
      return Array.isArray(node.children) && node.children.every(isSceneNode)
    case 'symbol':
      return typeof node.assetId === 'string'
    case 'path':
      return (
        typeof node.d === 'string' &&
        (node.fill === undefined || typeof node.fill === 'string') &&
        (node.stroke === undefined || typeof node.stroke === 'string') &&
        (node.strokeWidth === undefined || isFiniteNumber(node.strokeWidth))
      )
    case 'text':
      return (
        typeof node.text === 'string' &&
        typeof node.fontFamily === 'string' &&
        isFiniteNumber(node.fontSize) &&
        isFiniteNumber(node.fontWeight) &&
        typeof node.fill === 'string' &&
        (node.align === 'left' || node.align === 'center' || node.align === 'right')
      )
    default:
      return false
  }
}

function isKeyframe(value: unknown): value is Keyframe {
  if (typeof value !== 'object' || value === null) return false
  const keyframe = value as Record<string, unknown> & Partial<Keyframe>
  if (!Number.isInteger(keyframe.frame) || (keyframe.frame as number) < 0) return false
  if (!Array.isArray(keyframe.nodes) || !keyframe.nodes.every(isSceneNode)) return false
  if (keyframe.tween === undefined) return true
  if (typeof keyframe.tween !== 'object' || keyframe.tween === null) return false
  return EASING_NAMES.includes((keyframe.tween as { easing?: unknown }).easing as EasingName)
}

function isDrawingCell(value: unknown): value is DrawingCell {
  if (typeof value !== 'object' || value === null) return false
  const cell = value as Record<string, unknown> & Partial<DrawingCell>
  return Number.isInteger(cell.frame) && (cell.frame as number) >= 0 && typeof cell.resourceId === 'string'
}

function isLayer(value: unknown): value is Layer {
  if (typeof value !== 'object' || value === null) return false
  const layer = value as Record<string, unknown> & Partial<Layer>
  if (
    typeof layer.id !== 'string' ||
    typeof layer.name !== 'string' ||
    typeof layer.visible !== 'boolean' ||
    typeof layer.locked !== 'boolean'
  ) {
    return false
  }
  if (layer.kind === 'object') {
    return Array.isArray(layer.keyframes) && layer.keyframes.every(isKeyframe)
  }
  if (layer.kind === 'drawing') {
    return (
      isFiniteNumber(layer.resolutionScale) &&
      (layer.resolutionScale as number) >= 1 &&
      Array.isArray(layer.cells) &&
      layer.cells.every(isDrawingCell)
    )
  }
  return false
}

/** Structural validation for one asset, keyed on the `kind` discriminant;
 * symbol content is validated through `isSceneNode`. */
export function isAsset(value: unknown): value is Asset {
  if (typeof value !== 'object' || value === null) return false
  const asset = value as Record<string, unknown> & Partial<Asset>
  if (typeof asset.id !== 'string' || typeof asset.name !== 'string') return false
  if (typeof asset.createdAt !== 'number' || !Number.isFinite(asset.createdAt)) return false
  if (asset.kind === 'symbol') {
    return (
      asset.content !== undefined &&
      isSceneNode(asset.content) &&
      asset.content.type === 'group'
    )
  }
  if (asset.kind === 'image') {
    return (
      typeof asset.resourceId === 'string' &&
      (asset.naturalWidth === undefined || isFiniteNumber(asset.naturalWidth)) &&
      (asset.naturalHeight === undefined || isFiniteNumber(asset.naturalHeight))
    )
  }
  return false
}

/** Deep structural validation for documents restored from persistence.
 * Requires `schemaVersion: 3` and fully typed content; older documents go
 * through `migrateDocument` first. */
export function isAnimatorDocument(value: unknown): value is AnimatorDocument {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<AnimatorDocument>
  const framesValid =
    candidate.frames === undefined ||
    (typeof candidate.frames === 'number' && Number.isInteger(candidate.frames) && candidate.frames >= 1)
  return (
    candidate.schemaVersion === 3 &&
    typeof candidate.name === 'string' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    typeof candidate.fps === 'number' &&
    candidate.fps > 0 &&
    typeof candidate.background === 'string' &&
    framesValid &&
    Array.isArray(candidate.layers) &&
    candidate.layers.every(isLayer) &&
    Array.isArray(candidate.assets) &&
    candidate.assets.every(isAsset)
  )
}
