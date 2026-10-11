import type { Vec2 } from './geometry'
import type { EasingName } from './easing'

export type PrimitiveKind = 'rect' | 'ellipse'

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

export interface PrimitiveNode extends NodeBase {
  type: 'primitive'
  primitive: PrimitiveKind
  fill: string
  stroke?: string
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

export type SceneNode = PrimitiveNode | ImageNode | GroupNode | SymbolNode

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

/** Classic tween attached to a keyframe: interpolates toward the next keyframe. */
export interface KeyframeTween {
  easing: EasingName
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

export type Layer = ObjectLayer | DrawingLayer

export function isObjectLayer(layer: Layer): layer is ObjectLayer {
  return layer.kind === 'object'
}

export function isDrawingLayer(layer: Layer): layer is DrawingLayer {
  return layer.kind === 'drawing'
}

/** The authoring document. `layers[0]` is the topmost layer. */
export interface AnimatorDocument {
  schemaVersion: 2
  name: string
  width: number
  height: number
  fps: number
  background: string
  layers: Layer[]
  /**
   * Authored timeline length in frames. Optional for documents saved before
   * this field existed; when absent the duration is derived from keyframes.
   */
  frames?: number
  /** Document asset library (symbols and images); empty in migrated documents. */
  assets: Asset[]
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
