import { strToU8, zipSync } from 'fflate'

import { parseHexColor } from './color'
import { cameraLayerOf, evaluateCameraAtFrame, evaluateLayerAtFrame, holdStepOf } from './document'
import type { CubicBezierEasing, Easing } from './easing'
import { groupNaturalSize } from './groups'
import type {
  AnimatorDocument,
  AudioLayer,
  CameraLayer,
  DrawingLayer,
  ImageNode,
  ObjectLayer,
  PathAnchor,
  PathNode,
  SceneNode
} from './model'
import { isAudioLayer, isCameraLayer, isObjectLayer } from './model'
import type { GradientPaint, Paint } from './paint'
import { pathDataToSubpathAnchors, pathNaturalSize } from './pathModel'
import { resolveSceneNodes } from './symbols'
import type { TextOutlineProvider } from './textOutline'

/**
 * Lottie (bodymovin) exporter: converts a document range into a Lottie
 * animation JSON through the shared evaluator. The structural conventions
 * (layer/item order, key easing placement, shape formats, gradient and audio
 * data shapes) were verified against lottie-web 5.13 — the same version the
 * CI render gate uses.
 *
 * Scoped subset (documented in docs/export-formats.md): solid and
 * linear/radial gradient paints export natively (stop alpha folds into
 * `stop-opacity`); named easings map to canonical cubic-bezier
 * approximations; `smooth` tween paths bake per output frame so the exported
 * motion matches the renderer exactly; text ships as outlined vector paths
 * with its stroke (fonts are never embedded — licensing); audio layers ship
 * as embedded data URIs or as side files when the caller resolves their
 * bytes. Unsupported content degrades to a dashed placeholder box plus a
 * diagnostic, never a crash.
 *
 * Ordering rules (lottie-web renders the FIRST element of every items array
 * on top): content layers are emitted top-first, node children are emitted
 * reversed, and stroke items precede fill items so strokes paint over fills
 * exactly like the SVG renderer.
 */

/** How audio resources ship: embedded as base64 data URIs inside the
 * animation JSON (single-file, larger) or as side files for dotLottie
 * archives. */
export type LottieAudioMode = 'embed' | 'files'

export interface LottieBuildOptions {
  fromFrame: number
  toFrame: number
  fps: number
  /** Audio handling; defaults to `'embed'`. */
  audio?: LottieAudioMode
}

export interface LottieAudioResource {
  bytes: Uint8Array
  /** Source file extension without the dot (drives the data-URI MIME type
   * and the side-file name); the exporter sanitizes it. */
  ext: string
}

export interface LottieBuildDeps {
  /** Resolves a resource id to an embeddable `data:` URL; null when missing. */
  resolveResourceDataUrl: (resourceId: string) => Promise<string | null>
  /** Outlines text nodes; absent or null result → placeholder box. */
  outlineText?: TextOutlineProvider
  /** Resolves an audio resource id to its bytes; absent or null keeps the
   * soundtrack out of the file with a diagnostic. */
  resolveResourceBytes?: (resourceId: string) => Promise<LottieAudioResource | null>
}

export interface LottieBuildResult {
  lottie: Record<string, unknown>
  diagnostics: string[]
  /** Side files the animation references (audio in `'files'` mode), keyed by
   * archive-relative path. Absent when the animation has none. */
  files?: Record<string, Uint8Array>
}

type LottieObject = Record<string, unknown>

/** One boundary of a property channel: output time, doc frame to sample and
 * the segment easing starting there (null = hold until the next key). */
interface KeySpec {
  t: number
  docFrame: number
  easing: CubicBezierEasing | null
}

interface NodeKeys {
  keys: KeySpec[]
  successor: KeySpec | null
  ip: number
  op: number
}

/** One key of a numeric property channel. */
interface ChannelKey {
  t: number
  value: number[]
  easing: CubicBezierEasing | null
}

const EASING_BEZIERS: Record<string, CubicBezierEasing> = {
  linear: { x1: 0, y1: 0, x2: 1, y2: 1 },
  'ease-in': { x1: 0.32, y1: 0, x2: 0.67, y2: 0 },
  'ease-out': { x1: 0.33, y1: 1, x2: 0.68, y2: 1 },
  'ease-in-out': { x1: 0.65, y1: 0, x2: 0.35, y2: 1 }
}

const LINEAR_EASING: CubicBezierEasing = { x1: 0, y1: 0, x2: 1, y2: 1 }

const PLACEHOLDER_FILL = '#e2e8f0'
const PLACEHOLDER_STROKE = '#94a3b8'

function round4(value: number): number {
  const rounded = Math.round(value * 1e4) / 1e4
  return rounded === 0 ? 0 : rounded
}

function lerpPoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
  t: number
): { x: number; y: number } {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function bezierComponentX(p1: number, p2: number, t: number): number {
  const u = 1 - t
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t
}

function bezierDerivativeX(p1: number, p2: number, t: number): number {
  const u = 1 - t
  return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2)
}

/** Parameter `u` where the unit bezier's x-component equals `x` (Newton with
 * a bisection fallback — the same solver the shared easing evaluation uses). */
function solveBezierParameter(p1: number, p2: number, x: number): number {
  let guess = x
  for (let i = 0; i < 8; i++) {
    const error = bezierComponentX(p1, p2, guess) - x
    if (Math.abs(error) < 1e-6) return guess
    const derivative = bezierDerivativeX(p1, p2, guess)
    if (Math.abs(derivative) < 1e-6) break
    guess -= error / derivative
  }
  if (guess < 0 || guess > 1) {
    let low = 0
    let high = 1
    guess = x
    for (let i = 0; i < 48; i++) {
      const value = bezierComponentX(p1, p2, guess)
      if (Math.abs(value - x) < 1e-6) break
      if (value < x) low = guess
      else high = guess
      guess = (low + high) / 2
    }
  }
  return Math.min(1, Math.max(0, guess))
}

/** Cubic-bezier of a document easing: custom beziers map exactly, named
 * power curves map to their canonical cubic-bezier approximations. */
function lottieEasingFor(easing: Easing): CubicBezierEasing {
  if (typeof easing === 'string') return { ...EASING_BEZIERS[easing] }
  return { x1: easing.x1, y1: easing.y1, x2: easing.x2, y2: easing.y2 }
}

/**
 * Segment easing for a tween that starts mid-way (the export range cuts a
 * segment): the de Casteljau second-half split reparameterized so the
 * remaining curve keeps mapping the same progress values to the same eased
 * values.
 */
function splitBezier(easing: CubicBezierEasing, progress: number): CubicBezierEasing {
  const x0 = Math.min(1, Math.max(0, progress))
  if (x0 <= 1e-6) return easing
  if (x0 >= 1 - 1e-6) return { x1: 0, y1: 0, x2: 1, y2: 1 }
  const u = solveBezierParameter(easing.x1, easing.x2, x0)
  const p0 = { x: 0, y: 0 }
  const p1 = { x: easing.x1, y: easing.y1 }
  const p2 = { x: easing.x2, y: easing.y2 }
  const p3 = { x: 1, y: 1 }
  const a1 = lerpPoint(p0, p1, u)
  const a2 = lerpPoint(p1, p2, u)
  const a3 = lerpPoint(p2, p3, u)
  const b1 = lerpPoint(a1, a2, u)
  const b2 = lerpPoint(a2, a3, u)
  const split = lerpPoint(b1, b2, u)
  const dx = 1 - split.x
  const dy = 1 - split.y
  if (dx < 1e-6 || Math.abs(dy) < 1e-6) return easing
  return {
    x1: (b2.x - split.x) / dx,
    y1: (b2.y - split.y) / dy,
    x2: (a3.x - split.x) / dx,
    y2: (a3.y - split.y) / dy
  }
}

const IDENTITY_LAYER_KS = (): LottieObject => ({
  a: { a: 0, k: [0, 0] },
  p: { a: 0, k: [0, 0] },
  s: { a: 0, k: [100, 100] },
  r: { a: 0, k: 0 },
  o: { a: 0, k: 100 }
})

function staticProp(value: number[]): LottieObject {
  return { a: 0, k: value.map(round4) }
}

function staticColor(color: string): LottieObject {
  return { a: 0, k: colorChannels(color) ?? [0, 0, 0, 1] }
}

function colorChannels(color: string): number[] | null {
  const rgb = parseHexColor(color)
  if (!rgb) return null
  return [round4(rgb[0] / 255), round4(rgb[1] / 255), round4(rgb[2] / 255), 1]
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-6) return false
  }
  return true
}

/** Lottie animatable property from channel keys: a static value when nothing
 * changes, otherwise keyed values whose easing lives on the key that starts
 * each segment (the convention lottie-web reads). Hold keys use `h: 1`. */
function propertyFromChannel(channel: ChannelKey[]): LottieObject {
  const rounded = channel.map((key) => ({ t: key.t, value: key.value.map(round4), easing: key.easing }))
  if (rounded.length === 1 || rounded.every((key) => arraysEqual(key.value, rounded[0].value))) {
    return { a: 0, k: rounded[0].value }
  }
  return {
    a: 1,
    k: rounded.map((key) =>
      key.easing
        ? {
            t: key.t,
            s: key.value,
            o: { x: round4(key.easing.x1), y: round4(key.easing.y1) },
            i: { x: round4(key.easing.x2), y: round4(key.easing.y2) }
          }
        : { t: key.t, s: key.value, h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } }
    )
  }
}

/** Collects one numeric channel over a boundary spec: samples `read` at every
 * boundary (falling back to the previous value when a pose is missing) and
 * appends the successor key when the last segment needs an interpolation
 * target. Returns null when the first boundary has no value at all. */
function collectChannel(spec: NodeKeys, read: (docFrame: number) => number[] | null): LottieObject | null {
  const channel: ChannelKey[] = []
  let last: number[] | null = null
  for (const key of spec.keys) {
    const value: number[] | null = read(key.docFrame) ?? last
    if (!value) return null
    channel.push({ t: key.t, value, easing: key.easing })
    last = value
  }
  const tail = channel[channel.length - 1]
  if (tail && tail.easing !== null && spec.successor) {
    channel.push({
      t: spec.successor.t,
      value: read(spec.successor.docFrame) ?? tail.value,
      easing: null
    })
  }
  return propertyFromChannel(channel)
}

// ---------------------------------------------------------------------------
// Affine helpers (flattening nested images into top-level Lottie layers)
// ---------------------------------------------------------------------------

interface Matrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

function nodeMatrix(node: SceneNode): Matrix {
  let sx = 1
  let sy = 1
  if (node.type === 'group') {
    const natural = groupNaturalSize(node.children)
    sx = natural.width === 0 ? 1 : node.width / natural.width
    sy = natural.height === 0 ? 1 : node.height / natural.height
  } else if (node.type === 'image') {
    sx = node.width / node.naturalWidth
    sy = node.height / node.naturalHeight
  } else if (node.type === 'path') {
    const natural = pathNaturalSize(node)
    sx = natural.width === 0 ? 1 : node.width / natural.width
    sy = natural.height === 0 ? 1 : node.height / natural.height
  }
  const radians = (node.rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    a: cos * sx,
    b: sin * sx,
    c: -sin * sy,
    d: cos * sy,
    e: node.center.x,
    f: node.center.y
  }
}

function multiplyMatrices(outer: Matrix, inner: Matrix): Matrix {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f
  }
}

const IDENTITY_MATRIX: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

interface ComposedImage {
  position: number[]
  rotation: number
  scale: number[]
  opacity: number
  shear: number
}

function composeImageChain(chain: SceneNode[]): ComposedImage {
  let matrix = IDENTITY_MATRIX
  let opacity = 1
  for (const node of chain) {
    matrix = multiplyMatrices(matrix, nodeMatrix(node))
    opacity *= node.opacity
  }
  const rotation = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI
  const sx = Math.hypot(matrix.a, matrix.b)
  const sy = Math.hypot(matrix.c, matrix.d)
  const shear = sx * sy > 0 ? Math.abs((matrix.a * matrix.c + matrix.b * matrix.d) / (sx * sy)) : 0
  return {
    position: [matrix.e, matrix.f],
    rotation,
    scale: [sx * 100, sy * 100],
    opacity: opacity * 100,
    shear
  }
}

// ---------------------------------------------------------------------------
// Context and pose sampling
// ---------------------------------------------------------------------------

interface Ctx {
  document: AnimatorDocument
  fromFrame: number
  toFrame: number
  frameCount: number
  fps: number
  holdStep: number
  /** Document frame evaluated at each output frame (hold step applied). */
  evalFrames: number[]
  deps: LottieBuildDeps
  diagnostics: string[]
  seenDiagnostics: Set<string>
  imageAssets: LottieObject[]
  assetIdByResource: Map<string, string | null>
  outlineCache: Map<string, PathNode | null>
  audioAssets: LottieObject[]
  audioAssetIdByResource: Map<string, string | null>
  audioFiles: Map<string, Uint8Array>
}

function report(ctx: Ctx, message: string): void {
  if (ctx.seenDiagnostics.has(message)) return
  ctx.seenDiagnostics.add(message)
  ctx.diagnostics.push(message)
}

/** Resolved pose map of a layer at a doc frame (memoized per frame). */
function poseSourceFor(
  ctx: Ctx,
  layer: ObjectLayer
): (docFrame: number) => Map<string, SceneNode> {
  const cache = new Map<number, Map<string, SceneNode>>()
  return (docFrame: number): Map<string, SceneNode> => {
    const cached = cache.get(docFrame)
    if (cached) return cached
    const poses = new Map<string, SceneNode>()
    for (const node of resolveSceneNodes(evaluateLayerAtFrame(layer, docFrame), ctx.document.assets)) {
      poses.set(node.id, node)
    }
    cache.set(docFrame, poses)
    return poses
  }
}

function findNodeInTree(root: SceneNode, id: string): SceneNode | null {
  if (root.id === id) return root
  if (root.type !== 'group') return null
  for (const child of root.children) {
    const found = findNodeInTree(child, id)
    if (found) return found
  }
  return null
}

/** Chains (top-down node lists) of every image inside a resolved subtree. */
function imageChains(root: SceneNode, ancestors: SceneNode[] = []): SceneNode[][] {
  if (root.type === 'image') return [[...ancestors, root]]
  if (root.type !== 'group') return []
  const chain = [...ancestors, root]
  return root.children.flatMap((child) => imageChains(child, chain))
}

// ---------------------------------------------------------------------------
// Key boundary machinery
// ---------------------------------------------------------------------------

/** Frames of the keyframes containing `id`, ascending (the node's presence
 * is the closed span between the first and the last of them). */
function containingFrames(layer: ObjectLayer, id: string): number[] {
  const frames: number[] = []
  for (const keyframe of layer.keyframes) {
    if (keyframe.nodes.some((node) => node.id === id)) frames.push(keyframe.frame)
  }
  return frames
}

/** Easing of the tween segment covering doc frame `f` for node `id`: null
 * for held segments, a split bezier when the range starts mid-segment.
 * `smooth` segments never reach this path — `nodeKeysFor` bakes them per
 * output frame instead. */
function segmentEasingAt(layer: ObjectLayer, id: string, f: number): CubicBezierEasing | null {
  let sourceIndex = -1
  for (let i = 0; i < layer.keyframes.length; i++) {
    if (layer.keyframes[i].frame > f) break
    if (layer.keyframes[i].nodes.some((node) => node.id === id)) sourceIndex = i
  }
  if (sourceIndex === -1) return null
  const source = layer.keyframes[sourceIndex]
  if (!source.tween) return null
  let nextIndex = -1
  for (let i = sourceIndex + 1; i < layer.keyframes.length; i++) {
    if (layer.keyframes[i].nodes.some((node) => node.id === id)) {
      nextIndex = i
      break
    }
  }
  if (nextIndex === -1) return null
  const next = layer.keyframes[nextIndex]
  if (f >= next.frame) return null
  const mapped = lottieEasingFor(source.tween.easing)
  if (f > source.frame) {
    return splitBezier(mapped, (f - source.frame) / (next.frame - source.frame))
  }
  return mapped
}

/** True when a `smooth` tween segment of node `id` intersects the export
 * range — such nodes bake per output frame so the bezier motion matches the
 * renderer exactly (lottie has no Catmull-Rom mode). */
function hasSmoothSegment(ctx: Ctx, layer: ObjectLayer, id: string): boolean {
  const keyframes = layer.keyframes
  for (let i = 0; i < keyframes.length; i++) {
    const source = keyframes[i]
    if (!source.tween || source.tween.path !== 'smooth') continue
    if (!source.nodes.some((node) => node.id === id)) continue
    for (let j = i + 1; j < keyframes.length; j++) {
      if (!keyframes[j].nodes.some((node) => node.id === id)) continue
      if (source.frame <= ctx.toFrame && keyframes[j].frame >= ctx.fromFrame) return true
      break
    }
  }
  return false
}

/** Boundary keys and presence window of one node: keyframe boundaries with
 * mapped easings when every frame is addressed, baked per-frame keys sampled
 * through the evaluator when the document uses a hold step or the node has a
 * `smooth` tween segment in range. */
function nodeKeysFor(layer: ObjectLayer, id: string, ctx: Ctx): NodeKeys | null {
  const frames = containingFrames(layer, id)
  if (frames.length === 0) return null
  const first = frames[0]
  const last = frames[frames.length - 1]

  if (ctx.holdStep > 1 || hasSmoothSegment(ctx, layer, id)) {
    // Baked keys: hold keys under a hold step (every pose is a step), linear
    // keys (except the final hold) for smooth segments so sub-frame playback
    // stays in motion.
    const smoothing = ctx.holdStep === 1
    const keyEasing = smoothing ? LINEAR_EASING : null
    const keys: KeySpec[] = []
    let ip = -1
    let op = -1
    for (let i = 0; i < ctx.frameCount; i++) {
      const f = ctx.evalFrames[i]
      if (f < first || f > last) continue
      const isFirst = ip === -1
      if (isFirst) {
        ip = i
      } else if (f !== ctx.evalFrames[i - 1]) {
        keys.push({ t: i, docFrame: f, easing: keyEasing })
      }
      if (isFirst) keys.push({ t: i, docFrame: f, easing: keyEasing })
      op = i + 1
    }
    if (ip === -1) return null
    if (smoothing) keys[keys.length - 1] = { ...keys[keys.length - 1], easing: null }
    return { keys, successor: null, ip, op }
  }

  const start = Math.max(first, ctx.fromFrame)
  const end = Math.min(last, ctx.toFrame)
  if (start > end) return null
  const keys: KeySpec[] = [
    { t: start - ctx.fromFrame, docFrame: start, easing: segmentEasingAt(layer, id, start) }
  ]
  for (const f of frames) {
    if (f <= start || f > end) continue
    keys.push({ t: f - ctx.fromFrame, docFrame: f, easing: segmentEasingAt(layer, id, f) })
  }
  const lastKey = keys[keys.length - 1]
  const successorFrame =
    lastKey.easing !== null ? (frames.find((f) => f > lastKey.docFrame) ?? null) : null
  return {
    keys,
    successor:
      successorFrame !== null
        ? { t: successorFrame - ctx.fromFrame, docFrame: successorFrame, easing: null }
        : null,
    ip: start - ctx.fromFrame,
    op: end - ctx.fromFrame + 1
  }
}

/** The child variant of a boundary spec: content inside a tweened group
 * snaps from the source keyframe, so every boundary key holds. */
function holdKeysOf(spec: NodeKeys): NodeKeys {
  return {
    keys: spec.keys.map((key) => ({ ...key, easing: null })),
    successor: null,
    ip: spec.ip,
    op: spec.op
  }
}

// ---------------------------------------------------------------------------
// Shape item builders
// ---------------------------------------------------------------------------

function dashStroke(width: number): LottieObject {
  return {
    ty: 'st',
    c: staticColor(PLACEHOLDER_STROKE),
    o: { a: 0, k: 100 },
    w: staticProp([width]),
    lc: 1,
    lj: 1,
    ml: 4,
    d: [
      { n: 'd', nm: 'dash', v: 4 },
      { n: 'g', nm: 'gap', v: 4 }
    ],
    nm: 'stroke'
  }
}

function fillItem(colorProp: LottieObject): LottieObject {
  return { ty: 'fl', c: colorProp, o: { a: 0, k: 100 }, r: 1, nm: 'fill' }
}

function strokeItem(colorProp: LottieObject, widthProp: LottieObject): LottieObject {
  return { ty: 'st', c: colorProp, o: { a: 0, k: 100 }, w: widthProp, lc: 1, lj: 1, ml: 4, nm: 'stroke' }
}

function transformItem(
  position: LottieObject,
  rotation: LottieObject,
  scale: LottieObject,
  opacity: LottieObject
): LottieObject {
  return {
    ty: 'tr',
    a: { a: 0, k: [0, 0] },
    p: position,
    r: rotation,
    s: scale,
    o: opacity,
    nm: 'transform'
  }
}

/** Dashed placeholder box sized by the pose (missing font / unresolved
 * symbol / missing image resource) — the Lottie twin of the SVG renderer's
 * placeholder markup. */
function placeholderItems(
  sizeProp: LottieObject,
  position: LottieObject,
  rotation: LottieObject,
  opacity: LottieObject
): LottieObject[] {
  return [
    { ty: 'rc', d: 1, p: { a: 0, k: [0, 0] }, s: sizeProp, r: { a: 0, k: 0 }, nm: 'placeholder' },
    { ty: 'fl', c: staticColor(PLACEHOLDER_FILL), o: { a: 0, k: 100 }, r: 1, nm: 'fill' },
    dashStroke(1),
    transformItem(position, rotation, scale100(), opacity)
  ]
}

function scale100(): LottieObject {
  return { a: 0, k: [100, 100] }
}

function shapeValueOf(subpath: { anchors: Array<{ x: number; y: number; in?: { x: number; y: number }; out?: { x: number; y: number } }>; closed: boolean }): LottieObject {
  return {
    i: subpath.anchors.map((anchor) => (anchor.in ? [round4(anchor.in.x), round4(anchor.in.y)] : [0, 0])),
    o: subpath.anchors.map((anchor) => (anchor.out ? [round4(anchor.out.x), round4(anchor.out.y)] : [0, 0])),
    v: subpath.anchors.map((anchor) => [round4(anchor.x), round4(anchor.y)]),
    c: subpath.closed
  }
}

/**
 * One `sh` item per subpath of a path node: static when the path data never
 * changes, keyed when it does. A segment whose endpoint poses are
 * morph-compatible (same per-subpath anchor count and closed flag — the
 * `morphPathData` rule) interpolates with `s`/`e` anchor triplets and the
 * segment's easing bezier; every other segment keeps a hold key (`h: 1`).
 * Path data that cannot be encoded or changes its subpath count across
 * keyframes falls back to the first pose plus a diagnostic.
 */
function pathGeometryItems(d: string, name: string): LottieObject[] {
  const subpaths = pathDataToSubpathAnchors(d)
  if (!subpaths) return []
  return subpaths.map((subpath, index) => ({
    ty: 'sh',
    d: 1,
    ks: { a: 0, k: shapeValueOf(subpath) },
    nm: subpaths.length > 1 ? `${name} ${index + 1}` : name
  }))
}

interface AnimatedPathKey {
  t: number
  d: string
  easing: CubicBezierEasing | null
}

type ParsedSubpath = { anchors: PathAnchor[]; closed: boolean }

/** Morph compatibility of two parsed poses (counts and closed flags only —
 * a property of the anchor structure, not of the coordinates). */
function posesMorphCompatible(a: ParsedSubpath[], b: ParsedSubpath[]): boolean {
  for (let index = 0; index < a.length; index++) {
    if (a[index].anchors.length !== b[index].anchors.length) return false
    if (a[index].closed !== b[index].closed) return false
  }
  return true
}

function pathGeometryItemsAnimated(
  name: string,
  channel: AnimatedPathKey[],
  ctx: Ctx
): LottieObject[] | null {
  const parsed = channel.map((key) => pathDataToSubpathAnchors(key.d))
  if (parsed.some((entry) => entry === null)) return null
  const subpathCount = parsed[0]!.length
  if (parsed.some((entry) => entry!.length !== subpathCount)) return null
  let heldTween = false
  const interpolating = channel.map((key, keyIndex) => {
    const next = keyIndex < channel.length - 1 ? parsed[keyIndex + 1]! : null
    const morphs = key.easing !== null && next !== null && posesMorphCompatible(parsed[keyIndex]!, next)
    if (morphs !== (key.easing !== null)) heldTween = true
    return morphs
  })
  if (heldTween) {
    report(
      ctx,
      `The path data of "${name}" cannot morph between keyframes (the anchor structure differs); the Lottie file holds the outline over those segments.`
    )
  }
  const items: LottieObject[] = []
  for (let index = 0; index < subpathCount; index++) {
    items.push({
      ty: 'sh',
      d: 1,
      ks: {
        a: 1,
        k: channel.map((key, keyIndex) => {
          const shape = shapeValueOf(parsed[keyIndex]![index])
          // Keyed shape values are array-wrapped (bodymovin convention):
          // lottie-web reads `s[0]`/`e[0]` for path keyframes.
          if (!interpolating[keyIndex]) {
            return { t: key.t, s: [shape], h: 1, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } }
          }
          const easing = key.easing!
          return {
            t: key.t,
            s: [shape],
            e: [shapeValueOf(parsed[keyIndex + 1]![index])],
            o: { x: round4(easing.x1), y: round4(easing.y1) },
            i: { x: round4(easing.x2), y: round4(easing.y2) }
          }
        })
      },
      nm: subpathCount > 1 ? `${name} ${index + 1}` : name
    })
  }
  return items
}

// ---------------------------------------------------------------------------
// Node content building
// ---------------------------------------------------------------------------

type NodeRead = (pose: SceneNode) => number[] | null

const READ_CENTER: NodeRead = (pose) => [pose.center.x, pose.center.y]
const READ_ROTATION: NodeRead = (pose) => [pose.rotation]
const READ_OPACITY: NodeRead = (pose) => [pose.opacity * 100]
const READ_SIZE: NodeRead = (pose) => [pose.width, pose.height]

function readScaleOf(pose: SceneNode): number[] {
  if (pose.type === 'group') {
    const natural = groupNaturalSize(pose.children)
    const sx = natural.width === 0 ? 1 : pose.width / natural.width
    const sy = natural.height === 0 ? 1 : pose.height / natural.height
    return [sx * 100, sy * 100]
  }
  if (pose.type === 'path') {
    const natural = pathNaturalSize(pose)
    const sx = natural.width === 0 ? 1 : pose.width / natural.width
    const sy = natural.height === 0 ? 1 : pose.height / natural.height
    return [sx * 100, sy * 100]
  }
  return [100, 100]
}

const READ_SCALE: NodeRead = (pose) => readScaleOf(pose)

type PaintBasisOf = (pose: SceneNode) => { width: number; height: number }

/** A paint value usable for export: a parseable flat color or a gradient;
 * null for `none`, unparseable strings and missing paints (callers fall back
 * to the previous boundary, mirroring the numeric channels). */
function usablePaintOf(paint: Paint | undefined): Paint | null {
  if (paint === undefined) return null
  if (typeof paint === 'string') {
    if (paint.trim().toLowerCase() === 'none') return null
    return colorChannels(paint) ? paint : null
  }
  return paint
}

/** Flat stop array of a gradient: `[offset, r, g, b] × p` plus, when any
 * stop carries alpha, the mirrored `[offset, alpha] × p` section lottie-web
 * folds onto the stops as `stop-opacity` (lottie-web reads offsets ×100 and
 * colors ×255). Null when a stop color cannot be parsed. */
function gradientStopValues(paint: GradientPaint, includeAlpha: boolean): number[] | null {
  const values: number[] = []
  for (const stop of paint.stops) {
    const rgb = parseHexColor(stop.color)
    if (!rgb) return null
    values.push(round4(stop.offset), round4(rgb[0] / 255), round4(rgb[1] / 255), round4(rgb[2] / 255))
  }
  if (includeAlpha) {
    for (const stop of paint.stops) values.push(round4(stop.offset), round4(stop.alpha ?? 1))
  }
  return values
}

function gradientHasAlpha(paint: GradientPaint): boolean {
  return paint.stops.some((stop) => stop.alpha !== undefined && stop.alpha !== 1)
}

/** Local-space endpoints of a gradient inside a node's bounding box. Linear
 * angles reproduce the renderer's `objectBoundingBox` mapping exactly; the
 * radial form uses the average of the box's width and height as the radius
 * (lottie has a single radius — exact for square boxes, approximated
 * otherwise with a diagnostic). */
function gradientGeometry(
  paint: GradientPaint,
  basis: { width: number; height: number }
): { start: number[]; end: number[] } {
  if (paint.type === 'linear') {
    const radians = (paint.angle * Math.PI) / 180
    const dx = Math.cos(radians)
    const dy = Math.sin(radians)
    return {
      start: [round4(-0.5 * dx * basis.width), round4(-0.5 * dy * basis.height)],
      end: [round4(0.5 * dx * basis.width), round4(0.5 * dy * basis.height)]
    }
  }
  const cx = round4((paint.cx - 0.5) * basis.width)
  const cy = round4((paint.cy - 0.5) * basis.height)
  const radius = round4((paint.r * (basis.width + basis.height)) / 2)
  return { start: [cx, cy], end: [round4(cx + radius), cy] }
}

function gradientItemOf(
  kind: 'fill' | 'stroke',
  paint: GradientPaint,
  start: LottieObject,
  end: LottieObject,
  stops: LottieObject,
  widthProp: LottieObject | null
): LottieObject {
  const item: LottieObject = {
    ty: kind === 'fill' ? 'gf' : 'gs',
    o: { a: 0, k: 100 },
    s: start,
    e: end,
    t: paint.type === 'linear' ? 1 : 2,
    g: { p: paint.stops.length, k: stops },
    nm: kind
  }
  if (kind === 'stroke' && widthProp) item.w = widthProp
  return item
}

/** One static gradient item (`s`/`e`/`g` unkeyed) for the fallback cases. */
function staticGradientItem(
  kind: 'fill' | 'stroke',
  paint: GradientPaint,
  widthProp: LottieObject | null,
  basis: { width: number; height: number }
): LottieObject | null {
  const stops = gradientStopValues(paint, gradientHasAlpha(paint))
  if (!stops) return null
  const geometry = gradientGeometry(paint, basis)
  return gradientItemOf(
    kind,
    paint,
    staticProp(geometry.start),
    staticProp(geometry.end),
    staticProp(stops),
    widthProp
  )
}

/** The paint item for a fallback decision: static color or static
 * gradient, from one resolved paint value. */
function staticPaintItem(
  kind: 'fill' | 'stroke',
  paint: Paint,
  widthProp: LottieObject | null,
  basis: { width: number; height: number }
): LottieObject | null {
  if (typeof paint === 'string') {
    const channels = colorChannels(paint)
    if (!channels) return null
    return kind === 'fill' ? fillItem({ a: 0, k: channels }) : strokeItem({ a: 0, k: channels }, widthProp!)
  }
  return staticGradientItem(kind, paint, widthProp, basis)
}

interface NodeBuildArgs {
  ctx: Ctx
  spec: NodeKeys
  firstPose: SceneNode
  /** Reads a pose by doc frame (top-level node lookup). */
  poseAt: (docFrame: number) => SceneNode | null
  /** Reads a child node by doc frame (tree lookup, for nested content). */
  childAt: (docFrame: number, id: string) => SceneNode | null
  name: string
}

function channelFor(args: NodeBuildArgs, read: NodeRead): LottieObject | null {
  return collectChannel(args.spec, (docFrame) => {
    const pose = args.poseAt(docFrame)
    return pose ? read(pose) : null
  })
}

/**
 * Fill or stroke item of one node. Solid paints export as color channels
 * like before; gradients bake their endpoints and stops per output frame
 * through the evaluator (exact at integer frames; lottie interpolates
 * linearly between baked frames). A paint whose kind (solid ↔ gradient)
 * changes across the node's keyframes keeps the first paint plus a
 * diagnostic — the same snap the renderer's `lerpPaint` documents.
 */
function paintItemFor(
  args: NodeBuildArgs,
  kind: 'fill' | 'stroke',
  readPaint: (pose: SceneNode) => Paint | undefined,
  widthProp: LottieObject | null,
  basisOf: PaintBasisOf
): LottieObject | null {
  if (kind === 'stroke' && !widthProp) return null
  const boundaryKeys: KeySpec[] = [...args.spec.keys]
  const tail = boundaryKeys[boundaryKeys.length - 1]
  if (tail && tail.easing !== null && args.spec.successor) boundaryKeys.push(args.spec.successor)
  const boundaries: Array<{ t: number; easing: CubicBezierEasing | null; paint: Paint }> = []
  let last: Paint | null = null
  for (const key of boundaryKeys) {
    const pose = args.poseAt(key.docFrame)
    const paint: Paint | null = (pose ? usablePaintOf(readPaint(pose)) : null) ?? last
    if (!paint) return null
    boundaries.push({ t: key.t, easing: key.easing, paint })
    last = paint
  }
  if (boundaries.length === 0) return null
  const hasSolid = boundaries.some((boundary) => typeof boundary.paint === 'string')
  const hasGradient = boundaries.some((boundary) => typeof boundary.paint !== 'string')
  if (hasSolid && hasGradient) {
    report(
      args.ctx,
      `The paint of "${args.name}" changes between solid and gradient across keyframes; the Lottie file keeps the first paint.`
    )
    return staticPaintItem(kind, boundaries[0].paint, widthProp, basisOf(args.firstPose))
  }
  if (!hasGradient) {
    const channel = propertyFromChannel(
      boundaries.map((boundary) => ({
        t: boundary.t,
        value: colorChannels(boundary.paint as string)!,
        easing: boundary.easing
      }))
    )
    return kind === 'fill' ? fillItem(channel) : strokeItem(channel, widthProp!)
  }
  return bakedGradientItem(args, kind, readPaint, widthProp, basisOf)
}

/** Bakes one gradient paint into `gf`/`gs` channels: every output frame of
 * the node's presence samples the evaluated pose (paint and basis together),
 * so mid-tween geometry and stops match the renderer. A gradient whose stop
 * count changes across keyframes keeps the first gradient plus a
 * diagnostic. */
function bakedGradientItem(
  args: NodeBuildArgs,
  kind: 'fill' | 'stroke',
  readPaint: (pose: SceneNode) => Paint | undefined,
  widthProp: LottieObject | null,
  basisOf: PaintBasisOf
): LottieObject | null {
  interface GradientSample {
    t: number
    paint: GradientPaint
    basis: { width: number; height: number }
  }
  const samples: GradientSample[] = []
  let lastPaint: GradientPaint | null = null
  let lastBasis: { width: number; height: number } | null = null
  let previousFrame = Number.NaN
  for (let i = args.spec.ip; i < args.spec.op; i++) {
    const f = args.ctx.evalFrames[i]
    if (f === previousFrame) continue
    previousFrame = f
    const pose = args.poseAt(f)
    const sampled = pose ? usablePaintOf(readPaint(pose)) : null
    const paint: GradientPaint | null = sampled && typeof sampled !== 'string' ? sampled : lastPaint
    const basis: { width: number; height: number } | null = pose ? basisOf(pose) : lastBasis
    if (!paint || !basis) return null
    samples.push({ t: i, paint, basis })
    lastPaint = paint
    lastBasis = basis
  }
  if (samples.length === 0) return null
  const stopCount = samples[0].paint.stops.length
  if (samples.some((sample) => sample.paint.stops.length !== stopCount)) {
    report(
      args.ctx,
      `The gradient of "${args.name}" changes its stop count across keyframes; the Lottie file keeps the first gradient.`
    )
    return staticGradientItem(kind, samples[0].paint, widthProp, samples[0].basis)
  }
  if (
    samples.some(
      (sample) =>
        sample.paint.type === 'radial' &&
        sample.paint.r > 0 &&
        Math.abs(sample.basis.width - sample.basis.height) > 1e-6
    )
  ) {
    report(
      args.ctx,
      `The radial gradient of "${args.name}" sits on a non-square box; the Lottie file approximates its radius.`
    )
  }
  const holdMode = args.ctx.holdStep > 1
  const easingAt = (index: number): CubicBezierEasing | null =>
    holdMode || index === samples.length - 1 ? null : LINEAR_EASING
  const hasAlpha = samples.some((sample) => gradientHasAlpha(sample.paint))
  const startKeys: ChannelKey[] = []
  const endKeys: ChannelKey[] = []
  const stopKeys: ChannelKey[] = []
  let lastStops: number[] | null = null
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]
    const geometry = gradientGeometry(sample.paint, sample.basis)
    const stops: number[] | null = gradientStopValues(sample.paint, hasAlpha) ?? lastStops
    if (!stops) return null
    startKeys.push({ t: sample.t, value: geometry.start, easing: easingAt(index) })
    endKeys.push({ t: sample.t, value: geometry.end, easing: easingAt(index) })
    stopKeys.push({ t: sample.t, value: stops, easing: easingAt(index) })
    lastStops = stops
  }
  return gradientItemOf(
    kind,
    samples[0].paint,
    propertyFromChannel(startKeys),
    propertyFromChannel(endKeys),
    propertyFromChannel(stopKeys),
    widthProp
  )
}

/** Type/primitive-kind consistency across the node's keyframes: mismatches
 * fall back to a static first pose plus a diagnostic. */
function isTypeStable(args: NodeBuildArgs): boolean {
  for (const key of args.spec.keys) {
    const pose = args.poseAt(key.docFrame)
    if (!pose) continue
    const kind = (candidate: SceneNode): string =>
      candidate.type === 'primitive' ? `primitive:${candidate.primitive}` : candidate.type
    if (kind(pose) !== kind(args.firstPose)) {
      report(
        args.ctx,
        `"${args.name}" changes its object type across keyframes; the Lottie file keeps the first pose.`
      )
      return false
    }
  }
  return true
}

function primitiveContentItems(args: NodeBuildArgs): LottieObject[] {
  const pose = args.firstPose
  if (pose.type !== 'primitive') return []
  const size = channelFor(args, READ_SIZE)
  const position = channelFor(args, READ_CENTER)
  const rotation = channelFor(args, READ_ROTATION)
  const opacity = channelFor(args, READ_OPACITY)
  if (!size || !position || !rotation || !opacity) return []
  const basis: PaintBasisOf = (candidate) => ({ width: candidate.width, height: candidate.height })
  const items: LottieObject[] = [
    {
      ty: pose.primitive === 'ellipse' ? 'el' : 'rc',
      d: 1,
      p: { a: 0, k: [0, 0] },
      s: size,
      ...(pose.primitive === 'rect' ? { r: { a: 0, k: 0 } } : {}),
      nm: args.name
    }
  ]
  if (pose.stroke !== undefined) {
    const width = channelFor(args, (candidate) =>
      candidate.type === 'primitive' ? [candidate.strokeWidth ?? 1] : null
    )
    const stroke = width
      ? paintItemFor(
          args,
          'stroke',
          (candidate) => (candidate.type === 'primitive' ? candidate.stroke : undefined),
          width,
          basis
        )
      : null
    if (stroke) items.push(stroke)
  }
  if (pose.fill !== 'none') {
    const fill = paintItemFor(
      args,
      'fill',
      (candidate) => (candidate.type === 'primitive' ? candidate.fill : undefined),
      null,
      basis
    )
    if (fill) items.push(fill)
  }
  items.push(transformItem(position, rotation, scale100(), opacity))
  return items
}

function pathContentItems(args: NodeBuildArgs): LottieObject[] {
  const pose = args.firstPose
  if (pose.type !== 'path') return []
  const position = channelFor(args, READ_CENTER)
  const rotation = channelFor(args, READ_ROTATION)
  const opacity = channelFor(args, READ_OPACITY)
  const scale = channelFor(args, READ_SCALE)
  if (!position || !rotation || !opacity || !scale) return []
  const basis: PaintBasisOf = (candidate) =>
    candidate.type === 'path'
      ? pathNaturalSize(candidate)
      : { width: candidate.width, height: candidate.height }
  const items: LottieObject[] = pathGeometryFor(args)
  if (pose.stroke !== undefined) {
    const width = channelFor(args, (candidate) =>
      candidate.type === 'path' ? [candidate.strokeWidth ?? 1] : null
    )
    const stroke = width
      ? paintItemFor(
          args,
          'stroke',
          (candidate) => (candidate.type === 'path' ? candidate.stroke : undefined),
          width,
          basis
        )
      : null
    if (stroke) items.push(stroke)
  }
  if (pose.fill !== undefined) {
    const fill = paintItemFor(
      args,
      'fill',
      (candidate) => (candidate.type === 'path' ? candidate.fill : undefined),
      null,
      basis
    )
    if (fill) items.push(fill)
  }
  items.push(transformItem(position, rotation, scale, opacity))
  return items
}

function pathGeometryFor(args: NodeBuildArgs): LottieObject[] {
  const pose = args.firstPose
  if (pose.type !== 'path') return []
  const dChannel: AnimatedPathKey[] = []
  let staticData = true
  for (const key of args.spec.keys) {
    const current = args.poseAt(key.docFrame)
    if (!current || current.type !== 'path') continue
    dChannel.push({ t: key.t, d: current.d, easing: key.easing })
    if (current.d !== pose.d) staticData = false
  }
  // The successor target of a segment the export range cuts short (same
  // interpolation target numeric channels sample).
  if (args.spec.successor) {
    const successorPose = args.poseAt(args.spec.successor.docFrame)
    if (successorPose && successorPose.type === 'path') {
      dChannel.push({ t: args.spec.successor.t, d: successorPose.d, easing: null })
      if (successorPose.d !== pose.d) staticData = false
    }
  }
  if (dChannel.length === 0) return []
  if (staticData) return pathGeometryItems(pose.d, args.name)
  const animated = pathGeometryItemsAnimated(args.name, dChannel, args.ctx)
  if (animated) return animated
  report(
    args.ctx,
    `The path data of "${args.name}" changes shape across keyframes; the Lottie file keeps the first outline.`
  )
  return pathGeometryItems(pose.d, args.name)
}

async function groupContentItems(args: NodeBuildArgs): Promise<LottieObject[]> {
  const pose = args.firstPose
  if (pose.type !== 'group') return []
  const position = channelFor(args, READ_CENTER)
  const rotation = channelFor(args, READ_ROTATION)
  const opacity = channelFor(args, READ_OPACITY)
  const scale = channelFor(args, READ_SCALE)
  if (!position || !rotation || !opacity || !scale) return []
  // Children snap from the source keyframe, so their channels hold; a group
  // whose children change across keyframes exports its first content.
  const firstChildren = JSON.stringify(pose.children)
  for (const key of args.spec.keys) {
    const current = args.poseAt(key.docFrame)
    if (current && current.type === 'group' && JSON.stringify(current.children) !== firstChildren) {
      report(
        args.ctx,
        `Group "${args.name}" changes its children across keyframes; the Lottie file keeps the first content.`
      )
      break
    }
  }
  const items: LottieObject[] = []
  // lottie-web paints the first item of `it` on top, so the children are
  // emitted reversed to match the SVG renderer's bottom-first paint order.
  for (const child of [...pose.children].reverse()) {
    const childItems = await buildChildItems(args, child)
    items.push(...childItems)
  }
  items.push(transformItem(position, rotation, scale, opacity))
  return items
}

async function buildChildItems(args: NodeBuildArgs, child: SceneNode): Promise<LottieObject[]> {
  if (child.type === 'image') return []
  const childArgs: NodeBuildArgs = {
    ...args,
    firstPose: child,
    name: child.name ?? child.id,
    poseAt: (docFrame) => args.childAt(docFrame, child.id)
  }
  return [await nestedGroupOf(childArgs)]
}

async function nestedGroupOf(args: NodeBuildArgs): Promise<LottieObject> {
  const childArgs: NodeBuildArgs = { ...args, spec: holdKeysOf(args.spec) }
  let content: LottieObject[]
  switch (args.firstPose.type) {
    case 'primitive':
      content = primitiveContentItems(childArgs)
      break
    case 'path':
      content = pathContentItems(childArgs)
      break
    case 'text':
      content = await textContentItems(childArgs)
      break
    case 'group':
      content = await groupContentItems(childArgs)
      break
    case 'symbol': {
      const size = channelFor(childArgs, READ_SIZE)
      const position = channelFor(childArgs, READ_CENTER)
      const rotation = channelFor(childArgs, READ_ROTATION)
      const opacity = channelFor(childArgs, READ_OPACITY)
      content =
        size && position && rotation && opacity
          ? placeholderItems(size, position, rotation, opacity)
          : []
      break
    }
    default:
      content = []
  }
  return { ty: 'gr', it: content, nm: args.name }
}

async function textContentItems(args: NodeBuildArgs): Promise<LottieObject[]> {
  const pose = args.firstPose
  if (pose.type !== 'text') return []
  const position = channelFor(args, READ_CENTER)
  const rotation = channelFor(args, READ_ROTATION)
  const opacity = channelFor(args, READ_OPACITY)
  if (!position || !rotation || !opacity) return []
  const size = channelFor(args, READ_SIZE) ?? staticProp([pose.width, pose.height])
  let outline: PathNode | null = null
  if (args.ctx.deps.outlineText) {
    const cacheKey = JSON.stringify([
      pose.text,
      pose.fontFamily,
      pose.fontWeight,
      pose.fontSize,
      pose.letterSpacing ?? 0,
      pose.lineHeight ?? null,
      pose.verticalAlign ?? 'top',
      pose.width,
      pose.height
    ])
    if (args.ctx.outlineCache.has(cacheKey)) {
      outline = args.ctx.outlineCache.get(cacheKey) ?? null
    } else {
      outline = await args.ctx.deps.outlineText(pose)
      args.ctx.outlineCache.set(cacheKey, outline)
    }
  }
  for (const key of args.spec.keys) {
    const current = args.poseAt(key.docFrame)
    if (current && current.type === 'text') {
      if (
        current.text !== pose.text ||
        current.fontSize !== pose.fontSize ||
        current.fontFamily !== pose.fontFamily ||
        current.fontWeight !== pose.fontWeight
      ) {
        report(
          args.ctx,
          `Text "${snippet(pose.text)}" changes across keyframes; the Lottie file outlines the first pose.`
        )
        break
      }
    }
  }
  if (!outline) {
    report(
      args.ctx,
      `No font could be loaded for "${pose.fontFamily}"; a placeholder box replaces "${snippet(pose.text)}" in the Lottie file.`
    )
    return placeholderItems(size, position, rotation, opacity)
  }
  const items: LottieObject[] = pathGeometryItems(outline.d, snippet(pose.text))
  const outlineNatural = pathNaturalSize(outline)
  const scale = staticProp([
    outlineNatural.width === 0 ? 100 : (outline.width / outlineNatural.width) * 100,
    outlineNatural.height === 0 ? 100 : (outline.height / outlineNatural.height) * 100
  ])
  const basis: PaintBasisOf = () => outlineNatural
  if (pose.stroke !== undefined) {
    // Outline geometry lives in natural glyph space; the width divides by
    // the outline-to-node scale so the rendered stroke keeps its stage size.
    const outlineScaleX = outlineNatural.width === 0 ? 1 : outline.width / outlineNatural.width
    const width = channelFor(args, (candidate) =>
      candidate.type === 'text' ? [round4((candidate.strokeWidth ?? 1) / outlineScaleX)] : null
    )
    const stroke = width
      ? paintItemFor(
          args,
          'stroke',
          (candidate) => (candidate.type === 'text' ? candidate.stroke : undefined),
          width,
          basis
        )
      : null
    if (stroke) items.push(stroke)
  }
  const fill = paintItemFor(
    args,
    'fill',
    (candidate) => (candidate.type === 'text' ? candidate.fill : undefined),
    null,
    basis
  )
  if (fill) items.push(fill)
  items.push(transformItem(position, rotation, scale, opacity))
  return items
}

function snippet(text: string): string {
  return text.length > 24 ? `${text.slice(0, 24)}…` : text
}

// ---------------------------------------------------------------------------
// Layer assembly
// ---------------------------------------------------------------------------

function shapeLayerOf(name: string, items: LottieObject[], ip: number, op: number): LottieObject {
  return {
    ddd: 0,
    ty: 4,
    nm: name,
    sr: 1,
    ks: IDENTITY_LAYER_KS(),
    ao: 0,
    shapes: items.length > 0 ? [{ ty: 'gr', it: items, nm: name }] : [],
    ip,
    op,
    st: 0,
    bm: 0
  }
}

function imageLayerOf(
  name: string,
  refId: string,
  anchor: number[],
  channels: { p: LottieObject; r: LottieObject; s: LottieObject; o: LottieObject },
  ip: number,
  op: number
): LottieObject {
  return {
    ddd: 0,
    ty: 2,
    nm: name,
    sr: 1,
    ks: { a: staticProp(anchor), p: channels.p, r: channels.r, s: channels.s, o: channels.o },
    ao: 0,
    refId,
    ip,
    op,
    st: 0,
    bm: 0
  }
}

async function ensureImageAsset(
  ctx: Ctx,
  resourceId: string,
  naturalWidth: number,
  naturalHeight: number
): Promise<string | null> {
  if (ctx.assetIdByResource.has(resourceId)) return ctx.assetIdByResource.get(resourceId) ?? null
  const dataUrl = await ctx.deps.resolveResourceDataUrl(resourceId)
  if (!dataUrl) {
    report(ctx, `Image resource "${resourceId}" could not be resolved; a placeholder is exported.`)
    ctx.assetIdByResource.set(resourceId, null)
    return null
  }
  const id = `img_${ctx.imageAssets.length + 1}`
  ctx.imageAssets.push({
    id,
    w: naturalWidth,
    h: naturalHeight,
    u: '',
    p: dataUrl,
    e: 1
  })
  ctx.assetIdByResource.set(resourceId, id)
  return id
}

interface ImageChannels {
  p: LottieObject
  r: LottieObject
  s: LottieObject
  o: LottieObject
}

/** Flattened placement channels of one image chain: ancestor matrices
 * composed per boundary pose, decomposed into position/rotation/scale. */
function imageChannelsFor(
  ctx: Ctx,
  spec: NodeKeys,
  chainIds: string[],
  poseRootAt: (docFrame: number) => SceneNode | null,
  name: string
): ImageChannels | null {
  const composedAt = (docFrame: number): ComposedImage | null => {
    const root = poseRootAt(docFrame)
    if (!root) return null
    const chain: SceneNode[] = []
    let current = root
    for (const id of chainIds) {
      const found = current.id === id ? current : findNodeInTree(current, id)
      if (!found) return null
      chain.push(found)
      current = found
    }
    const composed = composeImageChain(chain)
    if (composed.shear > 1e-3 && chain.length > 1) {
      report(
        ctx,
        `Image "${name}" sits under rotated, non-uniformly scaled groups; its motion is approximated in the Lottie file.`
      )
    }
    return composed
  }
  const readChannel = (pick: (composed: ComposedImage) => number[]): LottieObject | null =>
    collectChannel(spec, (docFrame) => {
      const composed = composedAt(docFrame)
      return composed ? pick(composed) : null
    })
  const p = readChannel((composed) => composed.position)
  const r = readChannel((composed) => [composed.rotation])
  const s = readChannel((composed) => composed.scale)
  const o = readChannel((composed) => [composed.opacity])
  if (!p || !r || !s || !o) return null
  return { p, r, s, o }
}

async function imageLayersFor(
  ctx: Ctx,
  spec: NodeKeys,
  chains: SceneNode[][],
  poseRootAt: (docFrame: number) => SceneNode | null,
  layerName: string
): Promise<LottieObject[]> {
  const layers: LottieObject[] = []
  for (const chain of chains) {
    const image = chain[chain.length - 1] as ImageNode
    const name = image.name ?? layerName
    const channels = imageChannelsFor(
      ctx,
      spec,
      chain.map((node) => node.id),
      poseRootAt,
      name
    )
    if (!channels) continue
    const anchor = [image.naturalWidth / 2, image.naturalHeight / 2]
    const assetId = await ensureImageAsset(ctx, image.resourceId, image.naturalWidth, image.naturalHeight)
    if (assetId) {
      layers.push(imageLayerOf(name, assetId, anchor, channels, spec.ip, spec.op))
    } else {
      layers.push(
        shapeLayerOf(
          name,
          [
            {
              ty: 'rc',
              d: 1,
              p: { a: 0, k: [0, 0] },
              s: staticProp([image.naturalWidth, image.naturalHeight]),
              r: { a: 0, k: 0 },
              nm: name
            },
            { ty: 'fl', c: staticColor(PLACEHOLDER_FILL), o: { a: 0, k: 100 }, r: 1, nm: 'fill' },
            dashStroke(1),
            {
              ty: 'tr',
              a: { a: 0, k: [0, 0] },
              p: channels.p,
              r: channels.r,
              s: channels.s,
              o: channels.o,
              nm: 'transform'
            }
          ],
          spec.ip,
          spec.op
        )
      )
    }
  }
  return layers
}

// ---------------------------------------------------------------------------
// Audio layers
// ---------------------------------------------------------------------------

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  webm: 'audio/webm'
}

/** Chunked base64 for embedded audio (the spread-argument limit forbids one
 * `String.fromCharCode` call over a whole file). */
function base64Of(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK)
    let part = ''
    for (let j = 0; j < chunk.length; j++) part += String.fromCharCode(chunk[j])
    binary += part
  }
  return btoa(binary)
}

/** Registers one audio asset (deduplicated by resource id): a data-URI asset
 * when embedding, a side-file asset registered in `ctx.audioFiles` otherwise.
 * Unresolvable resources report once and stay silent. */
async function ensureAudioAsset(ctx: Ctx, layer: AudioLayer, mode: LottieAudioMode): Promise<string | null> {
  const cached = ctx.audioAssetIdByResource.get(layer.resourceId)
  if (cached !== undefined) return cached
  const resolved = ctx.deps.resolveResourceBytes
    ? await ctx.deps.resolveResourceBytes(layer.resourceId)
    : null
  if (!resolved) {
    report(
      ctx,
      `Audio resource "${layer.resourceId}" could not be embedded; the exported animation is silent.`
    )
    ctx.audioAssetIdByResource.set(layer.resourceId, null)
    return null
  }
  const id = `aud_${ctx.audioAssets.length + 1}`
  const ext = /^[a-z0-9]{1,8}$/i.test(resolved.ext) ? resolved.ext.toLowerCase() : 'bin'
  if (mode === 'files') {
    const path = `audio/${id}.${ext}`
    ctx.audioFiles.set(path, resolved.bytes)
    ctx.audioAssets.push({ id, u: 'audio/', p: `${id}.${ext}`, e: 0 })
  } else {
    const mime = AUDIO_MIME_BY_EXT[ext] ?? 'application/octet-stream'
    ctx.audioAssets.push({ id, u: '', p: `data:${mime};base64,${base64Of(resolved.bytes)}`, e: 1 })
  }
  ctx.audioAssetIdByResource.set(layer.resourceId, id)
  return id
}

/** One `ty: 6` audio layer. `st` stays 0; the time-remap property carries
 * the clip position in SECONDS (lottie-web multiplies it by the frame rate
 * into frames, then seeks by value/rate again) so the audio skips into the
 * clip when the export range starts after the layer. */
function audioLayerOf(ctx: Ctx, layer: AudioLayer, refId: string): LottieObject {
  const ip = Math.max(0, layer.startFrame - ctx.fromFrame)
  const clipOffset = Math.max(0, ctx.fromFrame - layer.startFrame)
  const first: ChannelKey = {
    t: ip,
    value: [round4(clipOffset / ctx.fps)],
    easing: LINEAR_EASING
  }
  const tm =
    ip < ctx.frameCount - 1
      ? propertyFromChannel([
          first,
          {
            t: ctx.frameCount - 1,
            value: [round4((clipOffset + ctx.frameCount - 1 - ip) / ctx.fps)],
            easing: null
          }
        ])
      : propertyFromChannel([{ ...first, easing: null }])
  return {
    ddd: 0,
    ty: 6,
    nm: layer.name,
    sr: 1,
    ks: IDENTITY_LAYER_KS(),
    ao: 0,
    refId,
    ip,
    op: ctx.frameCount,
    st: 0,
    bm: 0,
    au: { lv: { a: 0, k: [round4(layer.volume * 100)] } },
    tm
  }
}

// ---------------------------------------------------------------------------
// Object layer processing
// ---------------------------------------------------------------------------

function layerNodeOrder(layer: ObjectLayer): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  for (const keyframe of layer.keyframes) {
    for (const node of keyframe.nodes) {
      if (seen.has(node.id)) continue
      seen.add(node.id)
      order.push(node.id)
    }
  }
  return order
}

async function appendObjectLayerEntries(ctx: Ctx, layer: ObjectLayer, out: LottieObject[]): Promise<void> {
  const poseSource = poseSourceFor(ctx, layer)
  for (const id of layerNodeOrder(layer)) {
    const spec = nodeKeysFor(layer, id, ctx)
    if (!spec) continue
    const firstPose = poseSource(spec.keys[0].docFrame).get(id)
    if (!firstPose) continue
    const name = firstPose.name ?? layer.name
    const poseAt = (docFrame: number): SceneNode | null => poseSource(docFrame).get(id) ?? null
    const childAt = (docFrame: number, childId: string): SceneNode | null => {
      const parent = poseAt(docFrame)
      return parent ? findNodeInTree(parent, childId) : null
    }

    if (firstPose.type === 'image') {
      out.push(
        ...(await imageLayersFor(ctx, spec, [[firstPose]], poseAt, layer.name))
      )
      continue
    }

    const stable = isTypeStable({ ctx, spec, firstPose, poseAt, childAt, name })
    const effectiveSpec: NodeKeys = stable ? spec : { keys: [spec.keys[0]], successor: null, ip: spec.ip, op: spec.op }
    const args: NodeBuildArgs = { ctx, spec: effectiveSpec, firstPose, poseAt, childAt, name }

    let items: LottieObject[] | null
    switch (firstPose.type) {
      case 'primitive':
        items = primitiveContentItems(args)
        break
      case 'path':
        items = pathContentItems(args)
        break
      case 'group':
        items = await groupContentItems(args)
        break
      case 'text':
        items = await textContentItems(args)
        break
      case 'symbol': {
        const size = channelFor(args, READ_SIZE)
        const position = channelFor(args, READ_CENTER)
        const rotation = channelFor(args, READ_ROTATION)
        const opacity = channelFor(args, READ_OPACITY)
        items =
          size && position && rotation && opacity
            ? placeholderItems(size, position, rotation, opacity)
            : null
        break
      }
      default:
        items = null
    }
    if (items && items.length > 0) {
      out.push(shapeLayerOf(name, items, effectiveSpec.ip, effectiveSpec.op))
    }
    const chains = imageChains(firstPose)
    if (chains.length > 0) {
      out.push(...(await imageLayersFor(ctx, effectiveSpec, chains, poseAt, layer.name)))
    }
  }
}

function appendCellEntries(ctx: Ctx, layer: DrawingLayer, out: LottieObject[]): Promise<void> {
  const naturalWidth = Math.max(1, Math.round(ctx.document.width * layer.resolutionScale))
  const naturalHeight = Math.max(1, Math.round(ctx.document.height * layer.resolutionScale))
  const scale = staticProp([
    (ctx.document.width / naturalWidth) * 100,
    (ctx.document.height / naturalHeight) * 100
  ])
  const center = staticProp([ctx.document.width / 2, ctx.document.height / 2])
  const entries: Array<Promise<void>> = []
  for (let index = 0; index < layer.cells.length; index++) {
    const cell = layer.cells[index]
    const next = layer.cells[index + 1]
    const endFrame = next ? next.frame - 1 : Infinity
    let ip = -1
    let op = -1
    for (let i = 0; i < ctx.frameCount; i++) {
      const f = ctx.evalFrames[i]
      if (f < cell.frame || f > endFrame) continue
      if (ip === -1) ip = i
      op = i + 1
    }
    if (ip === -1) continue
    entries.push(
      ensureImageAsset(ctx, cell.resourceId, naturalWidth, naturalHeight).then((assetId) => {
        if (assetId) {
          out.push(
            imageLayerOf(
              layer.name,
              assetId,
              [naturalWidth / 2, naturalHeight / 2],
              {
                p: center,
                r: staticProp([0]),
                s: scale,
                o: staticProp([100])
              },
              ip,
              op
            )
          )
        } else {
          out.push(
            shapeLayerOf(
              layer.name,
              [
                {
                  ty: 'rc',
                  d: 1,
                  p: { a: 0, k: [0, 0] },
                  s: staticProp([ctx.document.width, ctx.document.height]),
                  r: { a: 0, k: 0 },
                  nm: layer.name
                },
                { ty: 'fl', c: staticColor(PLACEHOLDER_FILL), o: { a: 0, k: 100 }, r: 1, nm: 'fill' },
                dashStroke(1),
                {
                  ty: 'tr',
                  a: { a: 0, k: [0, 0] },
                  p: center,
                  r: staticProp([0]),
                  s: staticProp([100, 100]),
                  o: staticProp([100]),
                  nm: 'transform'
                }
              ],
              ip,
              op
            )
          )
        }
      })
    )
  }
  return Promise.all(entries).then(() => undefined)
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

function cameraEasingAt(layer: CameraLayer, f: number): CubicBezierEasing | null {
  let sourceIndex = -1
  for (let i = 0; i < layer.keyframes.length; i++) {
    if (layer.keyframes[i].frame > f) break
    sourceIndex = i
  }
  if (sourceIndex === -1) return null
  const source = layer.keyframes[sourceIndex]
  if (!source.tween || !layer.keyframes[sourceIndex + 1]) return null
  const next = layer.keyframes[sourceIndex + 1]
  if (f >= next.frame) return null
  const mapped = lottieEasingFor(source.tween.easing)
  if (f > source.frame) {
    return splitBezier(mapped, (f - source.frame) / (next.frame - source.frame))
  }
  return mapped
}

/** True when a `smooth` camera segment intersects the export range — the
 * camera then bakes per output frame like smooth node paths. */
function hasSmoothCameraSegment(ctx: Ctx, layer: CameraLayer): boolean {
  for (let i = 0; i < layer.keyframes.length - 1; i++) {
    const source = layer.keyframes[i]
    if (!source.tween || source.tween.path !== 'smooth') continue
    if (source.frame <= ctx.toFrame && layer.keyframes[i + 1].frame >= ctx.fromFrame) return true
  }
  return false
}

function cameraKeys(ctx: Ctx, layer: CameraLayer): NodeKeys {
  const frames = layer.keyframes.map((keyframe) => keyframe.frame)
  if (ctx.holdStep > 1 || hasSmoothCameraSegment(ctx, layer)) {
    const smoothing = ctx.holdStep === 1
    const keyEasing = smoothing ? LINEAR_EASING : null
    const keys: KeySpec[] = [{ t: 0, docFrame: ctx.evalFrames[0], easing: keyEasing }]
    for (let i = 1; i < ctx.frameCount; i++) {
      if (ctx.evalFrames[i] !== ctx.evalFrames[i - 1]) {
        keys.push({ t: i, docFrame: ctx.evalFrames[i], easing: keyEasing })
      }
    }
    if (smoothing) keys[keys.length - 1] = { ...keys[keys.length - 1], easing: null }
    return { keys, successor: null, ip: 0, op: ctx.frameCount }
  }
  const keys: KeySpec[] = [
    { t: 0, docFrame: ctx.fromFrame, easing: cameraEasingAt(layer, ctx.fromFrame) }
  ]
  for (const f of frames) {
    if (f > ctx.fromFrame && f <= ctx.toFrame) {
      keys.push({ t: f - ctx.fromFrame, docFrame: f, easing: cameraEasingAt(layer, f) })
    }
  }
  const lastKey = keys[keys.length - 1]
  const successorFrame =
    lastKey.easing !== null ? (frames.find((f) => f > lastKey.docFrame) ?? null) : null
  return {
    keys,
    successor:
      successorFrame !== null
        ? { t: successorFrame - ctx.fromFrame, docFrame: successorFrame, easing: null }
        : null,
    ip: 0,
    op: ctx.frameCount
  }
}

/** Precomp layer reproducing the camera transform: anchor = camera center,
 * position = stage center, rotation = −camera rotation, scale = zoom × 100 —
 * the exact decomposition of the shared `cameraTransform`. */
function cameraPrecompEntry(ctx: Ctx, layer: CameraLayer, spec: NodeKeys): LottieObject {
  const poseCache = new Map<number, ReturnType<typeof evaluateCameraAtFrame>>()
  const poseAt = (docFrame: number): ReturnType<typeof evaluateCameraAtFrame> => {
    if (!poseCache.has(docFrame)) {
      poseCache.set(docFrame, evaluateCameraAtFrame(ctx.document, docFrame))
    }
    return poseCache.get(docFrame) ?? null
  }
  const anchor = collectChannel(spec, (docFrame) => {
    const pose = poseAt(docFrame)
    return pose ? [pose.center.x, pose.center.y] : null
  })!
  const rotation = collectChannel(spec, (docFrame) => {
    const pose = poseAt(docFrame)
    return pose ? [-pose.rotation] : null
  })!
  const scale = collectChannel(spec, (docFrame) => {
    const pose = poseAt(docFrame)
    return pose ? [pose.zoom * 100, pose.zoom * 100] : null
  })!
  return {
    ddd: 0,
    ty: 0,
    nm: layer.name,
    sr: 1,
    ks: {
      a: anchor,
      p: staticProp([ctx.document.width / 2, ctx.document.height / 2]),
      s: scale,
      r: rotation,
      o: { a: 0, k: 100 }
    },
    ao: 0,
    w: ctx.document.width,
    h: ctx.document.height,
    refId: 'precomp_main',
    ip: 0,
    op: ctx.frameCount,
    st: 0,
    bm: 0
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function buildLottieAnimation(
  document: AnimatorDocument,
  options: LottieBuildOptions,
  deps: LottieBuildDeps
): Promise<LottieBuildResult> {
  const fromFrame = Math.max(0, Math.floor(options.fromFrame))
  const toFrame = Math.max(fromFrame, Math.floor(options.toFrame))
  const frameCount = toFrame - fromFrame + 1
  const holdStep = holdStepOf(document)
  const evalFrames: number[] = []
  for (let i = 0; i < frameCount; i++) {
    const frame = fromFrame + i
    evalFrames.push(holdStep > 1 ? frame - (frame % holdStep) : frame)
  }
  const ctx: Ctx = {
    document,
    fromFrame,
    toFrame,
    frameCount,
    fps: options.fps,
    holdStep,
    evalFrames,
    deps,
    diagnostics: [],
    seenDiagnostics: new Set(),
    imageAssets: [],
    assetIdByResource: new Map(),
    outlineCache: new Map(),
    audioAssets: [],
    audioAssetIdByResource: new Map(),
    audioFiles: new Map()
  }

  const paintOrderEntries: LottieObject[] = []
  for (let i = document.layers.length - 1; i >= 0; i--) {
    const layer = document.layers[i]
    if (!layer.visible || isCameraLayer(layer) || isAudioLayer(layer)) continue
    if (isObjectLayer(layer)) {
      await appendObjectLayerEntries(ctx, layer, paintOrderEntries)
    } else {
      await appendCellEntries(ctx, layer, paintOrderEntries)
    }
  }

  const audioMode: LottieAudioMode = options.audio ?? 'embed'
  const audioLayers: LottieObject[] = []
  for (const layer of document.layers) {
    if (!isAudioLayer(layer) || !layer.visible || layer.startFrame > toFrame) continue
    const refId = await ensureAudioAsset(ctx, layer, audioMode)
    if (refId) audioLayers.push(audioLayerOf(ctx, layer, refId))
  }

  // Lottie layer 0 is the topmost; the paint-order list is bottom-first.
  const contentLayers = paintOrderEntries.reverse()
  for (let i = 0; i < contentLayers.length; i++) contentLayers[i].ind = i + 1

  const camera = cameraLayerOf(document)
  const cameraActive = !!camera && camera.visible && camera.keyframes.length > 0
  let layers = contentLayers
  const assets: LottieObject[] = [...ctx.imageAssets, ...ctx.audioAssets]
  if (cameraActive && camera && contentLayers.length > 0) {
    const spec = cameraKeys(ctx, camera)
    const precomp: LottieObject = { id: 'precomp_main', layers: contentLayers }
    const entry = cameraPrecompEntry(ctx, camera, spec)
    entry.ind = 1
    layers = [entry]
    assets.push(precomp)
  }

  // Audio layers sit below all visuals; nothing paints them either way.
  for (let i = 0; i < audioLayers.length; i++) {
    audioLayers[i].ind = layers.length + i + 1
  }
  layers = [...layers, ...audioLayers]

  const lottie: Record<string, unknown> = {
    v: '5.7.4',
    fr: options.fps,
    ip: 0,
    op: frameCount,
    w: document.width,
    h: document.height,
    nm: document.name,
    ddd: 0,
    assets,
    layers
  }
  return {
    lottie,
    diagnostics: ctx.diagnostics,
    ...(ctx.audioFiles.size > 0 ? { files: Object.fromEntries(ctx.audioFiles) } : {})
  }
}

/** Deterministic UTF-8 serialization of a Lottie animation (pretty-printed,
 * stable key order by construction). */
export function serializeLottie(lottie: Record<string, unknown>): Uint8Array {
  return strToU8(JSON.stringify(lottie, null, 2))
}

/** Packs an animation into a dotLottie archive: `manifest.json`, the
 * animation, plus side files (audio in `'files'` mode) at their recorded
 * paths. */
export function packDotLottie(
  lottie: Record<string, unknown>,
  version?: string,
  files?: Record<string, Uint8Array>
): Uint8Array {
  const manifest = {
    version: '1.0',
    generator: version ? `OpenAnimator ${version}` : 'OpenAnimator',
    animations: [{ id: 'openanimator', loop: true }]
  }
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'animations/animation.json': strToU8(JSON.stringify(lottie, null, 2)),
    ...(files ?? {})
  })
}
