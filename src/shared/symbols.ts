import type { Asset, SceneNode } from './model'

/** Maximum symbol nesting depth: instances nested deeper (or cycling) stay
 * unresolved placeholders instead of hanging the renderer. */
export const MAX_SYMBOL_DEPTH = 16

/**
 * Resolves symbol instances into equivalent group nodes so rendering and
 * hit-testing can treat them like any other content: a resolvable
 * `SymbolNode` is replaced by a group that keeps the instance's id, name,
 * transform and opacity, with the asset's content children (recursively
 * resolved for nested symbols) in content-local coordinates.
 *
 * Unresolvable instances — missing asset, non-symbol asset, no content, or
 * reaching the depth cap / a cycle on the current resolution path — pass
 * through untouched and render as dashed placeholders. Never mutates the
 * input; resolution terminates for any input graph.
 */
export function resolveSceneNodes(
  nodes: SceneNode[],
  assets: Asset[],
  depth = 0,
  visited?: Set<string>
): SceneNode[] {
  const path = visited ?? new Set<string>()
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const resolve = (node: SceneNode, level: number): SceneNode => {
    if (node.type === 'group') {
      return { ...node, children: node.children.map((child) => resolve(child, level)) }
    }
    if (node.type !== 'symbol') return node
    if (level >= MAX_SYMBOL_DEPTH || path.has(node.assetId)) return node
    const asset = byId.get(node.assetId)
    if (!asset || asset.kind !== 'symbol' || !asset.content) return node
    path.add(node.assetId)
    try {
      return {
        id: node.id,
        ...(node.name !== undefined ? { name: node.name } : {}),
        type: 'group',
        center: { ...node.center },
        width: node.width,
        height: node.height,
        rotation: node.rotation,
        opacity: node.opacity,
        children: asset.content.children.map((child) => resolve(child, level + 1))
      }
    } finally {
      path.delete(node.assetId)
    }
  }
  return nodes.map((node) => resolve(node, depth))
}

/**
 * Inspects an asset graph for cycles or nesting beyond `MAX_SYMBOL_DEPTH`.
 * Returns a user-presentable description of the first problem found, or
 * null when the graph is sound. Surfaced as a status message at load — a
 * cyclic document still opens (unresolvable instances render as
 * placeholders), it must never hang the renderer.
 */
export function validateAssetGraph(assets: Asset[]): string | null {
  const byId = new Map(assets.map((asset) => [asset.id, asset]))

  const references = (asset: Asset): string[] => {
    const ids: string[] = []
    if (asset.kind !== 'symbol' || !asset.content) return ids
    const walk = (node: SceneNode): void => {
      if (node.type === 'group') {
        for (const child of node.children) walk(child)
        return
      }
      if (node.type === 'symbol') ids.push(node.assetId)
    }
    for (const child of asset.content.children) walk(child)
    return ids
  }

  const label = (id: string): string => `"${byId.get(id)?.name ?? id}"`

  const visit = (assetId: string, path: string[], depth: number): string | null => {
    if (depth > MAX_SYMBOL_DEPTH) {
      const names = [...path, assetId].map(label)
      return `Symbol nesting exceeds the maximum depth of ${MAX_SYMBOL_DEPTH}: ${names.join(' → ')}`
    }
    if (path.includes(assetId)) {
      const names = [...path.slice(path.indexOf(assetId)), assetId].map(label)
      return `Symbol cycle detected: ${names.join(' → ')}`
    }
    const asset = byId.get(assetId)
    if (!asset) return null
    for (const referenceId of references(asset)) {
      const problem = visit(referenceId, [...path, assetId], depth + 1)
      if (problem) return problem
    }
    return null
  }

  for (const asset of assets) {
    const problem = visit(asset.id, [], 0)
    if (problem) return problem
  }
  return null
}
