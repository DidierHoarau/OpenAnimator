import type { EasingName } from './easing'
import { isAnimatorDocument, isPalette } from './document'
import { isPaintValue } from './paint'
import type { AnimatorDocument, Keyframe, Layer, PrimitiveNode, SceneNode } from './model'

/** A v1 shape, exactly as persisted before the SceneNode model. */
export interface LegacyShapeV1 {
  id: string
  kind: 'rect' | 'ellipse'
  name?: string
  center: { x: number; y: number }
  width: number
  height: number
  rotation: number
  fill: string
  stroke?: string
  strokeWidth?: number
  opacity: number
}

/** Raised when a project file cannot be understood; the message is
 * user-presentable. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}

const EASING_NAMES: EasingName[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out']

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isVec2(value: unknown): value is { x: number; y: number } {
  if (typeof value !== 'object' || value === null) return false
  const point = value as { x?: unknown; y?: unknown }
  return isFiniteNumber(point.x) && isFiniteNumber(point.y)
}

function validateLegacyShape(value: unknown, where: string): LegacyShapeV1 {
  if (typeof value !== 'object' || value === null) {
    throw new MigrationError(`invalid shape ${where}: expected an object`)
  }
  const shape = value as Record<string, unknown>
  if (typeof shape.id !== 'string') {
    throw new MigrationError(`invalid shape ${where}: "id" must be a string`)
  }
  if (shape.kind !== 'rect' && shape.kind !== 'ellipse') {
    throw new MigrationError(
      `invalid shape ${where}: unknown shape kind ${JSON.stringify(shape.kind)}`
    )
  }
  if (!isVec2(shape.center)) {
    throw new MigrationError(`invalid shape ${where}: "center" must be {x, y} numbers`)
  }
  if (!isFiniteNumber(shape.width) || !isFiniteNumber(shape.height)) {
    throw new MigrationError(`invalid shape ${where}: "width" and "height" must be finite numbers`)
  }
  if (!isFiniteNumber(shape.rotation)) {
    throw new MigrationError(`invalid shape ${where}: "rotation" must be a finite number`)
  }
  if (typeof shape.fill !== 'string') {
    throw new MigrationError(`invalid shape ${where}: "fill" must be a string`)
  }
  if (shape.stroke !== undefined && typeof shape.stroke !== 'string') {
    throw new MigrationError(`invalid shape ${where}: "stroke" must be a string`)
  }
  if (shape.strokeWidth !== undefined && !isFiniteNumber(shape.strokeWidth)) {
    throw new MigrationError(`invalid shape ${where}: "strokeWidth" must be a finite number`)
  }
  if (!isFiniteNumber(shape.opacity) || shape.opacity < 0 || shape.opacity > 1) {
    throw new MigrationError(`invalid shape ${where}: "opacity" must be a number between 0 and 1`)
  }
  if (shape.name !== undefined && typeof shape.name !== 'string') {
    throw new MigrationError(`invalid shape ${where}: "name" must be a string`)
  }
  return shape as unknown as LegacyShapeV1
}

function validateLegacyKeyframe(value: unknown, where: string): Keyframe {
  if (typeof value !== 'object' || value === null) {
    throw new MigrationError(`invalid keyframe ${where}: expected an object`)
  }
  const keyframe = value as Record<string, unknown>
  if (!Number.isInteger(keyframe.frame) || (keyframe.frame as number) < 0) {
    throw new MigrationError(`invalid keyframe ${where}: "frame" must be an integer ≥ 0`)
  }
  if (!Array.isArray(keyframe.shapes)) {
    throw new MigrationError(`invalid keyframe ${where}: "shapes" must be an array`)
  }
  if (keyframe.tween !== undefined) {
    const easing = (keyframe.tween as { easing?: unknown } | null)?.easing
    if (!EASING_NAMES.includes(easing as EasingName)) {
      throw new MigrationError(
        `invalid keyframe ${where}: unknown tween easing ${JSON.stringify(easing)}`
      )
    }
  }
  const nodes = keyframe.shapes.map((shape, index): SceneNode => {
    const legacy = validateLegacyShape(shape, `at layer ${where}, node ${index + 1}`)
    return {
      type: 'primitive',
      primitive: legacy.kind,
      id: legacy.id,
      ...(legacy.name !== undefined ? { name: legacy.name } : {}),
      center: { ...legacy.center },
      width: legacy.width,
      height: legacy.height,
      rotation: legacy.rotation,
      fill: legacy.fill,
      ...(legacy.stroke !== undefined ? { stroke: legacy.stroke } : {}),
      ...(legacy.strokeWidth !== undefined ? { strokeWidth: legacy.strokeWidth } : {}),
      opacity: legacy.opacity
    } satisfies PrimitiveNode
  })
  const migrated: Keyframe = {
    frame: keyframe.frame as number,
    nodes,
    ...(keyframe.tween !== undefined
      ? { tween: structuredClone(keyframe.tween) as Keyframe['tween'] }
      : {})
  }
  return migrated
}

/** First malformed paint in the candidate document, as a user-presentable
 * location, or null when every paint field is valid. Malformed gradient
 * paints must be reported (never silently dropped as if solid). */
function firstInvalidPaintLocation(candidate: unknown): string | null {
  const layers = (candidate as { layers?: unknown }).layers
  if (!Array.isArray(layers)) return null
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const keyframes = (layers[layerIndex] as { keyframes?: unknown })?.keyframes
    if (!Array.isArray(keyframes)) continue
    for (let keyframeIndex = 0; keyframeIndex < keyframes.length; keyframeIndex++) {
      const nodes = (keyframes[keyframeIndex] as { nodes?: unknown })?.nodes
      if (!Array.isArray(nodes)) continue
      for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
        const where = `layer ${layerIndex + 1}, keyframe ${keyframeIndex + 1}, node ${nodeIndex + 1}`
        const problem = firstInvalidPaintInNode(nodes[nodeIndex], where)
        if (problem) return problem
      }
    }
  }
  return null
}

function firstInvalidPaintInNode(value: unknown, where: string): string | null {
  if (typeof value !== 'object' || value === null) return null
  const node = value as Record<string, unknown>
  if (node.type === 'primitive' || node.type === 'path') {
    if (node.fill !== undefined && !isPaintValue(node.fill)) {
      return `${where}: malformed "fill" paint`
    }
    if (node.stroke !== undefined && !isPaintValue(node.stroke)) {
      return `${where}: malformed "stroke" paint`
    }
  }
  if (node.type === 'text') {
    if (node.fill !== undefined && !isPaintValue(node.fill)) {
      return `${where}: malformed "fill" paint`
    }
    if (node.stroke !== undefined && !isPaintValue(node.stroke)) {
      return `${where}: malformed "stroke" paint`
    }
  }
  if (node.type === 'group' && Array.isArray(node.children)) {
    for (let index = 0; index < node.children.length; index++) {
      const problem = firstInvalidPaintInNode(node.children[index], `${where}, child ${index + 1}`)
      if (problem) return problem
    }
  }
  return null
}

function validateLegacyLayer(value: unknown, index: number): Layer {
  if (typeof value !== 'object' || value === null) {
    throw new MigrationError(`invalid layer ${index + 1}: expected an object`)
  }
  const layer = value as Record<string, unknown>
  const where = String(index + 1)
  if (typeof layer.id !== 'string' || typeof layer.name !== 'string') {
    throw new MigrationError(`invalid layer ${where}: "id" and "name" must be strings`)
  }
  if (typeof layer.visible !== 'boolean' || typeof layer.locked !== 'boolean') {
    throw new MigrationError(`invalid layer ${where}: "visible" and "locked" must be booleans`)
  }
  if (!Array.isArray(layer.keyframes)) {
    throw new MigrationError(`invalid layer ${where}: "keyframes" must be an array`)
  }
  return {
    kind: 'object',
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    keyframes: layer.keyframes.map((keyframe, keyframeIndex) =>
      validateLegacyKeyframe(keyframe, `${where}, keyframe ${keyframeIndex + 1}`)
    )
  }
}

function validateLegacyDocument(value: unknown): AnimatorDocument {
  if (typeof value !== 'object' || value === null) {
    throw new MigrationError('This file is not a valid OpenAnimator project.')
  }
  const document = value as Record<string, unknown>
  if (typeof document.name !== 'string') {
    throw new MigrationError('invalid document: "name" must be a string')
  }
  if (!isFiniteNumber(document.width) || !isFiniteNumber(document.height)) {
    throw new MigrationError('invalid document: "width" and "height" must be finite numbers')
  }
  if (!isFiniteNumber(document.fps) || document.fps <= 0) {
    throw new MigrationError('invalid document: "fps" must be a positive number')
  }
  if (typeof document.background !== 'string') {
    throw new MigrationError('invalid document: "background" must be a string')
  }
  if (
    document.frames !== undefined &&
    (!Number.isInteger(document.frames) || (document.frames as number) < 1)
  ) {
    throw new MigrationError('invalid document: "frames" must be an integer ≥ 1')
  }
  if (!Array.isArray(document.layers)) {
    throw new MigrationError('invalid document: "layers" must be an array')
  }
  return {
    schemaVersion: 6,
    name: document.name,
    width: document.width,
    height: document.height,
    fps: document.fps,
    background: document.background,
    layers: document.layers.map(validateLegacyLayer),
    ...(document.frames !== undefined ? { frames: document.frames as number } : {}),
    assets: [],
    palette: [],
    fonts: []
  }
}

/**
 * Normalizes a parsed project file to the current schema (v6): v2–v5
 * documents are deep-validated and returned detached from the parsed input
 * (documents saved before a section existed are normalized to empty defaults
 * — `assets: []`, `palette: []`, `fonts: []`; layers saved before drawing
 * layers existed get `kind: 'object'`), v1 documents are migrated (each
 * legacy `Shape` becomes a `PrimitiveNode` with `kind` → `primitive`).
 * Malformed gradient paints and invalid palettes raise `MigrationError` with
 * a user-presentable location — reported, never silently dropped. Invalid
 * content raises `MigrationError`. The input is never mutated.
 */
export function migrateDocument(raw: unknown): AnimatorDocument {
  const version = (typeof raw === 'object' && raw !== null ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined)
  if (version === 2 || version === 3 || version === 4 || version === 5 || version === 6) {
    const source = raw as Record<string, unknown>
    if (source.assets !== undefined && !Array.isArray(source.assets)) {
      throw new MigrationError('invalid document: "assets" must be an array')
    }
    if (source.palette !== undefined && !isPalette(source.palette)) {
      throw new MigrationError(
        'invalid document: "palette" must be an array of up to 48 hex colors (#rgb or #rrggbb)'
      )
    }
    if (source.fonts !== undefined && !Array.isArray(source.fonts)) {
      throw new MigrationError('invalid document: "fonts" must be an array')
    }
    // Additive normalization: inject the (possibly missing) assets, palette,
    // fonts and layer kind before deep validation so pre-library /
    // pre-palette / pre-font files keep opening.
    const layers = Array.isArray(source.layers)
      ? source.layers.map((layer) =>
          typeof layer === 'object' &&
          layer !== null &&
          (layer as { kind?: unknown }).kind === undefined
            ? { ...(layer as Record<string, unknown>), kind: 'object' as const }
            : layer
        )
      : source.layers
    const candidate = {
      ...source,
      schemaVersion: 6,
      layers,
      assets: (source.assets as unknown[] | undefined) ?? [],
      palette: (source.palette as unknown[] | undefined) ?? [],
      fonts: (source.fonts as unknown[] | undefined) ?? []
    }
    if (!isAnimatorDocument(candidate)) {
      const paintProblem = firstInvalidPaintLocation(candidate)
      if (paintProblem) {
        throw new MigrationError(
          `invalid document: ${paintProblem} (gradients need 2–8 stops with 0–1 offsets and hex colors)`
        )
      }
      throw new MigrationError('This file is not a valid OpenAnimator project.')
    }
    return structuredClone(candidate)
  }
  return validateLegacyDocument(raw)
}
