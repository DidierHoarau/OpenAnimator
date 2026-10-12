import { evaluateLayerAtFrame, holdStepOf, resolveCellAtFrame } from './document'
import type { AnimatorDocument, SceneNode } from './model'
import { isObjectLayer } from './model'
import { resolveSceneNodes } from './symbols'

/** One layer's evaluated, renderer-agnostic content at a frame. */
export interface RenderLayer {
  layerId: string
  name: string
  /** Evaluated nodes of the layer, in paint order within the layer. */
  nodes: SceneNode[]
}

/** Stable node id of the synthetic image standing in for a layer's cell. */
export function drawingCellNodeId(layerId: string): string {
  return `drawing-${layerId}`
}

/**
 * Evaluates the whole document at a frame into a renderer-agnostic render
 * tree: the visible layers in paint order (bottom of the stack first).
 * Object layers carry their nodes as evaluated by the per-object span and
 * tween-by-id rules of `evaluateLayerAtFrame`, with symbol instances resolved
 * against the document assets (cycle-guarded). Drawing layers resolve their
 * cell (latest cell ≤ frame, blank after the last cell) into one synthetic
 * full-stage image node — which also makes onion skinning work for cells
 * through the same pipeline. This single pipeline feeds the stage, onion
 * skinning and thumbnails.
 *
 * The document's non-destructive hold step is consumed here: with
 * `holdStep: n` every frame evaluates at `frame - frame % n`, so playback,
 * onion skinning, export and the CLI all animate on n's without any frame
 * being duplicated in the document.
 */
export function evaluateDocumentAtFrame(
  document: AnimatorDocument,
  frame: number
): RenderLayer[] {
  const step = holdStepOf(document)
  const evaluated = step > 1 && frame >= 0 ? frame - (frame % step) : frame
  const layers: RenderLayer[] = []
  for (let i = document.layers.length - 1; i >= 0; i--) {
    const layer = document.layers[i]
    if (!layer.visible) continue
    let nodes: SceneNode[]
    if (isObjectLayer(layer)) {
      nodes = resolveSceneNodes(evaluateLayerAtFrame(layer, evaluated), document.assets)
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
  return layers
}
