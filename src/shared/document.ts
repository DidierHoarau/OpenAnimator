import { evaluateEasing, isEasing } from './easing'
import type { AnimatorDocument, Asset, AudioLayer, CameraKeyframe, CameraLayer, CameraPose, DrawingCell, DrawingLayer, EmbeddedFont, Keyframe, KeyframeTween, Layer, ObjectLayer, SceneNode } from './model'
import { cloneNode, isAudioLayer, isCameraLayer, isObjectLayer } from './model'
import { cubicBezierPoint, segmentControls } from './motionPath'
import { isPaintValue } from './paint'
import { formatHexColor, parseHexColor } from './color'
import { tweenNode } from './tween'
import { lerp } from './geometry'
import type { Vec2 } from './geometry'

/** Maximum number of colors in the document palette. */
export const MAX_PALETTE_COLORS = 48

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

/** A new camera layer starts without keyframes: it evaluates to no camera
 * until the first keyframe is inserted at the playhead. */
export function createCameraLayer(name: string): CameraLayer {
  return {
    kind: 'camera',
    id: createId('layer'),
    name,
    visible: true,
    locked: false,
    keyframes: []
  }
}

/** A new audio layer plays `resourceId` from frame 0 at full volume. */
export function createAudioLayer(resourceId: string, name: string): AudioLayer {
  return {
    kind: 'audio',
    id: createId('layer'),
    name,
    visible: true,
    locked: false,
    resourceId,
    startFrame: 0,
    volume: 1
  }
}

/** The default camera pose of a document: identity view centered on the
 * stage, used when the first camera keyframe has nothing to copy from. */
export function defaultCameraPose(document: AnimatorDocument): CameraPose {
  return { center: { x: document.width / 2, y: document.height / 2 }, zoom: 1, rotation: 0 }
}

export function createDocument(name: string, width: number, height: number, fps: number): AnimatorDocument {
  const layer = createLayer('Layer 1')
  layer.keyframes.push({ frame: 0, nodes: [] })
  return {
    schemaVersion: 7,
    name,
    width,
    height,
    fps,
    background: '#10151b',
    layers: [layer],
    frames: 1,
    assets: [],
    palette: [],
    fonts: []
  }
}

/** The document's hold step: absent ≡ 1 (every frame is addressed). */
export function holdStepOf(document: AnimatorDocument): number {
  return document.holdStep ?? 1
}

export function getLayer(document: AnimatorDocument, layerId: string): Layer | undefined {
  return document.layers.find((layer) => layer.id === layerId)
}

/** Total number of frames: the furthest keyframe, cell or clip start + 1 and
 * the authored length (`frames`), whichever is larger; at least 1. */
export function documentDuration(document: AnimatorDocument): number {
  let max = 0
  for (const layer of document.layers) {
    if (isObjectLayer(layer)) {
      for (const keyframe of layer.keyframes) {
        max = Math.max(max, keyframe.frame)
      }
    } else if (isCameraLayer(layer)) {
      for (const keyframe of layer.keyframes) {
        max = Math.max(max, keyframe.frame)
      }
    } else if (isAudioLayer(layer)) {
      max = Math.max(max, layer.startFrame)
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
 * Bezier center-path controls for the smooth segment starting at keyframe
 * index `sourceIndex` of `nodeId`: the Catmull-Rom handles derived from the
 * node's neighbouring keyframe centers. Falsy when the node has no full
 * segment there (callers then keep the straight lerp).
 */
function smoothControlsFor(
  layer: ObjectLayer,
  nodeId: string,
  sourceIndex: number
): { c1: Vec2; c2: Vec2 } | undefined {
  const points: Vec2[] = []
  let segmentIndex = -1
  for (let i = 0; i < layer.keyframes.length; i++) {
    const node = layer.keyframes[i].nodes.find((candidate) => candidate.id === nodeId)
    if (!node) continue
    if (i === sourceIndex) segmentIndex = points.length
    points.push(node.center)
  }
  if (segmentIndex === -1 || segmentIndex >= points.length - 1) return undefined
  return segmentControls(points, segmentIndex)
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
          const centerPath =
            source.tween.path === 'smooth'
              ? smoothControlsFor(layer, id, entry.index)
              : undefined
          result.push(tweenNode(entry.node, target, eased, centerPath))
          continue
        }
      }
    }
    result.push(entry.node)
  }
  return result
}

/** The document's camera layer, when it has one (at most one is allowed). */
export function cameraLayerOf(document: AnimatorDocument): CameraLayer | undefined {
  return document.layers.find((layer): layer is CameraLayer => isCameraLayer(layer))
}

/** Index of the last camera keyframe at or before `frame`, or -1 when none exists. */
export function findCameraKeyframeIndexForFrame(layer: CameraLayer, frame: number): number {
  let index = -1
  for (let i = 0; i < layer.keyframes.length; i++) {
    if (layer.keyframes[i].frame <= frame) index = i
    else break
  }
  return index
}

export function findCameraKeyframeAtFrame(layer: CameraLayer, frame: number): CameraKeyframe | undefined {
  return layer.keyframes.find((keyframe) => keyframe.frame === frame)
}

/** Bezier center-path controls for the smooth segment starting at camera
 * keyframe index `sourceIndex`: the Catmull-Rom handles derived from the
 * neighbouring keyframe centers, mirroring the node math of
 * `smoothControlsFor`. */
function smoothCameraControlsFor(layer: CameraLayer, sourceIndex: number): { c1: Vec2; c2: Vec2 } | undefined {
  if (sourceIndex < 0 || sourceIndex >= layer.keyframes.length - 1) return undefined
  return segmentControls(
    layer.keyframes.map((keyframe) => keyframe.pose.center),
    sourceIndex
  )
}

/** Independent copy of a camera pose. */
export function cloneCameraPose(pose: CameraPose): CameraPose {
  return { center: { ...pose.center }, zoom: pose.zoom, rotation: pose.rotation }
}

/**
 * Pose of the document camera at `frame`: null when the document has no
 * camera layer, the layer is hidden (a hidden camera is switched off) or it
 * has no keyframes yet. Hold-first/hold-last like object layers; a tweened
 * keyframe interpolates center, zoom and rotation toward the next camera
 * keyframe — `path: 'smooth'` bends the center along the Catmull-Rom path
 * through the camera keyframe centers.
 */
export function evaluateCameraAtFrame(document: AnimatorDocument, frame: number): CameraPose | null {
  const layer = cameraLayerOf(document)
  if (!layer || !layer.visible || layer.keyframes.length === 0) return null
  const index = findCameraKeyframeIndexForFrame(layer, frame)
  if (index === -1) return cloneCameraPose(layer.keyframes[0].pose)
  const source = layer.keyframes[index]
  const next = layer.keyframes[index + 1]
  if (!source.tween || !next) return cloneCameraPose(source.pose)
  const progress = (frame - source.frame) / (next.frame - source.frame)
  const eased = evaluateEasing(source.tween.easing, progress)
  const controls = source.tween.path === 'smooth' ? smoothCameraControlsFor(layer, index) : undefined
  return {
    center: controls
      ? cubicBezierPoint(source.pose.center, controls.c1, controls.c2, next.pose.center, eased)
      : {
          x: lerp(source.pose.center.x, next.pose.center.x, eased),
          y: lerp(source.pose.center.y, next.pose.center.y, eased)
        },
    zoom: lerp(source.pose.zoom, next.pose.zoom, eased),
    rotation: lerp(source.pose.rotation, next.pose.rotation, eased)
  }
}

/**
 * Inserts a camera keyframe at `frame`, copying the pose evaluated there
 * (hold-first/last, tween sampled) when `pose` is omitted — the document's
 * default identity pose when the camera has no keyframes yet. Returns the
 * created keyframe, or null when one already exists at `frame` or the
 * document has no camera layer.
 */
export function insertCameraKeyframe(
  document: AnimatorDocument,
  frame: number,
  pose?: CameraPose
): CameraKeyframe | null {
  const layer = cameraLayerOf(document)
  if (!layer || findCameraKeyframeAtFrame(layer, frame)) return null
  const keyframe: CameraKeyframe = {
    frame,
    pose: pose ? cloneCameraPose(pose) : (evaluateCameraAtFrame(document, frame) ?? defaultCameraPose(document))
  }
  layer.keyframes.push(keyframe)
  layer.keyframes.sort((a, b) => a.frame - b.frame)
  return keyframe
}

/** Removes the camera keyframe at `frame`. Returns true when one was removed. */
export function removeCameraKeyframe(document: AnimatorDocument, frame: number): boolean {
  const layer = cameraLayerOf(document)
  if (!layer) return false
  const index = layer.keyframes.findIndex((keyframe) => keyframe.frame === frame)
  if (index === -1) return false
  layer.keyframes.splice(index, 1)
  return true
}

/** One camera retime: the keyframe at `fromFrame` moves to `toFrame`. */
export interface CameraKeyframeMove {
  fromFrame: number
  toFrame: number
}

/**
 * Retimes camera keyframes (the timeline's marker drag). Effective moves
 * detach first, then re-attach at their target frames, merging over a
 * keyframe already there — the moved pose wins and its tween travels with
 * it. Returns false (and changes nothing) when no move has a matching source
 * keyframe, is out of range or is a no-op.
 */
export function moveCameraKeyframes(
  layer: CameraLayer,
  moves: readonly CameraKeyframeMove[],
  totalFrames: number
): boolean {
  const effective = moves.filter(
    (move) =>
      move.fromFrame !== move.toFrame &&
      move.toFrame >= 0 &&
      move.toFrame <= totalFrames - 1 &&
      layer.keyframes.some((keyframe) => keyframe.frame === move.fromFrame)
  )
  if (effective.length === 0) return false
  const detached: Array<{ toFrame: number; keyframe: CameraKeyframe }> = []
  for (const move of effective) {
    const index = layer.keyframes.findIndex((keyframe) => keyframe.frame === move.fromFrame)
    if (index === -1) continue
    const [keyframe] = layer.keyframes.splice(index, 1)
    detached.push({ toFrame: move.toFrame, keyframe })
  }
  for (const entry of detached) {
    const existing = layer.keyframes.findIndex((keyframe) => keyframe.frame === entry.toFrame)
    if (existing !== -1) layer.keyframes.splice(existing, 1)
    entry.keyframe.frame = entry.toFrame
    layer.keyframes.push(entry.keyframe)
  }
  layer.keyframes.sort((a, b) => a.frame - b.frame)
  return true
}

/** End frame of an audio clip of `durationSeconds` starting at the layer's
 * `startFrame` (callers supply the decoded duration; the document stores
 * none). */
export function audioClipEndFrame(document: AnimatorDocument, layer: AudioLayer, durationSeconds: number): number {
  return layer.startFrame + Math.max(0, Math.round(durationSeconds * document.fps))
}

/** Moves an audio clip to `startFrame`, clamped to frame 0. Returns true
 * when the clip moved. */
export function setAudioClipStart(layer: AudioLayer, startFrame: number): boolean {
  const clamped = Math.max(0, Math.round(startFrame))
  if (clamped === layer.startFrame) return false
  layer.startFrame = clamped
  return true
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

/** Inserts a frame on the timeline: shifts the keyframes of object and
 * camera layers, the cells of drawing layers and the clip starts of audio
 * layers strictly after `frame` one frame later (extending the hold of the
 * content active at the playhead) and grows the document's authored timeline
 * so the playhead can move past the last content. */
export function insertFrame(document: AnimatorDocument, layerId: string, frame: number): void {
  const layer = getLayer(document, layerId)
  if (!layer) return
  for (const target of document.layers) {
    if (isObjectLayer(target) || isCameraLayer(target)) {
      for (const keyframe of target.keyframes) {
        if (keyframe.frame > frame) keyframe.frame += 1
      }
    } else if (isAudioLayer(target)) {
      if (target.startFrame > frame) target.startFrame += 1
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
 * One requested single-entry move: the node's own pose at `fromFrame` moves
 * to `toFrame`. The move carries only the pose — a tween always belongs to
 * the keyframe it was set on.
 */
export interface KeyframeEntryMove {
  nodeId: string
  fromFrame: number
  toFrame: number
}

/**
 * Moves keyframe entries (one node's pose per move) to new frames — the
 * timeline's drag operation. All entries detach first, keyframes emptied by
 * the move are dropped (their tween goes with them), then every entry
 * re-attaches at its target frame, merging into a keyframe already there
 * (replace semantics) with the other nodes untouched. The tween belongs to
 * the source keyframe and never transfers; the destination keyframe keeps
 * its own tween. Returns false (and changes nothing) when no move has a
 * matching source entry, is out of range or is a no-op.
 */
export function moveKeyframeEntries(
  layer: ObjectLayer,
  moves: readonly KeyframeEntryMove[],
  totalFrames: number
): boolean {
  const effective = moves.filter(
    (move) =>
      move.fromFrame !== move.toFrame &&
      move.toFrame >= 0 &&
      move.toFrame <= totalFrames - 1 &&
      layer.keyframes.some(
        (keyframe) =>
          keyframe.frame === move.fromFrame &&
          keyframe.nodes.some((node) => node.id === move.nodeId)
      )
  )
  if (effective.length === 0) return false
  const detached: Array<{ nodeId: string; toFrame: number; node: SceneNode }> = []
  for (const move of effective) {
    const keyframe = layer.keyframes.find((candidate) => candidate.frame === move.fromFrame)!
    const index = keyframe.nodes.findIndex((node) => node.id === move.nodeId)
    if (index === -1) continue
    const [node] = keyframe.nodes.splice(index, 1)
    detached.push({ nodeId: move.nodeId, toFrame: move.toFrame, node })
    if (keyframe.nodes.length === 0) {
      layer.keyframes.splice(layer.keyframes.indexOf(keyframe), 1)
    }
  }
  for (const entry of detached) {
    let target = layer.keyframes.find((keyframe) => keyframe.frame === entry.toFrame)
    if (!target) {
      target = { frame: entry.toFrame, nodes: [] }
      layer.keyframes.push(target)
    }
    const existing = target.nodes.findIndex((node) => node.id === entry.nodeId)
    if (existing !== -1) target.nodes.splice(existing, 1)
    target.nodes.push(entry.node)
  }
  layer.keyframes.sort((a, b) => a.frame - b.frame)
  return true
}

/** Single-entry convenience wrapper over `moveKeyframeEntries`. */
export function moveNodeKeyframeEntry(
  layer: ObjectLayer,
  nodeId: string,
  fromFrame: number,
  toFrame: number,
  totalFrames: number
): boolean {
  return moveKeyframeEntries(layer, [{ nodeId, fromFrame, toFrame }], totalFrames)
}

/** One copied keyframe entry: a node pose at an offset from the chunk start. */
export interface KeyframeChunkEntry {
  nodeId: string
  /** Keyframe frame of the source minus the chunk's `fromFrame`. */
  offset: number
  node: SceneNode
  /** Tween of the source keyframe, carried only by entries that owned it. */
  tween?: KeyframeTween
}

/**
 * Extracts keyframe content as a reusable chunk (the clipboard): for every
 * keyframe in `[fromFrame, toFrame]` that holds one of `nodeIds` (all nodes
 * when omitted), the node's pose becomes an entry at
 * `offset = keyframe.frame - fromFrame`. A keyframe's tween is carried by the
 * entry that owns it — each source keyframe has at most one such entry, the
 * first node id present in it, so applying the chunk can restore it exactly.
 */
export function extractKeyframeChunk(
  layer: ObjectLayer,
  fromFrame: number,
  toFrame: number,
  nodeIds?: readonly string[]
): KeyframeChunkEntry[] {
  const filter = nodeIds ? new Set(nodeIds) : null
  const entries: KeyframeChunkEntry[] = []
  for (const keyframe of layer.keyframes) {
    if (keyframe.frame < fromFrame || keyframe.frame > toFrame) continue
    let tweenOwner = -1
    keyframe.nodes.forEach((node) => {
      if (filter && !filter.has(node.id)) return
      if (tweenOwner === -1) tweenOwner = entries.length
      entries.push({
        nodeId: node.id,
        offset: keyframe.frame - fromFrame,
        node: cloneNode(node)
      })
    })
    if (keyframe.tween !== undefined && tweenOwner !== -1 && tweenOwner < entries.length) {
      entries[tweenOwner].tween = structuredClone(keyframe.tween)
    }
  }
  return entries
}

/**
 * Applies a chunk at `targetFrame`: every entry lands on
 * `targetFrame + offset` (out-of-range entries are skipped). A keyframe is
 * found or created there; an entry for the same node already present is
 * replaced, otherwise the pose is appended — existing keyframes and their
 * other nodes survive, and an existing tween is never cleared. Returns true
 * when content changed.
 */
export function applyKeyframeChunk(
  layer: ObjectLayer,
  chunk: readonly KeyframeChunkEntry[],
  targetFrame: number,
  totalFrames: number
): boolean {
  let changed = false
  for (const entry of chunk) {
    const frame = targetFrame + entry.offset
    if (frame < 0 || frame > totalFrames - 1) continue
    let keyframe = layer.keyframes.find((candidate) => candidate.frame === frame)
    if (!keyframe) {
      keyframe = { frame, nodes: [] }
      layer.keyframes.push(keyframe)
    }
    const index = keyframe.nodes.findIndex((node) => node.id === entry.nodeId)
    if (index !== -1) keyframe.nodes.splice(index, 1)
    keyframe.nodes.push(cloneNode(entry.node))
    if (entry.tween !== undefined && keyframe.tween === undefined) {
      keyframe.tween = structuredClone(entry.tween)
    }
    changed = true
  }
  if (changed) layer.keyframes.sort((a, b) => a.frame - b.frame)
  return changed
}

export function removeFrame(document: AnimatorDocument, frame: number): void {
  for (const layer of document.layers) {
    if (isObjectLayer(layer)) {
      for (const keyframe of layer.keyframes) {
        if (keyframe.frame > frame) keyframe.frame -= 1
      }
      if (layer.keyframes.length > 1) removeKeyframe(layer, frame)
    } else if (isCameraLayer(layer)) {
      for (const keyframe of layer.keyframes) {
        if (keyframe.frame > frame) keyframe.frame -= 1
      }
      // Like object layers, never strip the layer of its last keyframe.
      if (layer.keyframes.length > 1) {
        const index = layer.keyframes.findIndex((keyframe) => keyframe.frame === frame)
        if (index !== -1) layer.keyframes.splice(index, 1)
      }
    } else if (isAudioLayer(layer)) {
      if (layer.startFrame > frame) layer.startFrame -= 1
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
  position: 'top' | 'bottom' | undefined,
  kind: 'camera'
): CameraLayer
export function addLayer(
  document: AnimatorDocument,
  name: string,
  position: 'top' | 'bottom' | undefined,
  kind: 'audio',
  resourceId: string
): AudioLayer
export function addLayer(
  document: AnimatorDocument,
  name: string,
  position: 'top' | 'bottom' = 'top',
  kind: Layer['kind'] = 'object',
  resourceId?: string
): Layer {
  const layer: Layer =
    kind === 'drawing'
      ? createDrawingLayer(name)
      : kind === 'camera'
        ? createCameraLayer(name)
        : kind === 'audio'
          ? createAudioLayer(resourceId ?? '', name)
          : createLayer(name)
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
        isPaintValue(node.fill) &&
        (node.stroke === undefined || isPaintValue(node.stroke)) &&
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
        (node.fill === undefined || isPaintValue(node.fill)) &&
        (node.stroke === undefined || isPaintValue(node.stroke)) &&
        (node.strokeWidth === undefined || isFiniteNumber(node.strokeWidth))
      )
    case 'text':
      return (
        typeof node.text === 'string' &&
        typeof node.fontFamily === 'string' &&
        isFiniteNumber(node.fontSize) &&
        isFiniteNumber(node.fontWeight) &&
        isPaintValue(node.fill) &&
        (node.align === 'left' || node.align === 'center' || node.align === 'right') &&
        (node.letterSpacing === undefined || isFiniteNumber(node.letterSpacing)) &&
        (node.lineHeight === undefined ||
          (isFiniteNumber(node.lineHeight) && node.lineHeight >= 0.5 && node.lineHeight <= 5)) &&
        (node.stroke === undefined || isPaintValue(node.stroke)) &&
        (node.strokeWidth === undefined || isFiniteNumber(node.strokeWidth)) &&
        (node.verticalAlign === undefined ||
          node.verticalAlign === 'top' ||
          node.verticalAlign === 'middle' ||
          node.verticalAlign === 'bottom') &&
        (node.fontFallback === undefined || isFontFallback(node.fontFallback))
      )
    default:
      return false
  }
}

function isTween(value: unknown): value is KeyframeTween {
  if (typeof value !== 'object' || value === null) return false
  const tween = value as { easing?: unknown; path?: unknown }
  if (tween.path !== undefined && tween.path !== 'linear' && tween.path !== 'smooth') return false
  return isEasing(tween.easing)
}

function isKeyframe(value: unknown): value is Keyframe {
  if (typeof value !== 'object' || value === null) return false
  const keyframe = value as Record<string, unknown> & Partial<Keyframe>
  if (!Number.isInteger(keyframe.frame) || (keyframe.frame as number) < 0) return false
  if (!Array.isArray(keyframe.nodes) || !keyframe.nodes.every(isSceneNode)) return false
  return keyframe.tween === undefined || isTween(keyframe.tween)
}

/** Structural validation for one camera pose: finite center, zoom > 0 and a
 * finite rotation. */
export function isCameraPose(value: unknown): value is CameraPose {
  if (typeof value !== 'object' || value === null) return false
  const pose = value as { center?: unknown; zoom?: unknown; rotation?: unknown }
  return (
    typeof pose.center === 'object' &&
    pose.center !== null &&
    isFiniteNumber((pose.center as { x?: unknown }).x) &&
    isFiniteNumber((pose.center as { y?: unknown }).y) &&
    isFiniteNumber(pose.zoom) &&
    pose.zoom > 0 &&
    isFiniteNumber(pose.rotation)
  )
}

/** Structural validation for one camera keyframe. */
export function isCameraKeyframe(value: unknown): value is CameraKeyframe {
  if (typeof value !== 'object' || value === null) return false
  const keyframe = value as Record<string, unknown> & Partial<CameraKeyframe>
  if (!Number.isInteger(keyframe.frame) || (keyframe.frame as number) < 0) return false
  if (!isCameraPose(keyframe.pose)) return false
  return keyframe.tween === undefined || isTween(keyframe.tween)
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
  if (layer.kind === 'camera') {
    return Array.isArray(layer.keyframes) && layer.keyframes.every(isCameraKeyframe)
  }
  if (layer.kind === 'audio') {
    return (
      typeof layer.resourceId === 'string' &&
      Number.isInteger(layer.startFrame) &&
      (layer.startFrame as number) >= 0 &&
      isFiniteNumber(layer.volume) &&
      (layer.volume as number) >= 0 &&
      (layer.volume as number) <= 1
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

/** True when `value` is a valid text-node fallback list: up to 8 family
 * names. */
export function isFontFallback(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every((family) => typeof family === 'string')
  )
}

/** Structural validation for one embedded font subset. */
export function isEmbeddedFont(value: unknown): value is EmbeddedFont {
  if (typeof value !== 'object' || value === null) return false
  const font = value as Record<string, unknown> & Partial<EmbeddedFont>
  return (
    typeof font.id === 'string' &&
    typeof font.family === 'string' &&
    typeof font.weight === 'number' &&
    Number.isFinite(font.weight) &&
    font.weight >= 1 &&
    font.weight <= 1000 &&
    typeof font.resourceId === 'string' &&
    Array.isArray(font.glyphs) &&
    font.glyphs.every((glyph) => typeof glyph === 'string') &&
    typeof font.license === 'string'
  )
}

/** True when `value` is a valid document palette: up to `MAX_PALETTE_COLORS`
 * `#rgb`/`#rrggbb` color strings. */
export function isPalette(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_PALETTE_COLORS &&
    value.every((color) => typeof color === 'string' && parseHexColor(color) !== null)
  )
}

/**
 * Normalizes a palette color list for storage: entries are rewritten to
 * lowercase `#rrggbb`, deduplicated, capped at `MAX_PALETTE_COLORS` and
 * invalid entries are dropped — the shared behavior of the document palette
 * setter and the persistent global palette store.
 */
export function normalizePaletteColors(colors: readonly string[]): string[] {
  const out: string[] = []
  for (const color of colors) {
    if (out.length >= MAX_PALETTE_COLORS) break
    if (typeof color !== 'string') continue
    const rgb = parseHexColor(color)
    if (!rgb) continue
    const hex = formatHexColor(rgb)
    if (!out.includes(hex)) out.push(hex)
  }
  return out
}

/** Deep structural validation for documents restored from persistence.
 * Requires `schemaVersion: 7` and fully typed content; older documents go
 * through `migrateDocument` first. */
export function isAnimatorDocument(value: unknown): value is AnimatorDocument {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<AnimatorDocument>
  const framesValid =
    candidate.frames === undefined ||
    (typeof candidate.frames === 'number' && Number.isInteger(candidate.frames) && candidate.frames >= 1)
  const holdStepValid =
    candidate.holdStep === undefined ||
    (typeof candidate.holdStep === 'number' &&
      Number.isInteger(candidate.holdStep) &&
      candidate.holdStep >= 1 &&
      candidate.holdStep <= 16)
  return (
    candidate.schemaVersion === 7 &&
    typeof candidate.name === 'string' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    typeof candidate.fps === 'number' &&
    candidate.fps > 0 &&
    typeof candidate.background === 'string' &&
    framesValid &&
    holdStepValid &&
    isPalette(candidate.palette) &&
    Array.isArray(candidate.layers) &&
    candidate.layers.every(isLayer) &&
    Array.isArray(candidate.assets) &&
    candidate.assets.every(isAsset) &&
    Array.isArray(candidate.fonts) &&
    candidate.fonts.every(isEmbeddedFont)
  )
}
