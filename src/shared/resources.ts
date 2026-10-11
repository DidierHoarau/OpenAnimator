import type { AnimatorDocument, Asset, SceneNode } from './model'
import { isObjectLayer } from './model'

/**
 * Counts how many times each resource is referenced by the document: one walk
 * over every object layer's keyframes (recursing into group children), one
 * over every drawing layer's cells, plus one walk over the document assets
 * (image assets reference their resource; symbol assets reference the images
 * inside their content, including through nested symbol instances, guarded
 * against cycles). Used by the main process to write only referenced
 * resources into the project file and for the explicit purge-unused command.
 */
export function collectResourceCounts(document: AnimatorDocument): Map<string, number> {
  const counts = new Map<string, number>()
  const count = (resourceId: string): void => {
    counts.set(resourceId, (counts.get(resourceId) ?? 0) + 1)
  }
  const visit = (node: SceneNode): void => {
    if (node.type === 'image') {
      count(node.resourceId)
      return
    }
    if (node.type === 'group') {
      for (const child of node.children) visit(child)
    }
  }
  for (const layer of document.layers) {
    if (isObjectLayer(layer)) {
      for (const keyframe of layer.keyframes) {
        for (const node of keyframe.nodes) visit(node)
      }
    } else {
      for (const cell of layer.cells) count(cell.resourceId)
    }
  }
  const byId = new Map(document.assets.map((asset) => [asset.id, asset]))
  const visitAsset = (asset: Asset, visited: Set<string>): void => {
    if (visited.has(asset.id)) return
    visited.add(asset.id)
    if (asset.kind === 'image' && asset.resourceId) {
      count(asset.resourceId)
      return
    }
    if (asset.kind === 'symbol' && asset.content) {
      const walk = (node: SceneNode): void => {
        if (node.type === 'image') {
          count(node.resourceId)
          return
        }
        if (node.type === 'group') {
          for (const child of node.children) walk(child)
          return
        }
        if (node.type === 'symbol') {
          const referenced = byId.get(node.assetId)
          if (referenced) visitAsset(referenced, visited)
        }
      }
      for (const child of asset.content.children) walk(child)
    }
  }
  for (const asset of document.assets) visitAsset(asset, new Set())
  return counts
}
