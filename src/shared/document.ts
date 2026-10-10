import { evaluateEasing } from './easing'
import type { AnimatorDocument, Keyframe, Layer, Shape } from './model'
import { cloneShape } from './model'
import { tweenShape } from './tween'

let idCounter = 0

/** Generates a reasonably unique, readable id for documents, layers and shapes. */
export function createId(prefix: string): string {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER
  return `${prefix}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function createLayer(name: string): Layer {
  return {
    id: createId('layer'),
    name,
    visible: true,
    locked: false,
    keyframes: []
  }
}

export function createDocument(name: string, width: number, height: number, fps: number): AnimatorDocument {
  const layer = createLayer('Layer 1')
  layer.keyframes.push({ frame: 0, shapes: [] })
  return {
    name,
    width,
    height,
    fps,
    background: '#10151b',
    layers: [layer],
    frames: 1
  }
}

export function getLayer(document: AnimatorDocument, layerId: string): Layer | undefined {
  return document.layers.find((layer) => layer.id === layerId)
}

/** Total number of frames: the furthest keyframe + 1 and the authored length
 * (`frames`), whichever is larger; at least 1. */
export function documentDuration(document: AnimatorDocument): number {
  let max = 0
  for (const layer of document.layers) {
    for (const keyframe of layer.keyframes) {
      max = Math.max(max, keyframe.frame)
    }
  }
  return Math.max(1, max + 1, document.frames ?? 0)
}

/** Index of the last keyframe at or before `frame`, or -1 when none exists. */
export function findKeyframeIndexForFrame(layer: Layer, frame: number): number {
  let index = -1
  for (let i = 0; i < layer.keyframes.length; i++) {
    if (layer.keyframes[i].frame <= frame) index = i
    else break
  }
  return index
}

export function findKeyframeAtFrame(layer: Layer, frame: number): Keyframe | undefined {
  return layer.keyframes.find((keyframe) => keyframe.frame === frame)
}

/**
 * Index of the keyframe holding the most recent pose of `shapeId` at or
 * before `frame`. When the shape only appears later on the layer, the
 * earliest keyframe containing it is returned instead, so callers can always
 * copy an existing pose forward. Returns -1 when the shape never appears.
 */
export function findNearestShapeKeyframeIndex(layer: Layer, shapeId: string, frame: number): number {
  let latest = -1
  let earliest = -1
  for (let i = 0; i < layer.keyframes.length; i++) {
    if (!layer.keyframes[i].shapes.some((shape) => shape.id === shapeId)) continue
    if (earliest === -1) earliest = i
    if (layer.keyframes[i].frame <= frame) latest = i
  }
  return latest !== -1 ? latest : earliest
}

/**
 * Object-level content of a layer at a given frame: every shape exists only
 * within its own span — from its first keyframe to its last keyframe — and
 * keeps the pose from its latest keyframe at or before `frame`, interpolated
 * toward that shape's own next keyframe when the owning keyframe carries a
 * tween.
 */
export function evaluateLayerAtFrame(layer: Layer, frame: number): Shape[] {
  const last = new Map<string, number>()
  for (let i = 0; i < layer.keyframes.length; i++) {
    for (const shape of layer.keyframes[i].shapes) {
      last.set(shape.id, i)
    }
  }

  const order: string[] = []
  const latest = new Map<string, { index: number; shape: Shape }>()
  for (let i = 0; i < layer.keyframes.length; i++) {
    const keyframe = layer.keyframes[i]
    if (keyframe.frame > frame) break
    for (const shape of keyframe.shapes) {
      if (!latest.has(shape.id)) order.push(shape.id)
      latest.set(shape.id, { index: i, shape })
    }
  }

  const result: Shape[] = []
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
        if (layer.keyframes[i].shapes.some((shape) => shape.id === id)) {
          nextIndex = i
          break
        }
      }
      if (nextIndex !== -1) {
        const next = layer.keyframes[nextIndex]
        const target = next.shapes.find((shape) => shape.id === id)
        if (target) {
          const progress = (frame - source.frame) / (next.frame - source.frame)
          const eased = evaluateEasing(source.tween.easing, progress)
          result.push(tweenShape(entry.shape, target, eased))
          continue
        }
      }
    }
    result.push(entry.shape)
  }
  return result
}

/**
 * Inserts a keyframe at `frame` holding a copy of the content active at that
 * frame. Returns the created keyframe, or null when one already exists there.
 */
export function insertKeyframe(layer: Layer, frame: number): Keyframe | null {
  if (findKeyframeAtFrame(layer, frame)) return null
  const previous = findKeyframeIndexForFrame(layer, frame)
  const shapes = previous === -1 ? [] : layer.keyframes[previous].shapes.map(cloneShape)
  const keyframe: Keyframe = { frame, shapes }
  layer.keyframes.push(keyframe)
  layer.keyframes.sort((a, b) => a.frame - b.frame)
  return keyframe
}

/** Inserts a blank (empty) keyframe at `frame`. Returns null if one exists. */
export function insertBlankKeyframe(layer: Layer, frame: number): Keyframe | null {
  if (findKeyframeAtFrame(layer, frame)) return null
  const keyframe: Keyframe = { frame, shapes: [] }
  layer.keyframes.push(keyframe)
  layer.keyframes.sort((a, b) => a.frame - b.frame)
  return keyframe
}

/** Removes the keyframe at `frame`. Returns true when something was removed. */
export function removeKeyframe(layer: Layer, frame: number): boolean {
  const index = layer.keyframes.findIndex((keyframe) => keyframe.frame === frame)
  if (index === -1) return false
  layer.keyframes.splice(index, 1)
  return true
}

/** Sets or clears the tween on the keyframe at `frame`. */
export function setKeyframeTween(
  layer: Layer,
  frame: number,
  tween: Keyframe['tween']
): boolean {
  const keyframe = findKeyframeAtFrame(layer, frame)
  if (!keyframe) return false
  if (tween) keyframe.tween = { ...tween }
  else delete keyframe.tween
  return true
}

/** Inserts a frame on the given layer: shifts the layer's keyframes strictly
 * after `frame` one frame later (extending the hold of the keyframe active at
 * the playhead) and grows the document's authored timeline so the playhead can
 * move past the last keyframe. */
export function insertFrame(document: AnimatorDocument, layerId: string, frame: number): void {
  const layer = getLayer(document, layerId)
  if (!layer) return
  for (const target of document.layers) {
    for (const keyframe of target.keyframes) {
      if (keyframe.frame > frame) keyframe.frame += 1
    }
  }
  document.frames = Math.max(document.frames ?? 0, frame + 2)
}

/** Adds a shape to the keyframe content active at `frame`, creating a blank
 * keyframe first when the frame sits before the first keyframe. */
export function addShapeToLayer(layer: Layer, frame: number, shape: Shape): void {
  let keyframe = findKeyframeAtFrame(layer, frame)
  if (!keyframe) {
    const index = findKeyframeIndexForFrame(layer, frame)
    if (index === -1) {
      keyframe = { frame, shapes: [] }
      layer.keyframes.push(keyframe)
      layer.keyframes.sort((a, b) => a.frame - b.frame)
    } else {
      keyframe = layer.keyframes[index]
    }
  }
  keyframe.shapes.push(shape)
}

/**
 * Removes a shape from the keyframe content active at `frame`. When the
 * keyframe becomes empty it is removed as well: the timeline has no blank
 * keyframes, so content before the frame holds through it.
 */
export function removeShapeFromLayer(layer: Layer, frame: number, shapeId: string): boolean {
  const index = findKeyframeIndexForFrame(layer, frame)
  if (index === -1) return false
  const keyframe = layer.keyframes[index]
  const shapeIndex = keyframe.shapes.findIndex((shape) => shape.id === shapeId)
  if (shapeIndex === -1) return false
  keyframe.shapes.splice(shapeIndex, 1)
  if (keyframe.shapes.length === 0) removeKeyframe(layer, keyframe.frame)
  return true
}

/** Updates a shape inside the keyframe content active at `frame`. */
export function updateShapeInLayer(
  layer: Layer,
  frame: number,
  shapeId: string,
  update: (shape: Shape) => void
): boolean {
  const index = findKeyframeIndexForFrame(layer, frame)
  if (index === -1) return false
  const shape = layer.keyframes[index].shapes.find((candidate) => candidate.id === shapeId)
  if (!shape) return false
  update(shape)
  return true
}

/**
 * Removes every occurrence of a shape across all keyframes of a layer.
 * Keyframes emptied by the removal are dropped. Returns how many keyframes
 * contained the shape.
 */
export function removeShapeFromAllKeyframes(layer: Layer, shapeId: string): number {
  let removed = 0
  for (let i = layer.keyframes.length - 1; i >= 0; i--) {
    const keyframe = layer.keyframes[i]
    const shapeIndex = keyframe.shapes.findIndex((shape) => shape.id === shapeId)
    if (shapeIndex === -1) continue
    keyframe.shapes.splice(shapeIndex, 1)
    removed += 1
    if (keyframe.shapes.length === 0) layer.keyframes.splice(i, 1)
  }
  return removed
}

/** Sets the display name of a shape in every keyframe that contains it. */
export function renameShapeInLayer(layer: Layer, shapeId: string, name: string): boolean {
  let renamed = false
  for (const keyframe of layer.keyframes) {
    const shape = keyframe.shapes.find((candidate) => candidate.id === shapeId)
    if (shape) {
      shape.name = name
      renamed = true
    }
  }
  return renamed
}

/**
 * Removes a frame from the timeline: keyframes after `frame` shift one frame
 * earlier on every layer and the keyframe exactly at `frame` is deleted, so
 * the content of frame `frame + 1` collapses into `frame`. A layer's last
 * remaining keyframe is never removed.
 */
export function removeFrame(document: AnimatorDocument, frame: number): void {
  for (const layer of document.layers) {
    for (const keyframe of layer.keyframes) {
      if (keyframe.frame > frame) keyframe.frame -= 1
    }
    if (layer.keyframes.length > 1) removeKeyframe(layer, frame)
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
  position: 'top' | 'bottom' = 'top'
): Layer {
  const layer = createLayer(name)
  layer.keyframes.push({ frame: 0, shapes: [] })
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
  return JSON.parse(JSON.stringify(document)) as AnimatorDocument
}

/** Structural validation for documents restored from persistence. Accepts
 * documents without `frames` (older save format) but rejects invalid values. */
export function isAnimatorDocument(value: unknown): value is AnimatorDocument {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<AnimatorDocument>
  const framesValid =
    candidate.frames === undefined ||
    (typeof candidate.frames === 'number' && Number.isInteger(candidate.frames) && candidate.frames >= 1)
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    typeof candidate.fps === 'number' &&
    candidate.fps > 0 &&
    typeof candidate.background === 'string' &&
    framesValid &&
    Array.isArray(candidate.layers) &&
    candidate.layers.every(
      (layer) =>
        typeof layer === 'object' &&
        layer !== null &&
        typeof (layer as Layer).id === 'string' &&
        typeof (layer as Layer).name === 'string' &&
        Array.isArray((layer as Layer).keyframes)
    )
  )
}
