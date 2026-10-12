import { evaluateCameraAtFrame, evaluateLayerAtFrame, holdStepOf, resolveCellAtFrame } from './document'
import type { AnimatorDocument, CameraPose, SceneNode } from './model'
import { isCameraLayer, isAudioLayer, isObjectLayer } from './model'
import type { EvaluationCache } from './renderCache'
import { resolveSceneNodes } from './symbols'

/** One layer's evaluated, renderer-agnostic content at a frame. */
export interface RenderLayer {
  layerId: string
  name: string
  /** Evaluated nodes of the layer, in paint order within the layer. */
  nodes: SceneNode[]
}

/** One evaluated frame: the visible content layers in paint order plus the
 * document camera pose the caller applies on top (`null` when the document
 * has no active camera). */
export interface EvaluatedFrame {
  layers: RenderLayer[]
  camera: CameraPose | null
}

/** Stable node id of the synthetic image standing in for a layer's cell. */
export function drawingCellNodeId(layerId: string): string {
  return `drawing-${layerId}`
}

/** The frame a document actually evaluates at: the document's non-destructive
 * hold step collapses frames onto step boundaries (`holdStep: n` evaluates
 * every frame at `frame - frame % n`). */
export function evaluatedFrameOf(document: AnimatorDocument, frame: number): number {
  const step = holdStepOf(document)
  return step > 1 && frame >= 0 ? frame - (frame % step) : frame
}

/**
 * Evaluates the whole document at a frame into a renderer-agnostic render
 * tree: the visible layers in paint order (bottom of the stack first) plus
 * the camera pose to apply on top. Object layers carry their nodes as
 * evaluated by the per-object span and tween-by-id rules of
 * `evaluateLayerAtFrame`, with symbol instances resolved against the
 * document assets (cycle-guarded). Drawing layers resolve their cell (latest
 * cell ≤ frame, blank after the last cell) into one synthetic full-stage
 * image node — which also makes onion skinning work for cells through the
 * same pipeline. Camera and audio layers are control/data layers: they never
 * appear in `layers`; the camera pose is returned separately. This single
 * pipeline feeds the stage, onion skinning and thumbnails.
 *
 * The document's non-destructive hold step is consumed here: with
 * `holdStep: n` every frame evaluates at `frame - frame % n`, so playback,
 * onion skinning, export and the CLI all animate on n's without any frame
 * being duplicated in the document.
 *
 * With a `cache`, the evaluated frame is memoized by evaluated frame number
 * and each object layer's raw evaluation by (layer, evaluated frame), so
 * onion ghosts, selection overlays and repeated frames within one render
 * pass never re-evaluate the same content. The caller owns cache
 * invalidation: entries alias document nodes and must be dropped on every
 * document mutation (the stage clears on doc change).
 */
export function evaluateDocumentAtFrame(
  document: AnimatorDocument,
  frame: number,
  cache?: EvaluationCache
): EvaluatedFrame {
  const evaluated = evaluatedFrameOf(document, frame)
  const cached = cache?.getDocument(evaluated)
  if (cached) return cached
  const layers: RenderLayer[] = []
  for (let i = document.layers.length - 1; i >= 0; i--) {
    const layer = document.layers[i]
    if (!layer.visible || isCameraLayer(layer) || isAudioLayer(layer)) continue
    let nodes: SceneNode[]
    if (isObjectLayer(layer)) {
      let raw = cache?.getLayer(layer.id, evaluated) ?? null
      if (!raw) {
        raw = evaluateLayerAtFrame(layer, evaluated)
        cache?.setLayer(layer.id, evaluated, raw)
      }
      nodes = resolveSceneNodes(raw, document.assets)
    } else {
      const resourceId = resolveCellAtFrame(layer, evaluated)
      nodes = resourceId
        ? [
            {
              id: drawingCellNodeId(layer.id),
              type: 'image',
              resourceId,
              center: { x: document.width / 2, y: document.height / 2 },
              width: document.width,
              height: document.height,
              rotation: 0,
              opacity: 1,
              naturalWidth: Math.max(1, Math.round(document.width * layer.resolutionScale)),
              naturalHeight: Math.max(1, Math.round(document.height * layer.resolutionScale)),
              smoothing: true
            }
          ]
        : []
    }
    layers.push({ layerId: layer.id, name: layer.name, nodes })
  }
  const result: EvaluatedFrame = { layers, camera: evaluateCameraAtFrame(document, evaluated) }
  cache?.setDocument(evaluated, result)
  return result
}
