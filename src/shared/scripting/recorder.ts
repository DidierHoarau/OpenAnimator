import type { Easing } from '../easing'
import {
  cloneDocument,
  defaultCameraPose,
  documentDuration,
  holdStepOf,
  insertFrame,
  removeFrame
} from '../document'
import type {
  AnimatorDocument,
  AudioLayer,
  CameraLayer,
  DrawingLayer,
  KeyframeTween,
  Layer,
  ObjectLayer,
  SceneNode,
  TweenChannel
} from '../model'
import type { ScriptCommand } from './commands'
import { TWEEN_CHANNELS } from './documentSchema'

/**
 * The script recorder's pure diff engine: given two document states (a
 * snapshot taken before a committed gesture and the next one), it derives the
 * minimal command sequence that turns the first into the second, using the
 * real ids and the gesture's frame context. The commands are plain
 * `ScriptCommand`s — they replay through `executeScriptCommands`, the exact
 * pipeline the console uses (one-pipeline principle: there is no translation
 * layer between the recorder and the executor).
 *
 * Everything the diff cannot express as commands (no op exists for it —
 * stage size, asset/font library edits, visibility/lock toggles, layer
 * reordering, cell removal, ...) is reported through `unsupported` so the
 * console can tell the user the recording is partial.
 */

/** Frame context of one recorded gesture: where the playhead was and which
 * layer was current while the gesture ran. Only the frame operations need it
 * (the after-state alone cannot tell where an inserted frame went). */
export interface RecorderFrameContext {
  frame: number
  layerId: string | null
}

export interface RecorderDiffResult {
  commands: ScriptCommand[]
  unsupported: string[]
}

type SetTweenCommand = Extract<ScriptCommand, { op: 'setTween' }>
type SetAudioCommand = Extract<ScriptCommand, { op: 'setAudio' }>

/** Structural deep equality over JSON-shaped values (key order insensitive,
 * `undefined` ≡ absent). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    for (const key of keys) {
      if (!deepEqual(left[key], right[key])) return false
    }
    return true
  }
  return false
}

/** Fields a node patch can carry, per node kind (mirrors the patchable set of
 * the command schema; `id` never changes and is not patchable). */
const STROKE_STYLE_FIELDS = [
  'strokeLinecap',
  'strokeLinejoin',
  'strokeDasharray',
  'strokeDashoffset'
] as const
const COMMON_NODE_FIELDS = ['name', 'center', 'width', 'height', 'rotation', 'opacity'] as const
const STROKED_NODE_FIELDS = ['stroke', 'strokeWidth', ...STROKE_STYLE_FIELDS] as const

const KIND_PATCH_FIELDS: Record<SceneNode['type'], readonly string[]> = {
  primitive: [...COMMON_NODE_FIELDS, 'fill', ...STROKED_NODE_FIELDS],
  path: [...COMMON_NODE_FIELDS, 'd', 'fill', ...STROKED_NODE_FIELDS],
  text: [
    ...COMMON_NODE_FIELDS,
    'text',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'ligatures',
    'fill',
    'align',
    'letterSpacing',
    'lineHeight',
    'verticalAlign',
    'fontFallback',
    ...STROKED_NODE_FIELDS
  ],
  image: [...COMMON_NODE_FIELDS],
  group: [...COMMON_NODE_FIELDS],
  symbol: [...COMMON_NODE_FIELDS]
}

/** Fields a node patch cannot carry (structural edits have no command). */
const NON_PATCHABLE_FIELDS = [
  'type',
  'primitive',
  'resourceId',
  'naturalWidth',
  'naturalHeight',
  'smoothing',
  'assetId',
  'children'
] as const

function nonPatchableOf(node: SceneNode): Record<string, unknown> {
  const record = node as unknown as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const field of NON_PATCHABLE_FIELDS) {
    if (record[field] !== undefined) result[field] = record[field]
  }
  return result
}

/** Minimal patch turning `before` into `after` (same node id and kind):
 * changed fields only, `null` for cleared optional fields. Fields the patch
 * contract cannot carry are reported instead. */
function minimalNodePatch(
  before: SceneNode,
  after: SceneNode
): { patch: Record<string, unknown>; unsupported: string[] } {
  const patch: Record<string, unknown> = {}
  const unsupported: string[] = []
  const b = before as unknown as Record<string, unknown>
  const a = after as unknown as Record<string, unknown>
  for (const field of KIND_PATCH_FIELDS[after.type]) {
    if (field === 'center') {
      if (!deepEqual(before.center, after.center)) {
        patch.center = { x: after.center.x, y: after.center.y }
      }
      continue
    }
    if (deepEqual(b[field], a[field])) continue
    patch[field] = a[field] === undefined ? null : a[field]
  }
  for (const field of NON_PATCHABLE_FIELDS) {
    if (!deepEqual(b[field], a[field])) unsupported.push(field)
  }
  return { patch, unsupported }
}

/** Full patch of a node pose: every patchable field of the kind with its
 * value, `null` for absent optional fields. Used to recreate a pose at an
 * added keyframe via `setKeyframe` (the executor patches a clone of the
 * nearest existing pose). */
function fullNodePatch(node: SceneNode): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const record = node as unknown as Record<string, unknown>
  for (const field of KIND_PATCH_FIELDS[node.type]) {
    if (field === 'center') {
      patch.center = { x: node.center.x, y: node.center.y }
      continue
    }
    const value = record[field]
    patch[field] = value === undefined ? null : value
  }
  return patch
}

/** Non-empty per-channel easing overrides, or undefined (empty ≡ absent —
 * the editor drops an emptied `easings` field). */
function normalizedChannelEasings(
  tween: KeyframeTween | undefined
): Partial<Record<TweenChannel, Easing>> | undefined {
  if (!tween?.easings) return undefined
  const kept: Partial<Record<TweenChannel, Easing>> = {}
  let any = false
  for (const channel of TWEEN_CHANNELS) {
    const easing = tween.easings[channel]
    if (easing !== undefined) {
      kept[channel] = easing
      any = true
    }
  }
  return any ? kept : undefined
}

/**
 * The `setTween` command turning `before` into `after` on an object
 * keyframe, or null when the tweens already match. `easing` is always
 * included when a command is emitted (an omitted easing would default to
 * `ease-in-out` in the executor).
 */
function objectTweenCommand(
  layerId: string,
  frame: number,
  before: KeyframeTween | undefined,
  after: KeyframeTween | undefined
): SetTweenCommand | null {
  if (!before && !after) return null
  if (before && !after) return { op: 'setTween', layerId, frame, easing: null }
  if (!before && after) {
    const command: SetTweenCommand = { op: 'setTween', layerId, frame, easing: after.easing }
    if (after.path) command.path = after.path
    const easings = normalizedChannelEasings(after)
    if (easings) command.easings = { ...easings }
    return command
  }
  const source = before as KeyframeTween
  const target = after as KeyframeTween
  const beforeEasings = normalizedChannelEasings(source)
  const afterEasings = normalizedChannelEasings(target)
  const easingChanged = !deepEqual(source.easing, target.easing)
  const pathChanged = (source.path ?? 'linear') !== (target.path ?? 'linear')
  const channelChanges: Partial<Record<TweenChannel, Easing | null>> = {}
  let easingsChanged = false
  for (const channel of TWEEN_CHANNELS) {
    const previous = beforeEasings?.[channel]
    const next = afterEasings?.[channel]
    if (!deepEqual(previous, next)) {
      channelChanges[channel] = next === undefined ? null : next
      easingsChanged = true
    }
  }
  if (!easingChanged && !pathChanged && !easingsChanged) return null
  const command: SetTweenCommand = { op: 'setTween', layerId, frame, easing: target.easing }
  if (pathChanged) command.path = target.path ?? 'linear'
  if (easingsChanged) command.easings = channelChanges
  return command
}

/** Camera variant of the tween diff (no per-channel easings: the executor
 * ignores them on camera layers). */
function cameraTweenCommand(
  layerId: string,
  frame: number,
  before: KeyframeTween | undefined,
  after: KeyframeTween | undefined
): SetTweenCommand | null {
  if (!before && !after) return null
  if (before && !after) return { op: 'setTween', layerId, frame, easing: null }
  if (!before && after) {
    const command: SetTweenCommand = { op: 'setTween', layerId, frame, easing: after.easing }
    if (after.path) command.path = after.path
    return command
  }
  const source = before as KeyframeTween
  const target = after as KeyframeTween
  const easingChanged = !deepEqual(source.easing, target.easing)
  const pathChanged = (source.path ?? 'linear') !== (target.path ?? 'linear')
  if (!easingChanged && !pathChanged) return null
  const command: SetTweenCommand = { op: 'setTween', layerId, frame, easing: target.easing }
  if (pathChanged) command.path = target.path ?? 'linear'
  return command
}

/**
 * Lightweight replay simulation of the keyframe state (node id order per
 * keyframe plus tween presence), mirroring the executor's semantics for the
 * commands the diff plans. It never touches poses — it verifies that the
 * planned commands reproduce the after-state's structure (keyframe frames
 * and node stacking order, including keyframes dropped with their tweens)
 * before they are emitted; a mismatch is reported as an unsupported change.
 * Tween presence is not verified here: the emitted `setTween` commands
 * overwrite the replayed tween on every keyframe that exists (verified
 * above), so they repair any presence difference by construction.
 */
interface LayerSim {
  frames: Map<number, string[]>
  tweens: Map<number, KeyframeTween | undefined>
}

function seedSim(layer: ObjectLayer | CameraLayer): LayerSim {
  const sim: LayerSim = { frames: new Map(), tweens: new Map() }
  for (const keyframe of layer.keyframes) {
    const nodes = 'nodes' in keyframe ? keyframe.nodes : []
    sim.frames.set(keyframe.frame, nodes.map((node) => node.id))
    sim.tweens.set(keyframe.frame, keyframe.tween)
  }
  return sim
}

function simDropIfEmpty(sim: LayerSim, frame: number): void {
  const ids = sim.frames.get(frame)
  if (ids && ids.length === 0) {
    sim.frames.delete(frame)
    sim.tweens.delete(frame)
  }
}

function simDelete(sim: LayerSim, nodeId: string): void {
  for (const [frame, ids] of [...sim.frames]) {
    const index = ids.indexOf(nodeId)
    if (index === -1) continue
    ids.splice(index, 1)
    simDropIfEmpty(sim, frame)
  }
}

function simMove(sim: LayerSim, nodeId: string, fromFrame: number, toFrame: number): void {
  const from = sim.frames.get(fromFrame)
  if (!from) return
  const index = from.indexOf(nodeId)
  if (index === -1) return
  from.splice(index, 1)
  simDropIfEmpty(sim, fromFrame)
  let target = sim.frames.get(toFrame)
  if (!target) {
    target = []
    sim.frames.set(toFrame, target)
    sim.tweens.set(toFrame, undefined)
  }
  const existing = target.indexOf(nodeId)
  if (existing !== -1) target.splice(existing, 1)
  target.push(nodeId)
}

function simPush(sim: LayerSim, nodeId: string, frame: number): void {
  let target = sim.frames.get(frame)
  if (!target) {
    target = []
    sim.frames.set(frame, target)
    sim.tweens.set(frame, undefined)
  }
  target.push(nodeId)
}

function simRemoveEntry(sim: LayerSim, nodeId: string, frame: number): void {
  const ids = sim.frames.get(frame)
  if (!ids) return
  const index = ids.indexOf(nodeId)
  if (index === -1) return
  ids.splice(index, 1)
  simDropIfEmpty(sim, frame)
}

function simMatchesLayer(sim: LayerSim, layer: ObjectLayer): boolean {
  if (sim.frames.size !== layer.keyframes.length) return false
  for (const keyframe of layer.keyframes) {
    const ids = sim.frames.get(keyframe.frame)
    if (!ids || ids.length !== keyframe.nodes.length) return false
    for (let index = 0; index < ids.length; index += 1) {
      if (ids[index] !== keyframe.nodes[index].id) return false
    }
  }
  return true
}

/** A node's poses by frame within one layer, in keyframe order. */
function posesByNode(layer: ObjectLayer): Map<string, Map<number, SceneNode>> {
  const poses = new Map<string, Map<number, SceneNode>>()
  for (const keyframe of layer.keyframes) {
    for (const node of keyframe.nodes) {
      let byFrame = poses.get(node.id)
      if (!byFrame) {
        byFrame = new Map()
        poses.set(node.id, byFrame)
      }
      byFrame.set(keyframe.frame, node)
    }
  }
  return poses
}

interface ObjectLayerPlan {
  deletes: string[]
  moves: Array<{ nodeId: string; fromFrame: number; toFrame: number }>
  adds: Array<{ node: SceneNode; frame: number }>
  sets: Array<{ nodeId: string; frame: number; patch: Record<string, unknown> }>
  removes: Array<{ nodeId: string; frame: number }>
  updates: Array<{ nodeId: string; frame: number; patch: Record<string, unknown> }>
}

function buildObjectPlan(
  before: ObjectLayer,
  after: ObjectLayer,
  unsupported: string[]
): ObjectLayerPlan {
  const plan: ObjectLayerPlan = { deletes: [], moves: [], adds: [], sets: [], removes: [], updates: [] }
  const beforePoses = posesByNode(before)
  const afterPoses = posesByNode(after)
  const label = `layer "${after.name}"`

  for (const nodeId of beforePoses.keys()) {
    if (!afterPoses.has(nodeId)) plan.deletes.push(nodeId)
  }

  for (const [nodeId, afterFrames] of afterPoses) {
    const beforeFrames = beforePoses.get(nodeId)
    if (!beforeFrames) {
      // Brand-new node: one addNode carries the full node JSON (exact,
      // non-patchable fields included); further poses are keyframe clones
      // with a full patch.
      const frames = [...afterFrames.keys()].sort((a, b) => a - b)
      plan.adds.push({ node: cloneNodeJson(afterFrames.get(frames[0])!), frame: frames[0] })
      for (const frame of frames.slice(1)) {
        checkCloneablePose(afterFrames.get(frame)!, [...afterFrames.values()], label, nodeId, frame, unsupported)
        plan.sets.push({ nodeId, frame, patch: fullNodePatch(afterFrames.get(frame)!) })
      }
      continue
    }
    const removedFrames = [...beforeFrames.keys()].filter((frame) => !afterFrames.has(frame)).sort((a, b) => a - b)
    const addedFrames = [...afterFrames.keys()].filter((frame) => !beforeFrames.has(frame)).sort((a, b) => a - b)
    if (
      removedFrames.length === 1 &&
      addedFrames.length === 1 &&
      deepEqual(beforeFrames.get(removedFrames[0]), afterFrames.get(addedFrames[0]))
    ) {
      plan.moves.push({ nodeId, fromFrame: removedFrames[0], toFrame: addedFrames[0] })
    } else {
      for (const frame of addedFrames) {
        checkCloneablePose(
          afterFrames.get(frame)!,
          [...beforeFrames.values()],
          label,
          nodeId,
          frame,
          unsupported
        )
        plan.sets.push({ nodeId, frame, patch: fullNodePatch(afterFrames.get(frame)!) })
      }
      for (const frame of removedFrames) {
        plan.removes.push({ nodeId, frame })
      }
    }
    for (const [frame, pose] of afterFrames) {
      const previous = beforeFrames.get(frame)
      if (!previous || deepEqual(previous, pose)) continue
      const { patch, unsupported: fields } = minimalNodePatch(previous, pose)
      if (Object.keys(patch).length > 0) plan.updates.push({ nodeId, frame, patch })
      if (fields.length > 0) {
        unsupported.push(
          `${label}: node ${nodeId} ${fields.join(', ')} change at frame ${frame} is not recorded`
        )
      }
    }
  }
  return plan
}

/** Pose JSON is copied so the command payload never aliases live documents. */
function cloneNodeJson(node: SceneNode): SceneNode {
  return structuredClone(node)
}

/** A pose recreated via `setKeyframe` clones its nearest pose and patches, so
 * its non-patchable fields must match every existing pose of the node. */
function checkCloneablePose(
  pose: SceneNode,
  sources: SceneNode[],
  label: string,
  nodeId: string,
  frame: number,
  unsupported: string[]
): void {
  const residual = nonPatchableOf(pose)
  for (const source of sources) {
    if (!deepEqual(nonPatchableOf(source), residual)) {
      unsupported.push(
        `${label}: node ${nodeId} pose at frame ${frame} cannot be replayed exactly (non-patchable fields differ)`
      )
      return
    }
  }
}

function runObjectPlan(
  before: ObjectLayer,
  plan: ObjectLayerPlan,
  order: 'moves-first' | 'sets-first'
): LayerSim {
  const sim = seedSim(before)
  for (const nodeId of plan.deletes) simDelete(sim, nodeId)
  const applyMoves = (): void => {
    for (const move of plan.moves) simMove(sim, move.nodeId, move.fromFrame, move.toFrame)
  }
  const applyAdds = (): void => {
    for (const add of plan.adds) simPush(sim, add.node.id, add.frame)
  }
  const applySets = (): void => {
    for (const set of plan.sets) simPush(sim, set.nodeId, set.frame)
  }
  const applyRemoves = (): void => {
    for (const remove of plan.removes) simRemoveEntry(sim, remove.nodeId, remove.frame)
  }
  if (order === 'moves-first') {
    applyMoves()
    applyAdds()
    applySets()
    applyRemoves()
  } else {
    applyAdds()
    applySets()
    applyRemoves()
    applyMoves()
  }
  return sim
}

function diffObjectLayer(
  before: ObjectLayer,
  after: ObjectLayer,
  commands: ScriptCommand[],
  unsupported: string[]
): void {
  const layerId = after.id
  const plan = buildObjectPlan(before, after, unsupported)
  const simA = runObjectPlan(before, plan, 'moves-first')
  const simB = runObjectPlan(before, plan, 'sets-first')
  const order: 'moves-first' | 'sets-first' =
    !simMatchesLayer(simA, after) && simMatchesLayer(simB, after) ? 'sets-first' : 'moves-first'
  const sim = order === 'moves-first' ? simA : simB
  if (!simMatchesLayer(sim, after)) {
    unsupported.push(
      `layer "${after.name}": node stacking order cannot be replayed exactly (no reorder command exists)`
    )
  }

  const emitDeletes = (): void => {
    for (const nodeId of plan.deletes) commands.push({ op: 'deleteNode', nodeId, layerId })
  }
  const emitMoves = (): void => {
    for (const move of plan.moves) {
      commands.push({
        op: 'moveKeyframe',
        nodeId: move.nodeId,
        layerId,
        fromFrame: move.fromFrame,
        toFrame: move.toFrame
      })
    }
  }
  const emitAdds = (): void => {
    for (const add of plan.adds) {
      commands.push({
        op: 'addNode',
        node: add.node as unknown as Record<string, unknown>,
        layerId,
        frame: add.frame
      })
    }
  }
  const emitSets = (): void => {
    for (const set of plan.sets) {
      commands.push({ op: 'setKeyframe', nodeId: set.nodeId, layerId, frame: set.frame, patch: set.patch })
    }
  }
  const emitRemoves = (): void => {
    for (const remove of plan.removes) {
      commands.push({ op: 'removeNodeKeyframe', nodeId: remove.nodeId, layerId, frame: remove.frame })
    }
  }
  const emitUpdates = (): void => {
    for (const update of plan.updates) {
      commands.push({
        op: 'updateNode',
        nodeId: update.nodeId,
        layerId,
        frame: update.frame,
        patch: update.patch
      })
    }
  }

  if (order === 'moves-first') {
    emitDeletes()
    emitMoves()
    emitAdds()
    emitSets()
    emitRemoves()
    emitUpdates()
  } else {
    emitDeletes()
    emitAdds()
    emitSets()
    emitRemoves()
    emitMoves()
    emitUpdates()
  }

  for (const keyframe of after.keyframes) {
    const command = objectTweenCommand(layerId, keyframe.frame, sim.tweens.get(keyframe.frame), keyframe.tween)
    if (command) commands.push(command)
  }
}

function diffCameraLayer(
  before: CameraLayer,
  after: CameraLayer,
  commands: ScriptCommand[],
  unsupported: string[]
): void {
  const layerId = after.id
  const beforeByFrame = new Map(before.keyframes.map((keyframe) => [keyframe.frame, keyframe]))
  const afterByFrame = new Map(after.keyframes.map((keyframe) => [keyframe.frame, keyframe]))
  const sim = seedSim(before)

  for (const keyframe of before.keyframes) {
    if (afterByFrame.has(keyframe.frame)) continue
    commands.push({ op: 'removeCameraKeyframe', frame: keyframe.frame })
    sim.frames.delete(keyframe.frame)
    sim.tweens.delete(keyframe.frame)
  }
  for (const keyframe of after.keyframes) {
    const previous = beforeByFrame.get(keyframe.frame)
    if (previous && deepEqual(previous.pose, keyframe.pose)) continue
    commands.push({
      op: 'setCameraKeyframe',
      frame: keyframe.frame,
      center: { x: keyframe.pose.center.x, y: keyframe.pose.center.y },
      zoom: keyframe.pose.zoom,
      rotation: keyframe.pose.rotation
    })
    if (!sim.frames.has(keyframe.frame)) {
      sim.frames.set(keyframe.frame, [])
      sim.tweens.set(keyframe.frame, undefined)
    }
  }
  for (const keyframe of after.keyframes) {
    if (keyframe.tween && normalizedChannelEasings(keyframe.tween)) {
      unsupported.push(
        `layer "${after.name}": camera per-channel easing change at frame ${keyframe.frame} is not recorded`
      )
    }
    const command = cameraTweenCommand(layerId, keyframe.frame, sim.tweens.get(keyframe.frame), keyframe.tween)
    if (command) commands.push(command)
  }
}

function diffDrawingLayer(
  before: DrawingLayer,
  after: DrawingLayer,
  maxMoveTarget: number,
  commands: ScriptCommand[],
  unsupported: string[]
): void {
  const layerId = after.id
  if (before.resolutionScale !== after.resolutionScale) {
    unsupported.push(`layer "${after.name}": drawing resolution change is not recorded`)
  }
  const beforeByFrame = new Map(before.cells.map((cell) => [cell.frame, cell.resourceId]))
  const afterByFrame = new Map(after.cells.map((cell) => [cell.frame, cell.resourceId]))
  const removedFrames = [...beforeByFrame.keys()].filter((frame) => !afterByFrame.has(frame)).sort((a, b) => a - b)
  const addedFrames = [...afterByFrame.keys()].filter((frame) => !beforeByFrame.has(frame)).sort((a, b) => a - b)

  const movedSources = new Set<number>()
  const movedTargets = new Set<number>()
  for (const source of removedFrames) {
    const resourceId = beforeByFrame.get(source)!
    // `moveCellToFrame` clamps its target to the current timeline; pairing a
    // farther target would replay at the wrong frame.
    const target = addedFrames.find(
      (frame) =>
        frame <= maxMoveTarget && !movedTargets.has(frame) && afterByFrame.get(frame) === resourceId
    )
    if (target === undefined) continue
    movedSources.add(source)
    movedTargets.add(target)
    commands.push({ op: 'moveCell', layerId, fromFrame: source, toFrame: target })
  }
  for (const source of removedFrames) {
    if (!movedSources.has(source)) {
      unsupported.push(
        `layer "${after.name}": cell at frame ${source} removed — no remove-cell command exists`
      )
    }
  }
  for (const frame of addedFrames) {
    if (movedTargets.has(frame)) continue
    commands.push({ op: 'setCell', layerId, frame, resourceId: afterByFrame.get(frame)! })
  }
  for (const [frame, resourceId] of afterByFrame) {
    const previous = beforeByFrame.get(frame)
    if (previous !== undefined && previous !== resourceId) {
      commands.push({ op: 'setCell', layerId, frame, resourceId })
    }
  }
}

function diffAudioLayer(before: AudioLayer, after: AudioLayer, commands: ScriptCommand[], unsupported: string[]): void {
  const layerId = after.id
  if (before.resourceId !== after.resourceId) {
    unsupported.push(`layer "${after.name}": audio clip resource change is not recorded`)
  }
  if (before.locked !== after.locked) {
    unsupported.push(`layer "${after.name}": lock toggle is not recorded (no command exists)`)
  }
  const command: SetAudioCommand = { op: 'setAudio', layerId }
  let any = false
  if (before.startFrame !== after.startFrame) {
    command.startFrame = after.startFrame
    any = true
  }
  if (before.volume !== after.volume) {
    command.volume = after.volume
    any = true
  }
  if (before.visible !== after.visible) {
    command.muted = !after.visible
    any = true
  }
  if (any) commands.push(command)
}

/** The layer as its `addLayer` command creates it — the baseline the content
 * diff of a newly added layer runs against. */
function freshLayerBaseline(layerAfter: Layer, document: AnimatorDocument): Layer {
  const base = { id: layerAfter.id, name: layerAfter.name, visible: true, locked: false }
  if (layerAfter.kind === 'object') {
    return { ...base, kind: 'object', keyframes: [{ frame: 0, nodes: [] }] }
  }
  if (layerAfter.kind === 'camera') {
    return { ...base, kind: 'camera', keyframes: [{ frame: 0, pose: defaultCameraPose(document) }] }
  }
  if (layerAfter.kind === 'drawing') {
    return { ...base, kind: 'drawing', resolutionScale: 1, cells: [] }
  }
  return {
    ...base,
    kind: 'audio',
    resourceId: layerAfter.resourceId,
    startFrame: layerAfter.startFrame,
    volume: 1
  }
}

function addLayerCommand(layer: Layer): ScriptCommand {
  if (layer.kind === 'audio') {
    return {
      op: 'addLayer',
      kind: 'audio',
      name: layer.name,
      resourceId: layer.resourceId,
      startFrame: layer.startFrame,
      layerId: layer.id
    }
  }
  return { op: 'addLayer', kind: layer.kind, name: layer.name, layerId: layer.id }
}

/** Frame positions held by a layer (keyframes, cells, or the clip start) —
 * the evidence the frame-shift detector compares between both states. */
function layerFrames(layer: Layer): number[] {
  if (layer.kind === 'object' || layer.kind === 'camera') {
    return layer.keyframes.map((keyframe) => keyframe.frame)
  }
  if (layer.kind === 'drawing') {
    return layer.cells.map((cell) => cell.frame)
  }
  return [layer.startFrame]
}

interface ShiftEvidence {
  /** Constant offset applied to every frame from the first difference on. */
  delta: number
  /** Lowest insert/remove frame consistent with this layer. */
  lo: number
  /** Highest insert/remove frame consistent with this layer. */
  hi: number
}

/**
 * Detects an `insertFrames`/`removeFrames` gesture: per-layer frame arrays
 * that shifted by a constant delta from a first difference index on narrow
 * the frame to a range; candidates are verified by replaying the real
 * document functions over a clone and deep-comparing with the after-state.
 */
function tryFrameShift(
  before: AnimatorDocument,
  after: AnimatorDocument,
  context: RecorderFrameContext
): { command: ScriptCommand; simulated: AnimatorDocument } | null {
  const evidence: ShiftEvidence[] = []
  for (const layerBefore of before.layers) {
    const layerAfter = after.layers.find((layer) => layer.id === layerBefore.id)
    if (!layerAfter || layerAfter.kind !== layerBefore.kind) continue
    const b = layerFrames(layerBefore)
    const a = layerFrames(layerAfter)
    if (b.length === 0 || b.length !== a.length) continue
    let first = -1
    for (let index = 0; index < b.length; index += 1) {
      if (b[index] !== a[index]) {
        first = index
        break
      }
    }
    if (first === -1) continue
    const delta = a[first] - b[first]
    if (delta === 0) continue
    let consistent = true
    for (let index = first; index < b.length; index += 1) {
      if (a[index] - b[index] !== delta) {
        consistent = false
        break
      }
    }
    if (!consistent) continue
    evidence.push({ delta, lo: first === 0 ? 0 : b[first - 1], hi: b[first] - 1 })
  }
  if (evidence.length === 0) return null
  const delta = evidence[0].delta
  if (!evidence.every((entry) => entry.delta === delta)) return null
  let lo = -Infinity
  let hi = Infinity
  for (const entry of evidence) {
    lo = Math.max(lo, entry.lo)
    hi = Math.min(hi, entry.hi)
  }
  if (lo > hi) return null
  const layerId =
    context.layerId && before.layers.some((layer) => layer.id === context.layerId)
      ? context.layerId
      : before.layers[0]?.id
  if (!layerId) return null
  const count = Math.abs(delta)
  const upperBound = documentDuration(before) - 1
  const candidates: number[] = []
  const pushCandidate = (frame: number): void => {
    if (!Number.isInteger(frame) || frame < lo || frame > hi || frame < 0 || frame > upperBound) return
    if (!candidates.includes(frame)) candidates.push(frame)
  }
  pushCandidate(context.frame)
  if (after.frames !== undefined) pushCandidate(after.frames - 2)
  pushCandidate(hi)
  pushCandidate(lo)
  for (const frame of candidates) {
    const simulated = cloneDocument(before)
    if (delta > 0) {
      for (let step = 0; step < count; step += 1) insertFrame(simulated, layerId, frame)
    } else {
      // Mirrors `removeFrameHere`: the playhead follows the shrinking timeline
      // between removals, so repeated removals can drift to earlier frames.
      let current = frame
      for (let step = 0; step < count; step += 1) {
        removeFrame(simulated, current)
        current = Math.min(current, Math.max(0, documentDuration(simulated) - 1))
      }
    }
    if (deepEqual(simulated, after)) {
      return {
        command:
          delta > 0
            ? { op: 'insertFrames', layerId, frame, count }
            : { op: 'removeFrames', layerId, frame, count },
        simulated
      }
    }
  }
  return null
}

/** Fallback for duration changes without a detectable shift (e.g. growing the
 * timeline beyond the content): replicates the `setDuration` loops. */
function trySetDuration(
  before: AnimatorDocument,
  after: AnimatorDocument
): { command: ScriptCommand; simulated: AnimatorDocument } | null {
  const layerId = before.layers[0]?.id
  if (!layerId) return null
  const target = documentDuration(after)
  const simulated = cloneDocument(before)
  let guard = 0
  while (documentDuration(simulated) < target && guard < 10000) {
    insertFrame(simulated, layerId, documentDuration(simulated) - 1)
    guard += 1
  }
  while (documentDuration(simulated) > target && guard < 10000) {
    removeFrame(simulated, documentDuration(simulated) - 1)
    guard += 1
  }
  if (!deepEqual(simulated, after)) return null
  return { command: { op: 'setDuration', frames: target }, simulated }
}

/**
 * Derives the script commands turning `before` into `after` — one gesture
 * apart (the recorder flushes on every committed history entry). Ids and the
 * gesture frame context are baked into the payload so replaying the commands
 * through `validateScriptPayload` + `executeScriptCommands` on a fresh copy
 * of `before` reproduces `after`.
 */
export function diffDocumentsToCommands(
  before: AnimatorDocument,
  after: AnimatorDocument,
  context: RecorderFrameContext
): RecorderDiffResult {
  const commands: ScriptCommand[] = []
  const unsupported: string[] = []
  if (deepEqual(before, after)) return { commands, unsupported }

  let base = before
  const shift = tryFrameShift(before, after, context)
  if (shift) {
    commands.push(shift.command)
    base = shift.simulated
  } else {
    const duration = trySetDuration(before, after)
    if (duration) {
      commands.push(duration.command)
      base = duration.simulated
    }
  }

  const byIdBefore = new Map(base.layers.map((layer) => [layer.id, layer]))
  const byIdAfter = new Map(after.layers.map((layer) => [layer.id, layer]))
  const kept = base.layers.filter((layer) => byIdAfter.has(layer.id))
  const added = after.layers.filter((layer) => !byIdBefore.has(layer.id))
  const expectedOrder = [...kept.map((layer) => layer.id), ...added.map((layer) => layer.id)]
  const actualOrder = after.layers.map((layer) => layer.id)
  if (
    expectedOrder.length !== actualOrder.length ||
    expectedOrder.some((id, index) => id !== actualOrder[index])
  ) {
    unsupported.push('layer order change is not recorded (no reorder command exists)')
  }

  for (const layer of base.layers) {
    if (byIdAfter.has(layer.id)) continue
    commands.push({ op: 'removeLayer', layerId: layer.id })
  }

  for (const layerAfter of after.layers) {
    const layerBefore = byIdBefore.get(layerAfter.id)
    if (layerBefore && layerBefore.kind !== layerAfter.kind) {
      unsupported.push(`layer "${layerAfter.name}": layer kind change is not recorded`)
      continue
    }
    if (!layerBefore) commands.push(addLayerCommand(layerAfter))
    const baseline = (layerBefore ?? freshLayerBaseline(layerAfter, after)) as Layer
    if (layerBefore && layerBefore.name !== layerAfter.name) {
      commands.push({ op: 'renameLayer', layerId: layerAfter.id, name: layerAfter.name })
    }
    if (layerAfter.kind === 'object') {
      diffObjectLayer(baseline as ObjectLayer, layerAfter, commands, unsupported)
    } else if (layerAfter.kind === 'camera') {
      diffCameraLayer(baseline as CameraLayer, layerAfter, commands, unsupported)
    } else if (layerAfter.kind === 'drawing') {
      diffDrawingLayer(
        baseline as DrawingLayer,
        layerAfter,
        documentDuration(base) - 1,
        commands,
        unsupported
      )
    } else {
      diffAudioLayer(baseline as AudioLayer, layerAfter, commands, unsupported)
    }
    if (layerAfter.kind !== 'audio') {
      if (baseline.visible !== layerAfter.visible) {
        unsupported.push(`layer "${layerAfter.name}": visibility toggle is not recorded (no command exists)`)
      }
      if (baseline.locked !== layerAfter.locked) {
        unsupported.push(`layer "${layerAfter.name}": lock toggle is not recorded (no command exists)`)
      }
    }
  }

  if (base.fps !== after.fps) commands.push({ op: 'setFps', fps: after.fps })
  if (!deepEqual(base.palette, after.palette)) commands.push({ op: 'setPalette', colors: [...after.palette] })
  if (holdStepOf(base) !== holdStepOf(after)) {
    commands.push({ op: 'setHoldStep', step: holdStepOf(after) })
  }
  if (base.name !== after.name) unsupported.push('document name change is not recorded (no command exists)')
  if (base.width !== after.width || base.height !== after.height) {
    unsupported.push('stage size change is not recorded (no command exists)')
  }
  if (base.background !== after.background) {
    unsupported.push('background change is not recorded (no command exists)')
  }
  if (!deepEqual(base.assets, after.assets)) {
    unsupported.push('asset library change is not recorded (no command exists)')
  }
  if (!deepEqual(base.fonts, after.fonts)) {
    unsupported.push('embedded font change is not recorded (no command exists)')
  }
  if ((base.frames ?? null) !== (after.frames ?? null)) {
    unsupported.push('authored length change is not recorded')
  }

  return { commands, unsupported }
}
