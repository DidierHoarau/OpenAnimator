import { cameraTransform } from './exportSvg'
import { groupNaturalSize } from './groups'
import type { AnimatorDocument, CameraPose, PathNode, SceneNode, TextNode } from './model'
import { isAudioLayer } from './model'
import type { Paint } from './paint'
import {
  buildPathData,
  normalizePathData,
  parsePathCommands,
  pathDataToSubpathAnchors,
  pathNaturalSize
} from './pathModel'
import { evaluateDocumentAtFrame } from './render'
import { escapeXmlAttribute, paintAttribute } from './renderSvg'
import type { TextOutlineProvider } from './textOutline'

/**
 * Animated-SVG exporter: a CSS-keyframes variant of the static per-frame SVG
 * (`exportSvg.ts`). Values are baked per frame from the shared evaluator, so
 * everything the evaluator supports (tweens, holds, holdStep, camera) is
 * exact when sampled at frame times; between frame samples the `linear`
 * interpolation of the baked values applies. The animation loops by default
 * (GIF-like). Static documents emit a plain `<svg>` with no `<style>` block
 * at all.
 *
 * Path data is the one geometry that animates: a path whose `d` changes
 * across frames becomes a per-frame SMIL `<animate attributeName="d">` child
 * of the `<path>` (interpolated linearly when every sampled frame shares one
 * command signature — the morph-compatible case — and frame-stepped
 * otherwise). Everything else is frozen at the instance's first appearance
 * (gradient paints that change over time keep the first value + diagnostic;
 * text outlines keep the first pose + diagnostic). A text stroke is dropped,
 * since text ships as outlines — fonts are never embedded (licensing).
 * Unsupported content degrades to a dashed placeholder box plus a
 * diagnostic, never a crash.
 */

export interface SvgAnimationOptions {
  fromFrame: number
  toFrame: number
  fps: number
  scale: number
  transparent: boolean
}

export interface SvgAnimationDeps {
  /** Resolves a resource id to an embeddable `data:` URL; null when missing. */
  resolveResourceDataUrl: (resourceId: string) => Promise<string | null>
  /** Outlines text nodes; absent or null result → placeholder box. */
  outlineText?: TextOutlineProvider
}

export interface SvgAnimationResult {
  svg: string
  diagnostics: string[]
}

function fmt(value: number): string {
  const rounded = Math.round(value * 10000) / 10000
  return String(rounded === 0 ? 0 : rounded)
}

function snippet(text: string): string {
  return text.length > 24 ? `${text.slice(0, 24)}…` : text
}

/** Path data re-serialized through the canonical anchor form: a (0,0)-
 * centered bbox, `Z`-closed subpaths collapsed to their anchor list
 * (dropping the explicit closing segment's duplicate anchor) and a uniform
 * explicit closing segment added back on rebuild — so one morphing series
 * shares a single string shape across frames. Null for unparseable data. */
function canonicalPathData(d: string): string | null {
  const subpaths = pathDataToSubpathAnchors(normalizePathData(d))
  if (!subpaths) return null
  const parts: string[] = []
  for (const subpath of subpaths) {
    const anchors = subpath.anchors.slice()
    if (subpath.closed && anchors.length > 2) {
      const first = anchors[0]
      const last = anchors[anchors.length - 1]
      if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) anchors.pop()
    }
    parts.push(buildPathData(anchors, subpath.closed))
  }
  return parts.join('')
}

/** Command-type signature (`MLLCZ`-style): two path strings can interpolate
 * in SMIL exactly when their signatures match. Null for unparseable data. */
function commandSignature(d: string): string | null {
  const commands = parsePathCommands(d)
  if (!commands) return null
  return commands.map((command) => command.type).join('')
}

function cssTransform(x: number, y: number, rotation: number, sx: number, sy: number): string {
  return `translate(${fmt(x)}px, ${fmt(y)}px) rotate(${fmt(rotation)}deg) scale(${fmt(sx)}, ${fmt(sy)})`
}

function attrTransform(x: number, y: number, rotation: number): string {
  return `translate(${fmt(x)} ${fmt(y)}) rotate(${fmt(rotation)})`
}

function attrTransformScale(x: number, y: number, rotation: number, sx: number, sy: number): string {
  return `translate(${fmt(x)} ${fmt(y)}) rotate(${fmt(rotation)}) scale(${fmt(sx)} ${fmt(sy)})`
}

function cssCameraTransform(pose: CameraPose, width: number, height: number): string {
  return (
    `translate(${fmt(width / 2)}px, ${fmt(height / 2)}px)` +
    ` rotate(${fmt(-pose.rotation)}deg)` +
    ` scale(${fmt(pose.zoom)})` +
    ` translate(${fmt(-pose.center.x)}px, ${fmt(-pose.center.y)}px)`
  )
}

/** One animatable property of one DOM element: formatted values per frame
 * (`undefined` = the element is absent at that frame). */
interface Track {
  prop: string
  values: Array<string | undefined>
}

type InstanceKind = 'primitive' | 'path' | 'text' | 'group' | 'image' | 'placeholder'

interface Instance {
  key: string
  parentKey: string | null
  order: number
  kind: InstanceKind
  name: string
  /** False for placeholder instances (missing resource / no font / symbol). */
  drawable: boolean
  pose0: SceneNode
  present: boolean[]
  poses: Array<SceneNode | undefined>
  /** Computed after the walk (text scales need the resolved outline). */
  transform: Array<string | undefined>
  opacity: Array<string | undefined>
  fillValues: Array<Paint | undefined>
  strokeValues: Array<Paint | undefined>
  strokeWidthValues: Array<number | undefined>
  /** Resolved formatted paints (emit prep). */
  fill: Array<string | undefined>
  stroke: Array<string | undefined>
  /** Frozen geometry (first appearance). */
  primitive?: 'rect' | 'ellipse'
  width0: number
  height0: number
  d?: string
  natural0?: { width: number; height: number }
  /** Per-frame `d` series (SMIL) when the path data changes across frames. */
  dMotion?: { calcMode: 'linear' | 'discrete'; values: string[] }
  /** Text instances. */
  textPose?: TextNode
  outlineRequested?: boolean
  outline?: PathNode | null
  /** Image instances. */
  resourceId?: string
  href?: string | null
  smoothing?: boolean
  signedChildren?: string
}

interface OutlineRequest {
  instance: Instance
  pose: TextNode
}

interface WalkState {
  count: number
  diagnostics: string[]
  seen: Set<string>
  defs: Map<string, string>
  instances: Map<string, Instance>
  childrenOf: Map<string, Instance[]>
  roots: Instance[]
  orderCounter: number
  runs: Map<string, { key: string; lastFrame: number; resourceId: string; run: number }>
  outlineRequests: OutlineRequest[]
  outlineCache: Map<string, PathNode | null>
  hrefPromises: Map<string, Promise<string | null>>
}

function report(state: WalkState, message: string): void {
  if (state.seen.has(message)) return
  state.seen.add(message)
  state.diagnostics.push(message)
}

function firstPresentIndex(instance: Instance): number {
  return instance.present.indexOf(true)
}

function ensureInstance(
  state: WalkState,
  key: string,
  parentKey: string | null,
  node: SceneNode,
  layerName: string
): Instance {
  const existing = state.instances.get(key)
  if (existing) return existing
  const fillValues: Array<Paint | undefined> = new Array(state.count).fill(undefined)
  const instance: Instance = {
    key,
    parentKey,
    order: state.orderCounter++,
    kind: node.type === 'symbol' ? 'placeholder' : node.type,
    name: node.name ?? layerName,
    drawable: node.type !== 'symbol',
    pose0: node,
    present: new Array(state.count).fill(false),
    poses: new Array(state.count).fill(undefined),
    transform: new Array(state.count).fill(undefined),
    opacity: new Array(state.count).fill(undefined),
    fillValues,
    strokeValues: new Array(state.count).fill(undefined),
    strokeWidthValues: new Array(state.count).fill(undefined),
    fill: [],
    stroke: [],
    width0: node.width,
    height0: node.height
  }
  state.instances.set(key, instance)
  if (parentKey === null) {
    state.roots.push(instance)
  } else {
    const siblings = state.childrenOf.get(parentKey)
    if (siblings) siblings.push(instance)
    else state.childrenOf.set(parentKey, [instance])
  }
  if (node.type === 'primitive') {
    instance.primitive = node.primitive
  } else if (node.type === 'path') {
    instance.d = node.d
    instance.natural0 = pathNaturalSize(node)
  } else if (node.type === 'image') {
    instance.resourceId = node.resourceId
    instance.smoothing = node.smoothing
  } else if (node.type === 'text') {
    instance.textPose = node
  }
  return instance
}

function recordFrame(state: WalkState, instance: Instance, frameIndex: number, node: SceneNode): void {
  instance.present[frameIndex] = true
  instance.poses[frameIndex] = node
  instance.opacity[frameIndex] = fmt(node.opacity)
  if (node.type === 'primitive') {
    instance.fillValues[frameIndex] = node.fill
    instance.strokeValues[frameIndex] = node.stroke
    instance.strokeWidthValues[frameIndex] = node.stroke === undefined ? 0 : node.strokeWidth ?? 1
  } else if (node.type === 'path') {
    instance.fillValues[frameIndex] = node.fill
    instance.strokeValues[frameIndex] = node.stroke
    instance.strokeWidthValues[frameIndex] = node.stroke === undefined ? 0 : node.strokeWidth ?? 1
  } else if (node.type === 'text') {
    instance.fillValues[frameIndex] = node.fill
    const pose = instance.textPose
    if (
      pose &&
      (node.text !== pose.text ||
        node.fontFamily !== pose.fontFamily ||
        node.fontWeight !== pose.fontWeight ||
        node.fontSize !== pose.fontSize)
    ) {
      report(state, `Text "${snippet(pose.text)}" changes across frames; the animated SVG keeps the first outline.`)
    }
    if (!instance.outlineRequested) {
      instance.outlineRequested = true
      if (node.stroke !== undefined) {
        report(state, 'A text stroke is dropped when text is exported as outlines in the animated SVG.')
      }
      state.outlineRequests.push({ instance, pose: node })
    }
  } else if (node.type === 'group') {
    const signature = node.children.map((child) => child.id).join(',')
    if (instance.signedChildren === undefined) {
      instance.signedChildren = signature
    } else if (instance.signedChildren !== signature) {
      const sorted = (value: string): string => value.split(',').sort().join(',')
      if (sorted(instance.signedChildren) === sorted(signature)) {
        report(
          state,
          `The paint order of "${instance.name}" changes across frames; the animated SVG keeps the first order.`
        )
      }
    }
  }
}

function walkNodes(
  state: WalkState,
  layerKey: string,
  layerName: string,
  nodes: SceneNode[],
  parentKey: string | null,
  frameIndex: number
): void {
  for (const node of nodes) {
    const baseKey = `${layerKey}/${node.id}`
    let key = baseKey
    if (node.type === 'image') {
      const current = state.runs.get(baseKey)
      if (current && current.lastFrame === frameIndex - 1 && current.resourceId === node.resourceId) {
        current.lastFrame = frameIndex
        key = current.key
      } else {
        const run = current ? current.run + 1 : 0
        key = `${baseKey}~${run}`
        state.runs.set(baseKey, { key, lastFrame: frameIndex, resourceId: node.resourceId, run })
      }
    }
    const instance = ensureInstance(state, key, parentKey, node, layerName)
    if (node.type !== 'symbol' && node.type !== 'image' && node.type !== instance.kind) {
      report(
        state,
        `"${instance.name}" changes its object type across frames; the animated SVG keeps the first appearance.`
      )
      continue
    }
    recordFrame(state, instance, frameIndex, node)
    if (node.type === 'group') {
      walkNodes(state, layerKey, layerName, node.children, key, frameIndex)
    }
  }
}

/** Per-kind transform of one frame: elements are emitted once with geometry
 * frozen at their first appearance, so size changes fold into the scale.
 * Groups and paths follow the renderSvg placed/natural convention; outlined
 * text scales by the outline's own placed/natural ratio. */
function transformAt(instance: Instance, node: SceneNode): string {
  if (instance.kind === 'group' && node.type === 'group') {
    const natural = groupNaturalSize(node.children)
    const sx = natural.width === 0 ? 1 : node.width / natural.width
    const sy = natural.height === 0 ? 1 : node.height / natural.height
    return cssTransform(node.center.x, node.center.y, node.rotation, sx, sy)
  }
  if (instance.kind === 'path' && node.type === 'path') {
    // The path's own `d` animates per frame, so the scale is rebased on the
    // drawn geometry's natural size every frame (the live renderer rule).
    const natural = pathNaturalSize(node)
    const sx = natural.width === 0 ? 1 : node.width / natural.width
    const sy = natural.height === 0 ? 1 : node.height / natural.height
    return cssTransform(node.center.x, node.center.y, node.rotation, sx, sy)
  }
  if (instance.kind === 'text' && instance.drawable && instance.outline) {
    const natural = pathNaturalSize(instance.outline)
    const sx = natural.width === 0 ? 1 : instance.outline.width / natural.width
    const sy = natural.height === 0 ? 1 : instance.outline.height / natural.height
    return cssTransform(node.center.x, node.center.y, node.rotation, sx, sy)
  }
  const sx = instance.width0 === 0 ? 1 : node.width / instance.width0
  const sy = instance.height0 === 0 ? 1 : node.height / instance.height0
  return cssTransform(node.center.x, node.center.y, node.rotation, sx, sy)
}

function computeTransforms(state: WalkState): void {
  for (const instance of state.instances.values()) {
    for (let i = 0; i < state.count; i++) {
      const pose = instance.poses[i]
      if (pose) instance.transform[i] = transformAt(instance, pose)
    }
  }
}

async function resolveOutlines(state: WalkState, outlineText: TextOutlineProvider | undefined): Promise<void> {
  for (const request of state.outlineRequests) {
    const pose = request.pose
    const cacheKey = JSON.stringify([pose.text, pose.fontFamily, pose.fontWeight, pose.fontSize])
    let outline: PathNode | null = null
    if (outlineText) {
      if (state.outlineCache.has(cacheKey)) {
        outline = state.outlineCache.get(cacheKey) ?? null
      } else {
        outline = await outlineText(pose)
        state.outlineCache.set(cacheKey, outline)
      }
    }
    request.instance.outline = outline
  }
}

async function resolveHrefs(state: WalkState, resolveResourceDataUrl: (resourceId: string) => Promise<string | null>): Promise<void> {
  for (const instance of state.instances.values()) {
    if (instance.kind !== 'image' || !instance.resourceId) continue
    let promise = state.hrefPromises.get(instance.resourceId)
    if (!promise) {
      promise = Promise.resolve(resolveResourceDataUrl(instance.resourceId))
      state.hrefPromises.set(instance.resourceId, promise)
    }
    instance.href = await promise
    if (!instance.href) {
      instance.drawable = false
      report(state, `The resource of "${instance.name}" is missing; a placeholder box is shown in the animated SVG.`)
    }
  }
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

interface EmitContext {
  state: WalkState
  count: number
  fps: number
  styleRules: string[]
  idCounter: number
}

function reportPaintChanges(state: WalkState, instance: Instance, values: Array<Paint | undefined>): void {
  if (!values.some((value) => value !== undefined && typeof value !== 'string')) return
  const serialized = new Set(
    values
      .filter((value) => value !== undefined)
      .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
  )
  if (serialized.size > 1) {
    report(state, `A gradient paint in "${instance.name}" changes over time; the animated SVG keeps its first appearance.`)
  }
}

/** Resolves one raw paint channel to per-frame attribute strings, keeping
 * gradient paints frozen at the instance's first appearance. */
function resolvePaintValues(
  ctx: EmitContext,
  instance: Instance,
  values: Array<Paint | undefined>
): Array<string | undefined> {
  reportPaintChanges(ctx.state, instance, values)
  const firstIndex = firstPresentIndex(instance)
  const freeze = values.some((value) => value !== undefined && typeof value !== 'string')
  const frozen = freeze && firstIndex !== -1 ? values[firstIndex] : undefined
  return values.map((value, i) => {
    if (!instance.present[i]) return undefined
    const paint = freeze ? frozen ?? 'none' : value ?? 'none'
    return paintAttribute(paint, ctx.state.defs)
  })
}

function preparePaints(ctx: EmitContext): void {
  for (const instance of ctx.state.instances.values()) {
    if (instance.kind === 'text' && !instance.drawable) continue
    if (instance.kind === 'primitive' || instance.kind === 'path') {
      instance.fill = resolvePaintValues(ctx, instance, instance.fillValues)
      instance.stroke = resolvePaintValues(ctx, instance, instance.strokeValues)
    } else if (instance.kind === 'text') {
      instance.fill = resolvePaintValues(ctx, instance, instance.fillValues)
    }
  }
}

/** Builds the per-frame `d` SMIL series of path instances whose geometry
 * changes across the export: canonical strings interpolated linearly when
 * every sampled frame shares one command signature (the morph-compatible
 * case), the exact per-frame evaluator strings shown frame-stepped
 * (discrete) otherwise. Absent frames inherit the previous value. */
function preparePathData(ctx: EmitContext): void {
  for (const instance of ctx.state.instances.values()) {
    if (instance.kind !== 'path') continue
    const series: Array<string | undefined> = new Array(ctx.count).fill(undefined)
    for (let i = 0; i < ctx.count; i++) {
      const pose = instance.poses[i]
      if (pose && pose.type === 'path') series[i] = pose.d
    }
    const defined = series.filter((value): value is string => value !== undefined)
    if (new Set(defined).size <= 1) continue
    const canonical = series.map((value) => (value === undefined ? null : canonicalPathData(value)))
    let linear = true
    let reference: string | null = null
    for (let i = 0; i < ctx.count; i++) {
      if (series[i] === undefined) continue
      const signature = canonical[i] === null ? null : commandSignature(canonical[i]!)
      if (signature === null || (reference !== null && signature !== reference)) {
        linear = false
        break
      }
      reference = signature
    }
    const values: string[] = []
    let last = defined[0]
    for (let i = 0; i < ctx.count; i++) {
      const value = linear ? canonical[i] : series[i]
      if (value !== undefined && value !== null) last = value
      values.push(last)
    }
    instance.dMotion = { calcMode: linear ? 'linear' : 'discrete', values }
  }
}

const CSS_PROPS = new Set(['transform', 'opacity', 'visibility', 'fill', 'stroke', 'stroke-width'])

interface Animation {
  index: number
  animatedProps: string[]
  keyframes: string
}

function animationFor(ctx: EmitContext, tracks: Track[]): Animation | null {
  const varies = (track: Track): boolean => {
    const defined = track.values.filter((value) => value !== undefined)
    if (track.prop === 'visibility') return defined.includes('hidden')
    return new Set(defined).size > 1
  }
  const active = tracks.filter((track) => varies(track) && CSS_PROPS.has(track.prop))
  if (active.length === 0) return null
  const points = new Set<number>()
  for (const track of active) {
    let previous: string | undefined
    for (let i = 0; i < ctx.count; i++) {
      const value = track.values[i]
      if (value === undefined) continue
      if (value !== previous) points.add(i)
      previous = value
    }
  }
  const frames: string[] = []
  for (const index of [...points].sort((a, b) => a - b)) {
    const declarations: string[] = []
    for (const track of active) {
      const value = track.values[index]
      if (value !== undefined) declarations.push(`${track.prop}:${value}`)
    }
    if (declarations.length > 0) {
      frames.push(`${fmt((index / ctx.count) * 100)}%{${declarations.join(';')}}`)
    }
  }
  const finalDeclarations: string[] = []
  for (const track of active) {
    const defined = track.values.filter((value) => value !== undefined)
    finalDeclarations.push(`${track.prop}:${defined[defined.length - 1]}`)
  }
  frames.push(`100%{${finalDeclarations.join(';')}}`)
  ctx.idCounter += 1
  return { index: ctx.idCounter, animatedProps: active.map((track) => track.prop), keyframes: frames.join('') }
}

/** Registers the animation's style rule + keyframes and returns the element id. */
function elementIdAndRule(ctx: EmitContext, animation: Animation): string {
  const id = `oa-i-${animation.index}`
  let rule = `#${id}{animation:oa-k-${animation.index} ${fmt(ctx.count / ctx.fps)}s linear infinite`
  if (animation.animatedProps.includes('transform')) {
    rule += ';transform-box:view-box;transform-origin:0 0'
  }
  rule += '}'
  ctx.styleRules.push(rule)
  ctx.styleRules.push(`@keyframes oa-k-${animation.index}{${animation.keyframes}}`)
  return id
}

function outerTracks(instance: Instance): Track[] {
  return [
    { prop: 'transform', values: instance.transform },
    { prop: 'opacity', values: instance.opacity },
    { prop: 'visibility', values: instance.present.map((present) => (present ? 'visible' : 'hidden')) }
  ]
}

function paintTracks(instance: Instance): Track[] {
  const tracks: Track[] = [
    { prop: 'fill', values: instance.fill },
    { prop: 'stroke', values: instance.stroke },
    {
      prop: 'stroke-width',
      values: instance.strokeWidthValues.map((value) => (value === undefined ? undefined : fmt(value)))
    }
  ]
  return tracks
}

/** SVG-attribute transform fallback of an element (the first-appearance
 * state; the CSS keyframes take over while the animation runs). */
function fallbackTransform(instance: Instance): string {
  const pose = instance.pose0
  if (instance.kind === 'group' && pose.type === 'group') {
    const natural = groupNaturalSize(pose.children)
    const sx = natural.width === 0 ? 1 : pose.width / natural.width
    const sy = natural.height === 0 ? 1 : pose.height / natural.height
    return attrTransformScale(pose.center.x, pose.center.y, pose.rotation, sx, sy)
  }
  if (instance.kind === 'path' && instance.natural0) {
    const sx = instance.natural0.width === 0 ? 1 : pose.width / instance.natural0.width
    const sy = instance.natural0.height === 0 ? 1 : pose.height / instance.natural0.height
    return attrTransformScale(pose.center.x, pose.center.y, pose.rotation, sx, sy)
  }
  if (instance.kind === 'text' && instance.drawable && instance.outline) {
    const natural = pathNaturalSize(instance.outline)
    const sx = natural.width === 0 ? 1 : instance.outline.width / natural.width
    const sy = natural.height === 0 ? 1 : instance.outline.height / natural.height
    return attrTransformScale(pose.center.x, pose.center.y, pose.rotation, sx, sy)
  }
  return attrTransform(pose.center.x, pose.center.y, pose.rotation)
}

function attr(name: string, value: string | number): string {
  return ` ${name}="${escapeXmlAttribute(String(value))}"`
}

/** Animates one element's tracks when any of them varies; returns the
 * element id to place on the markup, or null for fully static elements. */
function animateElement(ctx: EmitContext, tracks: Track[]): string | null {
  const animation = animationFor(ctx, tracks)
  return animation ? elementIdAndRule(ctx, animation) : null
}

function emitPrimitive(ctx: EmitContext, instance: Instance): string {
  const id = animateElement(ctx, [...outerTracks(instance), ...paintTracks(instance)])
  const fallback = fallbackTransform(instance)
  let markup =
    instance.primitive === 'ellipse'
      ? `<ellipse${attr('rx', fmt(instance.width0 / 2))}${attr('ry', fmt(instance.height0 / 2))}`
      : `<rect${attr('x', fmt(-instance.width0 / 2))}${attr('y', fmt(-instance.height0 / 2))}` +
        `${attr('width', fmt(instance.width0))}${attr('height', fmt(instance.height0))}`
  const first = firstPresentIndex(instance)
  markup += attr('fill', instance.fill[first] ?? 'none')
  const stroke = instance.stroke[first]
  if (stroke !== undefined && stroke !== 'none') {
    markup += attr('stroke', stroke)
    const width = instance.strokeWidthValues[first]
    if (width !== undefined && width !== 0) markup += attr('stroke-width', fmt(width))
  }
  markup +=
    attr('transform', fallback) + attr('opacity', instance.opacity[first] ?? '1') + (id ? attr('id', id) : '')
  return `${markup}/>`
}

function emitPathLike(ctx: EmitContext, instance: Instance, d: string, withStroke: boolean): string {
  const outerId = animateElement(ctx, outerTracks(instance))
  const innerTracks: Track[] = withStroke ? paintTracks(instance) : [{ prop: 'fill', values: instance.fill }]
  const innerId = animateElement(ctx, innerTracks)
  const first = firstPresentIndex(instance)
  let markup =
    `<g${attr('transform', fallbackTransform(instance))}` +
    attr('opacity', instance.opacity[first] ?? '1') +
    (outerId ? attr('id', outerId) : '') +
    `><path${attr('d', d)}`
  markup += attr('fill', instance.fill[first] ?? 'none')
  if (withStroke) {
    const stroke = instance.stroke[first]
    if (stroke !== undefined && stroke !== 'none') {
      markup += attr('stroke', stroke)
      const width = instance.strokeWidthValues[first]
      if (width !== undefined && width !== 0) markup += attr('stroke-width', fmt(width))
    }
  }
  if (instance.dMotion) {
    markup +=
      `<animate${attr('attributeName', 'd')}${attr('dur', `${fmt(ctx.count / ctx.fps)}s`)}` +
      `${attr('repeatCount', 'indefinite')}${attr('calcMode', instance.dMotion.calcMode)}` +
      `${attr('values', instance.dMotion.values.join(';'))}/>`
  }
  if (innerId) markup += attr('id', innerId)
  return `${markup}/></g>`
}

function emitGroupBody(ctx: EmitContext, instance: Instance, children: string): string {
  const id = animateElement(ctx, outerTracks(instance))
  const first = firstPresentIndex(instance)
  return (
    `<g${attr('transform', fallbackTransform(instance))}` +
    attr('opacity', instance.opacity[first] ?? '1') +
    (id ? attr('id', id) : '') +
    `>${children}</g>`
  )
}

function emitPlaceholder(ctx: EmitContext, instance: Instance): string {
  const id = animateElement(ctx, outerTracks(instance))
  const first = firstPresentIndex(instance)
  return (
    `<rect${attr('x', fmt(-instance.width0 / 2))}${attr('y', fmt(-instance.height0 / 2))}` +
    `${attr('width', fmt(instance.width0))}${attr('height', fmt(instance.height0))}` +
    attr('fill', 'none') +
    attr('stroke', '#94a3b8') +
    attr('stroke-dasharray', '4 4') +
    attr('transform', fallbackTransform(instance)) +
    attr('opacity', instance.opacity[first] ?? '1') +
    (id ? attr('id', id) : '') +
    '/>'
  )
}

function emitImage(ctx: EmitContext, instance: Instance): string {
  if (!instance.drawable || !instance.href) return emitPlaceholder(ctx, instance)
  const id = animateElement(ctx, outerTracks(instance))
  const first = firstPresentIndex(instance)
  let markup =
    `<image${attr('href', instance.href)}` +
    attr('x', fmt(-instance.width0 / 2)) +
    attr('y', fmt(-instance.height0 / 2)) +
    attr('width', fmt(instance.width0)) +
    attr('height', fmt(instance.height0)) +
    attr('preserveAspectRatio', 'none')
  if (!instance.smoothing) markup += attr('style', 'image-rendering: pixelated')
  markup +=
    attr('transform', fallbackTransform(instance)) +
    attr('opacity', instance.opacity[first] ?? '1') +
    (id ? attr('id', id) : '')
  return `${markup}/>`
}

function emitInstance(ctx: EmitContext, instance: Instance): string {
  const children = (ctx.state.childrenOf.get(instance.key) ?? [])
    .map((child) => emitInstance(ctx, child))
    .join('')
  switch (instance.kind) {
    case 'group':
      return emitGroupBody(ctx, instance, children)
    case 'primitive':
      return emitPrimitive(ctx, instance)
    case 'path':
      return emitPathLike(ctx, instance, instance.d ?? '', true)
    case 'text':
      return instance.drawable && instance.outline
        ? emitPathLike(ctx, instance, instance.outline.d, false)
        : emitPlaceholder(ctx, instance)
    case 'image':
      return emitImage(ctx, instance)
    case 'placeholder':
      return emitPlaceholder(ctx, instance)
  }
}

function emitCamera(ctx: EmitContext, document: AnimatorDocument, body: string, cameraTrack: Array<CameraPose | null>): string {
  if (body === '') return body
  const defined = cameraTrack
    .map((pose, index) => ({ pose, index }))
    .filter((entry): entry is { pose: CameraPose; index: number } => entry.pose !== null)
  if (defined.length === 0) return body
  const values: Array<string | undefined> = new Array(ctx.count).fill(undefined)
  for (let i = 0; i < ctx.count; i++) {
    let pose = cameraTrack[i]
    if (!pose) {
      const previous = defined.filter((entry) => entry.index < i).pop()
      pose = previous ? previous.pose : defined[0].pose
    }
    values[i] = cssCameraTransform(pose, document.width, document.height)
  }
  const animation = animationFor(ctx, [{ prop: 'transform', values }])
  if (!animation) {
    return `<g${attr('transform', cameraTransform(defined[0].pose, document.width, document.height))}>${body}</g>`
  }
  const id = elementIdAndRule(ctx, animation)
  return `<g${attr('id', id)}${attr('transform', cameraTransform(defined[0].pose, document.width, document.height))}>${body}</g>`
}

export async function exportAnimatedSvg(
  document: AnimatorDocument,
  options: SvgAnimationOptions,
  deps: SvgAnimationDeps
): Promise<SvgAnimationResult> {
  const fromFrame = Math.max(0, Math.floor(options.fromFrame))
  const toFrame = Math.max(fromFrame, Math.floor(options.toFrame))
  const count = toFrame - fromFrame + 1
  const scale = options.scale > 0 ? options.scale : 1

  const state: WalkState = {
    count,
    diagnostics: [],
    seen: new Set(),
    defs: new Map(),
    instances: new Map(),
    childrenOf: new Map(),
    roots: [],
    orderCounter: 0,
    runs: new Map(),
    outlineRequests: [],
    outlineCache: new Map(),
    hrefPromises: new Map()
  }

  const cameraTrack: Array<CameraPose | null> = new Array(count).fill(null)
  for (let i = 0; i < count; i++) {
    const evaluated = evaluateDocumentAtFrame(document, fromFrame + i)
    cameraTrack[i] = evaluated.camera
    for (const layer of evaluated.layers) {
      walkNodes(state, layer.layerId, layer.name, layer.nodes, null, i)
    }
  }

  for (const layer of document.layers) {
    if (isAudioLayer(layer) && layer.visible && layer.startFrame <= toFrame) {
      report(state, 'Audio is not included in animated SVG exports; the exported animation is silent.')
      break
    }
  }

  await resolveOutlines(state, deps.outlineText)
  await resolveHrefs(state, deps.resolveResourceDataUrl)

  for (const instance of state.instances.values()) {
    if (instance.kind === 'text' && instance.drawable && !instance.outline && instance.textPose) {
      instance.drawable = false
      report(
        state,
        `No font could be loaded for "${instance.textPose.fontFamily}"; a placeholder box replaces "${snippet(instance.textPose.text)}" in the animated SVG.`
      )
    }
  }

  computeTransforms(state)

  const ctx: EmitContext = {
    state,
    count,
    fps: options.fps,
    styleRules: [],
    idCounter: 0
  }
  preparePaints(ctx)
  preparePathData(ctx)

  const body = state.roots.map((instance) => emitInstance(ctx, instance)).join('')
  const camera = emitCamera(ctx, document, body, cameraTrack)
  const styleBlock = ctx.styleRules.length > 0 ? `<style>${ctx.styleRules.join('')}</style>` : ''
  const defsBlock = state.defs.size > 0 ? `<defs>${[...state.defs.values()].join('')}</defs>` : ''
  const backdrop = options.transparent
    ? ''
    : `<rect x="0" y="0" width="${document.width}" height="${document.height}" fill="${document.background}"/>`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(document.width * scale)}" height="${fmt(document.height * scale)}"` +
    ` viewBox="0 0 ${document.width} ${document.height}">` +
    styleBlock +
    defsBlock +
    backdrop +
    camera +
    '</svg>'
  return { svg, diagnostics: state.diagnostics }
}
