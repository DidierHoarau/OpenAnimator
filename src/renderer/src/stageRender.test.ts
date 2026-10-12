// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { createDocument } from '@shared/document'
import { embeddedFamilyResolverFor } from '@shared/fontPolicy'
import type { PrimitiveNode } from '@shared/model'
import { evaluateDocumentAtFrame } from '@shared/render'
import { RenderScheduler } from '@shared/renderScheduler'
import { renderFrameToSvgMarkup } from '@shared/renderSvg'

import { Editor } from './editor'
import { StageView } from './stage'
import type { StageRenderStats } from './stage'

/**
 * Incremental keyed rendering: the stage content group is reconciled per
 * node key (`layerId:nodeId`) instead of rebuilt wholesale. The rendered
 * result must stay structurally identical to the `renderFrameToSvgMarkup`
 * oracle (the export/thumbnail pipeline), while element identity survives
 * every pass in which a node's markup did not change structurally.
 */

/** Runs render tasks immediately so notifications keep their synchronous,
 * pre-scheduler test semantics. */
function syncScheduler(): RenderScheduler {
  return new RenderScheduler({
    request: (task) => {
      task()
      return 0
    },
    cancel: () => undefined
  })
}

function rect(id: string, x = 0, fill: PrimitiveNode['fill'] = '#ff0000'): PrimitiveNode {
  return {
    id,
    type: 'primitive',
    primitive: 'rect',
    center: { x, y: 0 },
    width: 10,
    height: 10,
    rotation: 0,
    fill,
    opacity: 1
  }
}

const GRADIENT: PrimitiveNode['fill'] = {
  type: 'linear',
  angle: 90,
  stops: [
    { offset: 0, color: '#ff0000' },
    { offset: 1, color: '#0000ff' }
  ]
}

/** Structural normalization of a node subtree: tag, sorted attributes,
 * children and text — order- and serialization-independent. */
function normalize(node: Node): unknown {
  if (node.nodeType === 3) return { text: node.textContent }
  const element = node as Element
  return {
    tag: element.tagName.toLowerCase(),
    attrs: element
      .getAttributeNames()
      .sort()
      .map((name) => [name, element.getAttribute(name)]),
    children: [...element.childNodes].map(normalize)
  }
}

function normalizeChildren(container: Element): unknown[] {
  return [...container.childNodes].map(normalize)
}

/** Parses markup the way the stage does, then normalizes it structurally. */
function parseNormalized(markup: string): unknown[] {
  const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  wrapper.innerHTML = markup
  return normalizeChildren(wrapper)
}

describe('StageView — incremental keyed rendering', () => {
  let editor: Editor
  let stage: StageView

  beforeEach(() => {
    document.body.textContent = ''
    editor = new Editor(createDocument('keys', 320, 180, 12))
    const host = document.createElement('main')
    document.body.appendChild(host)
    stage = new StageView(editor, host, { scheduler: syncScheduler() })
  })

  /** The keyed content group carrying one element per evaluated node. */
  const content = (): Element => {
    const group = stage.element.querySelector('.stage__content')
    if (!group) throw new Error('missing content group')
    return group
  }

  const nodeElements = (): Element[] =>
    [...content().children].filter((child) => child.tagName.toLowerCase() !== 'defs')

  const defsElement = (): Element | null =>
    [...content().children].find((child) => child.tagName.toLowerCase() === 'defs') ?? null

  const extend = (toFrame: number): void => {
    while (editor.duration <= toFrame) {
      editor.seekToFrame(editor.duration - 1)
      editor.insertFrameHere()
    }
  }

  /** Records the stats of every render pass (mutations often notify doc+ui
   * and thus render twice; the first pass carries the reconciliation). */
  const capturePasses = (): StageRenderStats[] => {
    const passes: StageRenderStats[] = []
    const original = stage.render.bind(stage)
    stage.render = () => {
      original()
      passes.push({ ...stage.renderStats })
    }
    return passes
  }

  /** The oracle: the same evaluated frame rendered by the shared pipeline. */
  const oracle = (): unknown[] => {
    const evaluated = evaluateDocumentAtFrame(editor.document, editor.currentFrame)
    const rendered = renderFrameToSvgMarkup(evaluated.layers, (id) => editor.resources.getUrl(id), {
      resolveEmbeddedFont: embeddedFamilyResolverFor(editor.document.fonts)
    })
    return parseNormalized(rendered.markup)
  }

  it('matches the renderFrameToSvgMarkup oracle after every pass', () => {
    editor.addNode(rect('a', 0))
    editor.addNode(rect('b', 60))
    expect(normalizeChildren(content())).toEqual(oracle())

    extend(5)
    editor.seekToFrame(3)
    expect(normalizeChildren(content())).toEqual(oracle())

    editor.selectNodes(['a'], 'replace')
    editor.nudgeSelected(4, 2)
    expect(normalizeChildren(content())).toEqual(oracle())

    editor.addNode(rect('c', 90, GRADIENT))
    expect(normalizeChildren(content())).toEqual(oracle())

    editor.deleteSelected()
    expect(normalizeChildren(content())).toEqual(oracle())
  })

  it('leaves every element untouched when nothing changed', () => {
    editor.addNode(rect('a', 0))
    editor.addNode(rect('b', 60))
    const before = nodeElements()
    expect(before).toHaveLength(2)

    stage.render()
    expect(stage.renderStats).toEqual({ created: 0, reused: 2, patched: 0, replaced: 0, removed: 0 })
    expect(nodeElements()[0]).toBe(before[0])
    expect(nodeElements()[1]).toBe(before[1])

    // A selection change re-renders the pass but touches no content element.
    editor.selectNodes(['a'], 'replace')
    expect(stage.renderStats.reused).toBe(2)
    expect(nodeElements()[0]).toBe(before[0])
    expect(nodeElements()[1]).toBe(before[1])
  })

  it('patches only the moved node in place (drag fast path)', () => {
    editor.addNode(rect('a', 0))
    editor.addNode(rect('b', 60))
    const [elementA, elementB] = nodeElements()

    editor.selectNodes(['a'], 'replace')
    editor.beginInteraction()
    editor.updateSelectedNodes((node) => {
      node.center.x += 5
    })
    editor.endInteraction()

    expect(stage.renderStats).toEqual({ created: 0, reused: 1, patched: 1, replaced: 0, removed: 0 })
    const [afterA, afterB] = nodeElements()
    expect(afterA).toBe(elementA)
    expect(afterB).toBe(elementB)
    expect(afterA.getAttribute('transform')).toContain('translate(5 0)')
  })

  it('patches the tweened node only when the frame changes', () => {
    editor.addNode(rect('a', 0))
    editor.addNode(rect('b', 60))
    extend(6)
    editor.selectNodes(['a'], 'replace')
    editor.seekToFrame(6)
    editor.updateSelectedNode((node) => {
      if (node.type === 'primitive') node.center.x = 40
    })
    // 'b' spans 0..6 with an unchanged pose, so it stays on stage.
    expect(editor.ensureNodeKeyframe('b')).toBe(true)
    editor.seekToFrame(0)
    editor.selectNodes(['a'], 'replace')
    editor.toggleTweenHere()

    const [elementA, elementB] = nodeElements()
    editor.seekToFrame(3)

    // 'a' interpolates (transform patched in place), 'b' holds (reused).
    expect(stage.renderStats).toEqual({ created: 0, reused: 1, patched: 1, replaced: 0, removed: 0 })
    expect(nodeElements()[0]).toBe(elementA)
    expect(nodeElements()[1]).toBe(elementB)
  })

  it('replaces the element on a structural change and detaches the old one', () => {
    editor.addNode(rect('a', 0))
    const element = nodeElements()[0]
    expect(element.tagName.toLowerCase()).toBe('rect')

    const passes = capturePasses()
    editor.replaceSelectedNode((node) =>
      node.type === 'primitive' ? { ...node, primitive: 'ellipse' } : node
    )

    expect(passes[0]).toEqual({ created: 0, reused: 0, patched: 0, replaced: 1, removed: 0 })
    const replacement = nodeElements()[0]
    expect(replacement.tagName.toLowerCase()).toBe('ellipse')
    expect(replacement).not.toBe(element)
    expect(content().contains(element)).toBe(false)
  })

  it('removes vanished keys and creates new ones', () => {
    editor.addNode(rect('a', 0))
    editor.addNode(rect('b', 60))
    const [elementA, elementB] = nodeElements()

    editor.selectNodes(['a'], 'replace')
    const passes = capturePasses()
    editor.deleteSelected()
    expect(passes[0]).toEqual({ created: 0, reused: 1, patched: 0, replaced: 0, removed: 1 })
    expect(content().contains(elementA)).toBe(false)
    expect(nodeElements()[0]).toBe(elementB)

    const start = passes.length
    editor.addNode(rect('c', 90))
    expect(passes[start]).toEqual({ created: 1, reused: 1, patched: 0, replaced: 0, removed: 0 })
    expect(nodeElements()[0]).toBe(elementB)
  })

  it('rebuilds the defs block only when the gradient set changes', () => {
    editor.addNode(rect('a', 0, GRADIENT))
    const defs = defsElement()
    expect(defs).not.toBeNull()
    expect(content().firstElementChild).toBe(defs)

    editor.nudgeSelected(3, 0)
    expect(defsElement()).toBe(defs)

    const passes = capturePasses()
    editor.deleteSelected()
    expect(passes[0].removed).toBe(1)
    expect(defsElement()).toBeNull()
  })
})
