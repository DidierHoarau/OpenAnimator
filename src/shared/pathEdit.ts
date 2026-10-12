import type { PathAnchor, PathNode } from './model'
import type { Vec2 } from './geometry'
import { buildPathData, normalizePathData, pathDataBounds, pathDataToSubpathAnchors, pathNaturalSize } from './pathModel'

/**
 * Anchor-level path editing: the geometry layer behind the direct-selection
 * tool. Anchors are edited as a subpath tree in the path's local coordinates
 * (the space `d` lives in), then re-committed to the node through
 * `applyAnchorEdit`, which is the single place that re-derives `d`, `center`,
 * `width` and `height` so the node invariants hold (bbox center at the
 * origin, the renderer's `width / natural-size` scale semantics preserved).
 */

export interface Subpath {
  anchors: PathAnchor[]
  closed: boolean
}

interface SegmentEnds {
  fromIndex: number
  toIndex: number
}

interface SegmentHit {
  subpathIndex: number
  segmentIndex: number
  t: number
}

const HANDLE_EPSILON = 1e-9
const CLOSE_EPSILON = 1e-6

/** Parses `d` into an editable subpath tree; null for unparseable data.
 * Zero-length handles are dropped (a `C` whose control point sits on its
 * endpoint is a corner, not a smooth anchor), and closed subpaths in the
 * serializer's canonical form draw the closing segment explicitly before
 * `Z`, which re-parses as a final anchor duplicating the first — the
 * duplicate is merged back into the first anchor (its `in` handle returning
 * there) so parse/serialize round-trips. */
export function parseSubpaths(d: string): Subpath[] | null {
  const subpaths = pathDataToSubpathAnchors(d)
  if (!subpaths) return null
  const cloned = cloneSubpaths(subpaths)
  for (const subpath of cloned) {
    for (const anchor of subpath.anchors) {
      if (anchor.in && isZeroVec(anchor.in)) delete anchor.in
      if (anchor.out && isZeroVec(anchor.out)) delete anchor.out
    }
    if (!subpath.closed || subpath.anchors.length < 3) continue
    const first = subpath.anchors[0]
    const last = subpath.anchors[subpath.anchors.length - 1]
    if (last.out) continue
    if (Math.abs(last.x - first.x) > CLOSE_EPSILON || Math.abs(last.y - first.y) > CLOSE_EPSILON) continue
    if (last.in) first.in = { x: last.in.x, y: last.in.y }
    subpath.anchors.pop()
  }
  return cloned
}

/** Deep copy so callers can snapshot/edit without touching the source. */
export function cloneSubpaths(subpaths: readonly Subpath[]): Subpath[] {
  return subpaths.map((subpath) => ({
    closed: subpath.closed,
    anchors: subpath.anchors.map((anchor) => {
      const copy: PathAnchor = { x: anchor.x, y: anchor.y }
      if (anchor.in) copy.in = { x: anchor.in.x, y: anchor.in.y }
      if (anchor.out) copy.out = { x: anchor.out.x, y: anchor.out.y }
      return copy
    })
  }))
}

/** Serializes subpaths back to path data (subpaths joined with a space). */
export function serializeSubpaths(subpaths: readonly Subpath[]): string {
  return subpaths
    .map((subpath) => buildPathData(subpath.anchors, subpath.closed))
    .filter((d) => d.length > 0)
    .join(' ')
}

/** The node transform a path renders through:
 * `translate(center) rotate(rotation) scale(scale)`, with `scale` following
 * the renderer's `size / natural-size` rule (degenerate axes use 1). */
export interface PathPlacement {
  center: Vec2
  /** Degrees, as stored on the node. */
  rotation: number
  scaleX: number
  scaleY: number
  natural: { width: number; height: number }
}

export function pathPlacement(node: PathNode): PathPlacement {
  const natural = pathNaturalSize(node)
  return {
    center: { x: node.center.x, y: node.center.y },
    rotation: node.rotation,
    scaleX: natural.width === 0 ? 1 : node.width / natural.width,
    scaleY: natural.height === 0 ? 1 : node.height / natural.height,
    natural
  }
}

function rotationRadians(placement: PathPlacement): { cos: number; sin: number } {
  const radians = (placement.rotation * Math.PI) / 180
  return { cos: Math.cos(radians), sin: Math.sin(radians) }
}

/** Local point → stage point through the node placement. */
export function localToStagePoint(placement: PathPlacement, point: Vec2): Vec2 {
  const { cos, sin } = rotationRadians(placement)
  const x = placement.scaleX * point.x
  const y = placement.scaleY * point.y
  return { x: placement.center.x + cos * x - sin * y, y: placement.center.y + sin * x + cos * y }
}

function inverseScale(scale: number): number {
  return scale > 0 && Number.isFinite(scale) ? scale : 1
}

/** Stage point → local point through the inverse placement. */
export function stageToLocalPoint(placement: PathPlacement, point: Vec2): Vec2 {
  const { cos, sin } = rotationRadians(placement)
  const dx = point.x - placement.center.x
  const dy = point.y - placement.center.y
  return {
    x: (cos * dx + sin * dy) / inverseScale(placement.scaleX),
    y: (-sin * dx + cos * dy) / inverseScale(placement.scaleY)
  }
}

/** Stage delta → local delta (ignores `center`, so drag math stays drift-free). */
export function stageDeltaToLocal(placement: PathPlacement, delta: Vec2): Vec2 {
  const { cos, sin } = rotationRadians(placement)
  return {
    x: (cos * delta.x + sin * delta.y) / inverseScale(placement.scaleX),
    y: (-sin * delta.x + cos * delta.y) / inverseScale(placement.scaleY)
  }
}

/** Every anchor of the subpaths mapped through the placement, with handle
 * tips — the input for hit-testing and the overlay. */
export interface StageAnchor {
  subpathIndex: number
  anchorIndex: number
  point: Vec2
  in?: Vec2
  out?: Vec2
}

export function stageAnchorPoints(placement: PathPlacement, subpaths: readonly Subpath[]): StageAnchor[] {
  const result: StageAnchor[] = []
  subpaths.forEach((subpath, subpathIndex) => {
    subpath.anchors.forEach((anchor, anchorIndex) => {
      const entry: StageAnchor = {
        subpathIndex,
        anchorIndex,
        point: localToStagePoint(placement, { x: anchor.x, y: anchor.y })
      }
      if (anchor.in) {
        entry.in = localToStagePoint(placement, { x: anchor.x + anchor.in.x, y: anchor.y + anchor.in.y })
      }
      if (anchor.out) {
        entry.out = localToStagePoint(placement, { x: anchor.x + anchor.out.x, y: anchor.y + anchor.out.y })
      }
      result.push(entry)
    })
  })
  return result
}

/** The anchors a segment index connects. Segments 0..n−2 run anchor i→i+1;
 * a closed subpath gains a wrap segment n−1 (last→first) exactly when the
 * serializer would emit it (more than two anchors). */
function segmentEnds(subpath: Subpath, segmentIndex: number): SegmentEnds | null {
  const count = subpath.anchors.length
  if (segmentIndex < 0) return null
  if (segmentIndex < count - 1) return { fromIndex: segmentIndex, toIndex: segmentIndex + 1 }
  if (subpath.closed && count > 2 && segmentIndex === count - 1) {
    return { fromIndex: count - 1, toIndex: 0 }
  }
  return null
}

/** Number of drawn segments of a subpath. */
function segmentCount(subpath: Subpath): number {
  const count = subpath.anchors.length
  if (count < 2) return 0
  return subpath.closed && count > 2 ? count : count - 1
}

/** Absolute control points of a segment (the same cubics `buildPathData`
 * emits: a straight line unless either endpoint carries a handle). */
function segmentControls(subpath: Subpath, ends: SegmentEnds): { p0: Vec2; c1: Vec2; c2: Vec2; p3: Vec2 } {
  const from = subpath.anchors[ends.fromIndex]
  const to = subpath.anchors[ends.toIndex]
  return {
    p0: { x: from.x, y: from.y },
    c1: from.out ? { x: from.x + from.out.x, y: from.y + from.out.y } : { x: from.x, y: from.y },
    c2: to.in ? { x: to.x + to.in.x, y: to.y + to.in.y } : { x: to.x, y: to.y },
    p3: { x: to.x, y: to.y }
  }
}

function cubicPoint(cubic: { p0: Vec2; c1: Vec2; c2: Vec2; p3: Vec2 }, t: number): Vec2 {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * cubic.p0.x + b * cubic.c1.x + c * cubic.c2.x + d * cubic.p3.x,
    y: a * cubic.p0.y + b * cubic.c1.y + c * cubic.c2.y + d * cubic.p3.y
  }
}

/** Point on a segment at parameter `t` (local coordinates); null for an
 * out-of-range segment index. */
export function segmentPointAt(subpath: Subpath, segmentIndex: number, t: number): Vec2 | null {
  const ends = segmentEnds(subpath, segmentIndex)
  if (!ends) return null
  return cubicPoint(segmentControls(subpath, ends), t)
}

function lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function subtractVec(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y }
}

function negateVec(a: Vec2): Vec2 {
  return { x: -a.x, y: -a.y }
}

function isZeroVec(a: Vec2): boolean {
  return Math.abs(a.x) < HANDLE_EPSILON && Math.abs(a.y) < HANDLE_EPSILON
}

/** Writes a handle offset, deleting it again when it (rounds to) zero. */
function setHandle(anchor: PathAnchor, key: 'in' | 'out', value: Vec2 | null): void {
  if (value && !isZeroVec(value)) anchor[key] = value
  else delete anchor[key]
}

/**
 * Nearest point on any segment to `point` (same coordinate space, local),
 * measured on uniformly sampled interior parameters ("interior" keeps every
 * returned `t` inside (0,1), ready for `insertAnchor`). Null when the
 * subpaths draw nothing.
 */
export function nearestSubpathSegment(
  subpaths: readonly Subpath[],
  point: Vec2,
  samples = 24
): SegmentHit | null {
  let best: (SegmentHit & { distance: number }) | null = null
  for (let subpathIndex = 0; subpathIndex < subpaths.length; subpathIndex++) {
    const subpath = subpaths[subpathIndex]
    const count = segmentCount(subpath)
    for (let segmentIndex = 0; segmentIndex < count; segmentIndex++) {
      for (let step = 1; step < samples; step++) {
        const t = step / samples
        const at = segmentPointAt(subpath, segmentIndex, t)
        if (!at) continue
        const distance = Math.hypot(at.x - point.x, at.y - point.y)
        if (!best || distance < best.distance) best = { subpathIndex, segmentIndex, t, distance }
      }
    }
  }
  return best
    ? { subpathIndex: best.subpathIndex, segmentIndex: best.segmentIndex, t: best.t }
    : null
}

/**
 * Inserts an anchor inside segment `segmentIndex` at parameter `t` (0<t<1).
 * Straight segments get a plain interpolated anchor; curved segments are
 * split with de Casteljau so the two halves reproduce the original curve.
 */
export function insertAnchor(
  subpaths: Subpath[],
  subpathIndex: number,
  segmentIndex: number,
  t: number
): boolean {
  const subpath = subpaths[subpathIndex]
  if (!subpath || !(t > 0 && t < 1)) return false
  const ends = segmentEnds(subpath, segmentIndex)
  if (!ends) return false
  const from = subpath.anchors[ends.fromIndex]
  const to = subpath.anchors[ends.toIndex]
  const insertAt = ends.fromIndex + 1
  if (!from.out && !to.in) {
    subpath.anchors.splice(insertAt, 0, {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t
    })
    return true
  }
  const { p0, c1, c2, p3 } = segmentControls(subpath, ends)
  const q0 = lerpVec(p0, c1, t)
  const q1 = lerpVec(c1, c2, t)
  const q2 = lerpVec(c2, p3, t)
  const r0 = lerpVec(q0, q1, t)
  const r1 = lerpVec(q1, q2, t)
  const mid = lerpVec(r0, r1, t)
  setHandle(from, 'out', subtractVec(q0, p0))
  setHandle(to, 'in', subtractVec(q2, p3))
  const inserted: PathAnchor = { x: mid.x, y: mid.y }
  setHandle(inserted, 'in', subtractVec(r0, mid))
  setHandle(inserted, 'out', subtractVec(r1, mid))
  subpath.anchors.splice(insertAt, 0, inserted)
  return true
}

/** Removes an anchor. Refused for subpaths already down to two anchors (a
 * one-line subpath has no editable geometry left). */
export function removeAnchor(subpaths: Subpath[], subpathIndex: number, anchorIndex: number): boolean {
  const subpath = subpaths[subpathIndex]
  if (!subpath) return false
  if (anchorIndex < 0 || anchorIndex >= subpath.anchors.length) return false
  if (subpath.anchors.length <= 2) return false
  subpath.anchors.splice(anchorIndex, 1)
  return true
}

/**
 * Toggles an anchor between corner (no handles) and smooth (symmetric
 * handles along the neighbor chord). Closed subpaths wrap; open endpoints
 * smooth along their single neighbor; a lone anchor has nothing to smooth
 * against and is refused.
 */
export function toggleSmooth(subpaths: Subpath[], subpathIndex: number, anchorIndex: number): boolean {
  const subpath = subpaths[subpathIndex]
  if (!subpath) return false
  const anchor = subpath.anchors[anchorIndex]
  if (!anchor) return false
  if (anchor.in || anchor.out) {
    delete anchor.in
    delete anchor.out
    return true
  }
  const count = subpath.anchors.length
  const wraps = subpath.closed && count > 2
  const prev = anchorIndex > 0 ? subpath.anchors[anchorIndex - 1] : wraps ? subpath.anchors[count - 1] : undefined
  const next = anchorIndex < count - 1 ? subpath.anchors[anchorIndex + 1] : wraps ? subpath.anchors[0] : undefined
  const tangent: Vec2 | null =
    prev && next
      ? { x: (next.x - prev.x) / 3, y: (next.y - prev.y) / 3 }
      : next
        ? { x: (next.x - anchor.x) / 3, y: (next.y - anchor.y) / 3 }
        : prev
          ? { x: (anchor.x - prev.x) / 3, y: (anchor.y - prev.y) / 3 }
          : null
  if (!tangent) return false
  setHandle(anchor, 'out', tangent)
  setHandle(anchor, 'in', negateVec(tangent))
  return true
}

/** Opens or closes a subpath; closing needs a third anchor to draw a loop. */
export function setSubpathClosed(subpaths: Subpath[], subpathIndex: number, closed: boolean): boolean {
  const subpath = subpaths[subpathIndex]
  if (!subpath) return false
  if (closed && subpath.anchors.length <= 2) return false
  subpath.closed = closed
  return true
}

/**
 * The single geometry-commit point: turns edited subpaths into a new node.
 * The map from the (unedited) local coordinates to the stage is preserved —
 * `d` is re-normalized around the new bbox center, `center` shifts by the
 * same amount through the node transform, the `width / natural` scale ratio
 * is kept, and `width`/`height` follow the new natural size — so anchor
 * edits move exactly the points the user moved and leave the rest of the
 * geometry where it renders. Returns the node unchanged when the subpaths
 * draw nothing.
 */
export function applyAnchorEdit(node: PathNode, subpaths: readonly Subpath[]): PathNode {
  const raw = serializeSubpaths(subpaths)
  if (raw === '') return node
  const bounds = pathDataBounds(raw)
  if (!bounds || (bounds.width <= 0 && bounds.height <= 0)) return node
  const d = normalizePathData(raw)
  const placement = pathPlacement(node)
  const widthRatio = sizeRatio(bounds.width, placement.natural.width, node.width)
  const heightRatio = sizeRatio(bounds.height, placement.natural.height, node.height)
  const rawCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const { cos, sin } = rotationRadians(placement)
  const localX = placement.scaleX * rawCenter.x
  const localY = placement.scaleY * rawCenter.y
  return {
    ...node,
    d,
    center: {
      x: node.center.x + cos * localX - sin * localY,
      y: node.center.y + sin * localX + cos * localY
    },
    width: node.width * widthRatio,
    height: node.height * heightRatio
  }
}

/** New natural size over the old one, mirroring `pathNaturalSize`'s
 * fallback-to-node-size rule for degenerate axes. */
function sizeRatio(newSize: number, oldNatural: number, nodeSize: number): number {
  const oldSize = oldNatural > 0 ? oldNatural : nodeSize
  const nextSize = newSize > 0 ? newSize : nodeSize
  if (!(oldSize > 0) || !(nextSize > 0) || !Number.isFinite(oldSize) || !Number.isFinite(nextSize)) return 1
  return nextSize / oldSize
}
