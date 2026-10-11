import type { Vec2 } from './geometry'
import { groupNaturalSize } from './groups'
import { createId } from './document'
import { cloneNode } from './model'
import type { AnimatorDocument, Asset, GroupNode, SceneNode } from './model'

/** Fields the caller supplies when creating a document asset; `id` and
 * `createdAt` get fresh defaults. */
export type AssetInput = Pick<Asset, 'name' | 'kind'> &
  Partial<Pick<Asset, 'content' | 'resourceId' | 'naturalWidth' | 'naturalHeight'>>

/** Creates a document asset with a fresh id and creation timestamp. */
export function createDocumentAsset(input: AssetInput): Asset {
  return {
    id: createId('asset'),
    createdAt: Date.now(),
    ...input
  }
}

/** Independent copy of an asset (deep-cloned content) under a new identity. */
export function duplicateAsset(asset: Asset, newId: string, newName: string): Asset {
  const copy: Asset = structuredClone(asset)
  copy.id = newId
  copy.name = newName
  copy.createdAt = Date.now()
  return copy
}

/** Natural content size of an asset: a symbol's content bounds, or an
 * image's intrinsic pixel size (0×0 when unknown). */
export function assetNaturalSize(asset: Asset): { width: number; height: number } {
  if (asset.kind === 'symbol' && asset.content) {
    return groupNaturalSize(asset.content.children)
  }
  return {
    width: asset.naturalWidth ?? 0,
    height: asset.naturalHeight ?? 0
  }
}

/** Number of symbol instances of `assetId` on stage: every symbol node in
 * every keyframe of every layer, recursing into group children. */
export function countAssetInstances(document: AnimatorDocument, assetId: string): number {
  let count = 0
  const visit = (node: SceneNode): void => {
    if (node.type === 'symbol' && node.assetId === assetId) count += 1
    if (node.type === 'group') for (const child of node.children) visit(child)
  }
  for (const layer of document.layers) {
    for (const keyframe of layer.keyframes) {
      for (const node of keyframe.nodes) visit(node)
    }
  }
  return count
}

/**
 * Every resource id an asset depends on: an image asset references its own
 * resource; a symbol asset references the images inside its content —
 * recursing through groups and through nested symbol instances (resolved
 * against `contextAssets`, guarded against cycles so a malformed graph
 * cannot hang the walk).
 */
export function collectAssetResourceIds(asset: Asset, contextAssets: Asset[] = []): string[] {
  const ids = new Set<string>()
  const byId = new Map(contextAssets.map((entry) => [entry.id, entry]))
  const visitAsset = (current: Asset, visited: Set<string>): void => {
    if (visited.has(current.id)) return
    visited.add(current.id)
    if (current.kind === 'image' && current.resourceId) {
      ids.add(current.resourceId)
      return
    }
    if (current.kind === 'symbol' && current.content) {
      const walk = (node: SceneNode): void => {
        if (node.type === 'image' && node.resourceId) {
          ids.add(node.resourceId)
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
      for (const child of current.content.children) walk(child)
    }
  }
  visitAsset(asset, new Set())
  return [...ids]
}

/**
 * Normalizes a grouped selection into symbol asset content: the children
 * keep their content-local coordinates while the content box is centered on
 * the origin and sized to the natural content bounds.
 */
export function symbolContentFromGroup(group: GroupNode): GroupNode {
  const natural = groupNaturalSize(group.children)
  return {
    ...group,
    center: { x: 0, y: 0 },
    width: natural.width,
    height: natural.height,
    rotation: 0,
    opacity: 1
  }
}

/**
 * Converts a symbol instance into an equivalent standalone group: the
 * instance's transform and opacity are kept, the asset's content children
 * are deep-cloned (still in content-local coordinates) so the result is
 * fully editable and decoupled from the asset.
 */
export function instanceToGroup(instance: {
  id?: string
  name?: string
  center: Vec2
  width: number
  height: number
  rotation: number
  opacity: number
}, content: GroupNode, newId: string): GroupNode {
  return {
    id: newId,
    type: 'group',
    ...(instance.name !== undefined ? { name: instance.name } : {}),
    center: { ...instance.center },
    width: instance.width,
    height: instance.height,
    rotation: instance.rotation,
    opacity: instance.opacity,
    children: content.children.map(cloneNode)
  }
}
