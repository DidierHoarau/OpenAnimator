import type { Vec2 } from './geometry'
import type { Easing } from './easing'
import type { Paint } from './paint'

export type PrimitiveKind = 'rect' | 'ellipse'

/** Maximum number of entries in a stroke dash pattern. */
export const MAX_STROKE_DASH_VALUES = 16

export type StrokeLinecap = 'butt' | 'round' | 'square'
export type StrokeLinejoin = 'miter' | 'round' | 'bevel'

/** SVG stroke-style vocabulary shared by every stroked node kind (primitive,
 * path, text). Absent fields keep the SVG defaults the renderer historically
 * relied on, so pre-v8 documents render byte-identically. Edited in the
 * properties panel's stroke sections; emitted only when `stroke` is set. */
export interface StrokeStyle {
  /** Shape of dash segment ends. Absent ≡ SVG default (`'butt'`). */
  strokeLinecap?: StrokeLinecap
  /** Shape of stroke corners. Absent ≡ SVG default (`'miter'`). */
  strokeLinejoin?: StrokeLinejoin
  /** Dash pattern in stage pixels: 1–`MAX_STROKE_DASH_VALUES` finite values
   * ≥ 0, not all zero; serialized space-joined. Absent ≡ solid stroke. */
  strokeDasharray?: number[]
  /** Phase offset into the dash pattern in stage pixels. Absent ≡ 0. */
  strokeDashoffset?: number
}

/** Transform vocabulary shared by every node type. */
export interface NodeBase {
  id: string
  /** Display name shown in the timeline tree; falls back to the kind label. */
  name?: string
  /** Stage coordinates of the node's origin (its content bbox center). */
  center: Vec2
  /** Placed size — scale is folded into width/height. */
  width: number
  height: number
  /** Rotation in degrees around the node center. */
  rotation: number
  /** 0..1 */
  opacity: number
}

export interface PrimitiveNode extends NodeBase, StrokeStyle {
  type: 'primitive'
  primitive: PrimitiveKind
  fill: Paint
  stroke?: Paint
  strokeWidth?: number
}

/** Placed image; populated by the image-import phase. */
export interface ImageNode extends NodeBase {
  type: 'image'
  resourceId: string
  naturalWidth: number
  naturalHeight: number
  smoothing: boolean
}

/** Group of nodes stored in group-local coordinates (origin = group center). */
export interface GroupNode extends NodeBase {
  type: 'group'
  children: SceneNode[]
}

/** Symbol instance; populated by the asset-library phase. */
export interface SymbolNode extends NodeBase {
  type: 'symbol'
  assetId: string
}

/**
 * Vector path: `d` is SVG path data in node-local coordinates, normalized so
 * its bounding-box center sits at (0,0). The placed size (`width`/`height`)
 * maps that natural bbox to the stage — scale is folded into the transform,
 * never re-encoded into `d`. Multiple subpaths (e.g. glyph outlines) are
 * allowed; the direct-selection tool edits them subpath by subpath (never
 * merging subpaths).
 */
export interface PathNode extends NodeBase, StrokeStyle {
  type: 'path'
  d: string
  fill?: Paint
  stroke?: Paint
  strokeWidth?: number
}

/** One pen anchor: on-curve point plus optional bezier handles (relative to
 * the point). The editing view of a `PathNode`'s `d`. */
export interface PathAnchor {
  x: number
  y: number
  /** Handle controlling the incoming curve. */
  in?: { x: number; y: number }
  /** Handle controlling the outgoing curve. */
  out?: { x: number; y: number }
}

/** Rendered text block laid out as explicit lines (`\n`); `width`/`height`
 * are the measured layout box, refreshed whenever text or font changes. */
export interface TextNode extends NodeBase, StrokeStyle {
  type: 'text'
  text: string
  fontFamily: string
  fontSize: number
  fontWeight: number
  fill: Paint
  align: 'left' | 'center' | 'right'
  /** Extra advance between characters in stage pixels. Absent ≡ 0. */
  letterSpacing?: number
  /** Line advance as a multiple of `fontSize`. Absent ≡ `TEXT_LINE_HEIGHT`. */
  lineHeight?: number
  /** Text outline paint; drawn in addition to `fill`. Absent ≡ no outline. */
  stroke?: Paint
  /** Outline width in stage pixels; only meaningful with `stroke` set. */
  strokeWidth?: number
  /** Vertical placement of the layout box inside the node's `height`.
   * Absent ≡ `'top'` (the legacy baseline math). */
  verticalAlign?: 'top' | 'middle' | 'bottom'
  /** Additional font families tried (in order) when `fontFamily` is missing.
   * At most 8 entries. */
  fontFallback?: string[]
}

export type SceneNode = PrimitiveNode | PathNode | TextNode | ImageNode | GroupNode | SymbolNode

/** Reusable artwork: a symbol (group content) or an image (resource reference). */
export interface Asset {
  id: string
  name: string
  kind: 'symbol' | 'image'
  /** Symbol: artwork in local coordinates, origin = content bbox center. */
  content?: GroupNode
  /** Image: content-addressed resource id. */
  resourceId?: string
  naturalWidth?: number
  naturalHeight?: number
  createdAt: number
}

/** Tween channels of a whole-pose keyframe tween: the transform track
 * (position/size/rotation/scale/path geometry), `opacity` and `fill` paint.
 * Stroke paint and stroke fields always follow the base easing. */
export type TweenChannel = 'transform' | 'opacity' | 'fill'

/** Classic tween attached to a keyframe: interpolates toward the next keyframe. */
export interface KeyframeTween {
  easing: Easing
  /**
   * Per-channel easing overrides, applied on top of the whole-pose model:
   * an absent channel follows the base `easing`, so documents without
   * overrides (and pre-v9 documents) render identically. The channel
   * progress is the base easing evaluated first, then the override.
   */
  easings?: Partial<Record<TweenChannel, Easing>>
  /**
   * Spatial behavior of the tweened center. Absent ≡ `'linear'` (the center
   * lerps straight toward the target); `'smooth'` follows a Catmull-Rom
   * derived bezier through the node's neighbouring keyframe centers.
   */
  path?: 'linear' | 'smooth'
}

/** A keyframe holds layer content starting at its `frame` until the next keyframe. */
export interface Keyframe {
  frame: number
  nodes: SceneNode[]
  tween?: KeyframeTween
}

export interface LayerBase {
  id: string
  name: string
  visible: boolean
  locked: boolean
}

/** Pose/tween layer: content is a tree of tweenable SceneNodes. */
export interface ObjectLayer extends LayerBase {
  kind: 'object'
  /** Keyframes sorted by ascending `frame`. */
  keyframes: Keyframe[]
}

/** One raster cell of a drawing layer: a PNG resource holding from its
 * `frame` until the next cell; after the last cell the layer is blank. */
export interface DrawingCell {
  frame: number
  resourceId: string
}

/** Flipbook layer: one raster cell per frame span, never tweened. */
export interface DrawingLayer extends LayerBase {
  kind: 'drawing'
  /** Cell buffers are `stage size × resolutionScale` pixels (default 1). */
  resolutionScale: number
  /** Cells sorted by ascending `frame`; a cell holds until the next one. */
  cells: DrawingCell[]
}

/** View transform applied to the whole document at render time. */
export interface CameraPose {
  /** Stage point shown at the center of the frame. */
  center: Vec2
  /** Magnification; must be > 0. */
  zoom: number
  /** Rotation in degrees. */
  rotation: number
}

/** A camera keyframe holds its pose starting at `frame` until the next one. */
export interface CameraKeyframe {
  frame: number
  pose: CameraPose
  tween?: KeyframeTween
}

/** View layer: keyframed pan/zoom/rotation; at most one per document. */
export interface CameraLayer extends LayerBase {
  kind: 'camera'
  /** Keyframes sorted by ascending `frame`. */
  keyframes: CameraKeyframe[]
}

/** Soundtrack layer: one audio clip (resource) placed at `startFrame`. */
export interface AudioLayer extends LayerBase {
  kind: 'audio'
  /** Content-addressed resource id of the audio file. */
  resourceId: string
  /** Timeline frame the clip starts at. */
  startFrame: number
  /** Playback gain, 0..1. */
  volume: number
}

export type Layer = ObjectLayer | DrawingLayer | CameraLayer | AudioLayer

export function isObjectLayer(layer: Layer): layer is ObjectLayer {
  return layer.kind === 'object'
}

export function isDrawingLayer(layer: Layer): layer is DrawingLayer {
  return layer.kind === 'drawing'
}

export function isCameraLayer(layer: Layer): layer is CameraLayer {
  return layer.kind === 'camera'
}

export function isAudioLayer(layer: Layer): layer is AudioLayer {
  return layer.kind === 'audio'
}

/** One embedded font subset: the glyphs actually used by the document are
 * packed into a content-addressed TTF resource so the text renders on
 * machines that do not have the original family installed. */
export interface EmbeddedFont {
  /** Synthetic family the renderer registers (`@font-face`/`FontFace`);
   * deterministic (`oa-embed-<weight>-<hash8>`) so repeated saves of the
   * same subset reuse one `@font-face` entry. */
  id: string
  /** Original family name, for display and user-facing messages. */
  family: string
  /** Requested weight used by text nodes of this family (100..900-ish). */
  weight: number
  /** Content-addressed resource id of the subset TTF. */
  resourceId: string
  /** Every character included in the subset, sorted by code point. */
  glyphs: string[]
  /** License label the embedding policy reported for this family. */
  license: string
}

/** The authoring document. `layers[0]` is the topmost layer. */
export interface AnimatorDocument {
  schemaVersion: 9
  name: string
  width: number
  height: number
  fps: number
  background: string
  layers: Layer[]
  /** Document color palette: up to 48 `#rrggbb` swatches shown in every color
   * picker. Documents saved before this field existed get `[]` on migration. */
  palette: string[]
  /**
   * Authored timeline length in frames. Optional for documents saved before
   * this field existed; when absent the duration is derived from keyframes.
   */
  frames?: number
  /**
   * Non-destructive "animate on 2s/3s…" hold step: playback, onion skinning,
   * export and the stage evaluate the document at `frame - frame % holdStep`.
   * Absent ≡ 1 (every frame is addressed). Frames are never duplicated in the
   * document — the setting is consumed at evaluation time only.
   */
  holdStep?: number
  /** Document asset library (symbols and images); empty in migrated documents. */
  assets: Asset[]
  /** Embedded font subsets referenced by text nodes. Documents saved before
   * this field existed get `[]` on migration. */
  fonts: EmbeddedFont[]
}

/** Independent copy of a node, including nested objects like `center` and
 * (for groups) the full child tree. */
export function cloneNode(node: SceneNode): SceneNode {
  if (node.type === 'group') {
    return {
      ...node,
      center: { ...node.center },
      children: node.children.map(cloneNode)
    }
  }
  return { ...node, center: { ...node.center } }
}
