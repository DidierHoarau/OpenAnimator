import { evaluateLayerAtFrame } from './document'
import type { AnimatorDocument, Shape } from './model'

/** One layer's evaluated, renderer-agnostic content at a frame. */
export interface RenderLayer {
  layerId: string
  name: string
  /** Evaluated shapes of the layer, in paint order within the layer. */
  shapes: Shape[]
}

/**
 * Evaluates the whole document at a frame into a renderer-agnostic render
 * tree: the visible layers in paint order (bottom of the stack first), each
 * carrying its shapes as evaluated by the per-object span and tween-by-id
 * rules of `evaluateLayerAtFrame`. Hidden layers are skipped; empty layers
 * are included with an empty shape list. This single pipeline feeds the
 * stage, onion skinning and — in later phases — thumbnails and icons.
 */
export function evaluateDocumentAtFrame(
  document: AnimatorDocument,
  frame: number
): RenderLayer[] {
  const layers: RenderLayer[] = []
  for (let i = document.layers.length - 1; i >= 0; i--) {
    const layer = document.layers[i]
    if (!layer.visible) continue
    layers.push({
      layerId: layer.id,
      name: layer.name,
      shapes: evaluateLayerAtFrame(layer, frame)
    })
  }
  return layers
}
