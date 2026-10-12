import { lerp } from './geometry'
import type { Vec2 } from './geometry'
import type { PathAnchor, SceneNode, StrokeStyle } from './model'
import { cloneNode } from './model'
import { cubicBezierPoint } from './motionPath'
import { lerpPaint } from './paint'
import { buildPathData, normalizePathData, pathDataToSubpathAnchors } from './pathModel'

/**
 * Interpolates a node between two keyframe contents matched by id. Every node
 * type lerps transform + opacity; primitives and paths additionally lerp
 * fill, stroke and stroke width (paints through `lerpPaint`: solid↔solid
 * lerps the color, matching gradients lerp geometry and stops, any mismatch
 * snaps). Path geometry morphs between keyframes when both outlines are
 * morph-compatible (`morphPathData`: same subpath count, equal per-subpath
 * anchor counts, equal closed flags) and snaps from `from` otherwise — the
 * historical behavior (see `morphPathData`). Authored
 * stroke-style fields are carried through so they never vanish mid-tween:
 * linecap, linejoin and the dash pattern hold `from`, the dash offset
 * interpolates when both ends define it. Identity fields (id, name, type,
 * resourceId, assetId, children, …) never interpolate — they come from
 * `from`. Nodes whose type differs (or primitives of a different `primitive`
 * kind) snap from `from` to `to` at the ends. When `centerPath` is given the
 * center follows that cubic bezier (smooth motion path) instead of the
 * straight lerp.
 */
/** Carried stroke-style fields of a tweened node: linecap, linejoin and the
 * dash pattern hold `from` (the geometry snap convention); the dash offset
 * interpolates when both ends define it — otherwise the defined end wins,
 * mirroring `strokeWidth`. Absent fields stay absent. */
function strokeStyleTween(from: StrokeStyle, to: Partial<StrokeStyle>, t: number): StrokeStyle {
  const style: StrokeStyle = {}
  if (from.strokeLinecap !== undefined) style.strokeLinecap = from.strokeLinecap
  if (from.strokeLinejoin !== undefined) style.strokeLinejoin = from.strokeLinejoin
  if (from.strokeDasharray !== undefined) style.strokeDasharray = from.strokeDasharray
  const dashoffset =
    from.strokeDashoffset !== undefined && to.strokeDashoffset !== undefined
      ? lerp(from.strokeDashoffset, to.strokeDashoffset, t)
      : (to.strokeDashoffset ?? from.strokeDashoffset)
  if (dashoffset !== undefined) style.strokeDashoffset = dashoffset
  return style
}

/**
 * Morphs two path geometries: compatible outlines have the same subpath
 * count, equal per-subpath anchor counts and equal closed flags; every
 * on-curve point and bezier handle (relative offsets) then lerps linearly. A
 * corner pose's missing handle counts as a zero-length handle at its anchor,
 * so corner↔smooth pairs morph smoothly. Both inputs are re-centered on
 * their own bounding box first (the `PathNode` normalization invariant), so
 * the interpolation carries shape only — the node's center travels
 * separately. Incompatible or unparseable (`A`-arc) geometry returns null;
 * callers keep today's snap behavior. `t === 0`/`t === 1` reproduce the
 * parsed end geometry (within path-data rounding).
 */
export function morphPathData(fromD: string, toD: string, t: number): string | null {
  const from = pathDataToSubpathAnchors(normalizePathData(fromD))
  const to = pathDataToSubpathAnchors(normalizePathData(toD))
  if (!from || !to || from.length !== to.length) return null
  const subpaths: string[] = []
  for (let index = 0; index < from.length; index++) {
    const source = from[index]
    const target = to[index]
    if (source.closed !== target.closed) return null
    if (source.anchors.length !== target.anchors.length) return null
    const anchors: PathAnchor[] = source.anchors.map((anchor, anchorIndex) => {
      const other = target.anchors[anchorIndex]
      const handle = (
        start: { x: number; y: number } | undefined,
        end: { x: number; y: number } | undefined
      ): { x: number; y: number } => {
        const a = start ?? { x: 0, y: 0 }
        const b = end ?? { x: 0, y: 0 }
        return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }
      }
      const inHandle = handle(anchor.in, other.in)
      const outHandle = handle(anchor.out, other.out)
      return {
        x: lerp(anchor.x, other.x, t),
        y: lerp(anchor.y, other.y, t),
        ...(inHandle.x !== 0 || inHandle.y !== 0 ? { in: inHandle } : {}),
        ...(outHandle.x !== 0 || outHandle.y !== 0 ? { out: outHandle } : {})
      }
    })
    subpaths.push(buildPathData(anchors, source.closed))
  }
  return subpaths.join('')
}

export function tweenNode(
  from: SceneNode,
  to: SceneNode,
  t: number,
  centerPath?: { c1: Vec2; c2: Vec2 }
): SceneNode {
  if (from.type !== to.type) {
    return t < 1 ? cloneNode(from) : cloneNode(to)
  }
  const base = {
    id: from.id,
    ...(from.name !== undefined ? { name: from.name } : {}),
    center: centerPath
      ? cubicBezierPoint(from.center, centerPath.c1, centerPath.c2, to.center, t)
      : {
          x: lerp(from.center.x, to.center.x, t),
          y: lerp(from.center.y, to.center.y, t)
        },
    width: lerp(from.width, to.width, t),
    height: lerp(from.height, to.height, t),
    rotation: lerp(from.rotation, to.rotation, t),
    opacity: lerp(from.opacity, to.opacity, t)
  }
  if (from.type === 'image') {
    return {
      ...base,
      type: 'image',
      resourceId: from.resourceId,
      naturalWidth: from.naturalWidth,
      naturalHeight: from.naturalHeight,
      smoothing: from.smoothing
    }
  }
  if (from.type === 'group') {
    // Groups tween as one unit: children are never interpolated.
    return { ...base, type: 'group', children: from.children }
  }
  if (from.type === 'symbol') {
    return { ...base, type: 'symbol', assetId: from.assetId }
  }
  if (from.type === 'path') {
    // Path geometry morphs between compatible outlines; `t === 0` holds the
    // exact `from` data and `t >= 1` the exact target data (the evaluator
    // calls the tween at keyframe frames too, so the ends must stay
    // byte-identical), any incompatible pair snaps from `from` — the
    // historical behavior. The transform carries, fills and strokes
    // interpolate through `lerpPaint` like primitives (both ends defined →
    // lerp, else the defined end wins), and the stroke-style fields hold
    // (dash offset interpolates).
    const target = to.type === 'path' ? to : undefined
    const morphed =
      !target || t <= 0 ? null : t >= 1 ? target.d : morphPathData(from.d, target.d, t)
    return {
      ...base,
      ...strokeStyleTween(from, target ?? {}, t),
      type: 'path',
      d: morphed ?? from.d,
      fill:
        from.fill !== undefined && target?.fill !== undefined
          ? lerpPaint(from.fill, target.fill, t)
          : (from.fill ?? target?.fill),
      stroke:
        from.stroke !== undefined && target?.stroke !== undefined
          ? lerpPaint(from.stroke, target.stroke, t)
          : (from.stroke ?? target?.stroke),
      strokeWidth:
        from.strokeWidth !== undefined && target?.strokeWidth !== undefined
          ? lerp(from.strokeWidth, target.strokeWidth, t)
          : from.strokeWidth
    }
  }
  if (from.type === 'text') {
    // Text content and font identity snap from `from`; the font size (and
    // with it the laid-out box) interpolates.
    return {
      ...base,
      ...strokeStyleTween(from, to.type === 'text' ? to : {}, t),
      type: 'text',
      text: from.text,
      fontFamily: from.fontFamily,
      fontSize: to.type === 'text' ? lerp(from.fontSize, to.fontSize, t) : from.fontSize,
      fontWeight: from.fontWeight,
      fill: from.fill,
      align: from.align
    }
  }
  if (to.type !== 'primitive' || from.primitive !== to.primitive) {
    // Unreachable at runtime (the types were matched above); snapping keeps
    // the interpolation total.
    return t < 1 ? cloneNode(from) : cloneNode(to)
  }
  return {
    ...base,
    ...strokeStyleTween(from, to, t),
    type: 'primitive',
    primitive: from.primitive,
    fill: lerpPaint(from.fill, to.fill, t),
    stroke:
      from.stroke !== undefined && to.stroke !== undefined
        ? lerpPaint(from.stroke, to.stroke, t)
        : (from.stroke ?? to.stroke),
    strokeWidth:
      from.strokeWidth !== undefined && to.strokeWidth !== undefined
        ? lerp(from.strokeWidth, to.strokeWidth, t)
        : (to.strokeWidth ?? from.strokeWidth)
  }
}

/**
 * Interpolates a span of content: every `from` node with an id present in
 * `to` is tweened; nodes only present in `from` hold static. Nodes only
 * present in `to` belong to the next span and are not rendered here.
 */
export function tweenNodes(from: SceneNode[], to: SceneNode[], t: number): SceneNode[] {
  const targets = new Map(to.map((node) => [node.id, node]))
  return from.map((node) => {
    const target = targets.get(node.id)
    return target ? tweenNode(node, target, t) : cloneNode(node)
  })
}
