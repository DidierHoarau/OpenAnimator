import type { AnimatorDocument, SceneNode } from './model'

/**
 * Counts how many times each resource is referenced by the document: one walk
 * over every layer's keyframes, recursing into group children. Used by the
 * main process to write only referenced resources into the project file and
 * for the explicit purge-unused command. Resources referenced by nodes that
 * merely hold through (no dedicated keyframe) are counted through their
 * owning keyframe content — the count is over the persisted content.
 */
export function collectResourceCounts(document: AnimatorDocument): Map<string, number> {
  const counts = new Map<string, number>()
  const visit = (node: SceneNode): void => {
    if (node.type === 'image') {
      counts.set(node.resourceId, (counts.get(node.resourceId) ?? 0) + 1)
      return
    }
    if (node.type === 'group') {
      for (const child of node.children) visit(child)
    }
  }
  for (const layer of document.layers) {
    for (const keyframe of layer.keyframes) {
      for (const node of keyframe.nodes) visit(node)
    }
  }
  return counts
}
