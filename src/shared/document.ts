import { evaluateEasing } from './easing'
import type { AnimatorDocument, Keyframe, Layer, Shape } from './model'
import { tweenShapes } from './tween'

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
    layers: [layer]
  }
}

export function getLayer(document: AnimatorDocument, layerId: string): Layer | undefined {
  return document.layers.find((layer) => layer.id === layerId)
}

/** Total number of frames: the furthest keyframe + 1 (at least 1). */
export function documentDuration(document: AnimatorDocument): number {
  let max = 0
  for (const layer of document.layers) {
    for (const keyframe of layer.keyframes) {
      max = Math.max(max, keyframe.frame)
    }
  }
  return max + 1
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
 * Content of a layer at a given frame: the active keyframe's shapes, tweened
 * toward the next keyframe when the active keyframe carries a tween.
 */
export function evaluateLayerAtFrame(layer: Layer, frame: number): Shape[] {
  const index = findKeyframeIndexForFrame(layer, frame)
  if (index === -1) return []
  const active = layer.keyframes[index]
  const next = layer.keyframes[index + 1]
  if (active.tween && next && next.frame > active.frame && frame < next.frame) {
    const progress = (frame - active.frame) / (next.frame - active.frame)
    const eased = evaluateEasing(active.tween.easing, progress)
    return tweenShapes(active.shapes, next.shapes, eased)
  }
  return active.shapes
}

/**
 * Inserts a keyframe at `frame` holding a copy of the content active at that
 * frame. Returns the created keyframe, or null when one already exists there.
 */
export function insertKeyframe(layer: Layer, frame: number): Keyframe | null {
  if (findKeyframeAtFrame(layer, frame)) return null
  const previous = findKeyframeIndexForFrame(layer, frame)
  const shapes = previous === -1 ? [] : layer.keyframes[previous].shapes.map((shape) => ({ ...shape }))
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

/** Shifts every keyframe at or after `frame` one frame later (insert frame). */
export function insertFrame(layer: Layer, frame: number): void {
  for (const keyframe of layer.keyframes) {
    if (keyframe.frame >= frame) keyframe.frame += 1
  }
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

/** Removes a shape from the keyframe content active at `frame`. */
export function removeShapeFromLayer(layer: Layer, frame: number, shapeId: string): boolean {
  const index = findKeyframeIndexForFrame(layer, frame)
  if (index === -1) return false
  const keyframe = layer.keyframes[index]
  const shapeIndex = keyframe.shapes.findIndex((shape) => shape.id === shapeId)
  if (shapeIndex === -1) return false
  keyframe.shapes.splice(shapeIndex, 1)
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

export function addLayer(document: AnimatorDocument, name: string): Layer {
  const layer = createLayer(name)
  layer.keyframes.push({ frame: 0, shapes: [] })
  // New layers go on top.
  document.layers.unshift(layer)
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

/** Structural validation for documents restored from persistence. */
export function isAnimatorDocument(value: unknown): value is AnimatorDocument {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<AnimatorDocument>
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    typeof candidate.fps === 'number' &&
    candidate.fps > 0 &&
    typeof candidate.background === 'string' &&
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
