import type { EvaluatedShape } from '@shared/animation'
import { evaluateScene } from '@shared/animation'
import type { Scene, Shape } from '@shared/scene'

const SVG_NS = 'http://www.w3.org/2000/svg'

function applyFill(element: SVGElement, shape: Shape): void {
  element.setAttribute('fill', shape.fill)
  if (shape.stroke) element.setAttribute('stroke', shape.stroke)
  if (shape.strokeWidth !== undefined) element.setAttribute('stroke-width', String(shape.strokeWidth))
}

/** Creates the SVG element for a shape, centered on its local origin. */
function createShapeElement(shape: Shape): SVGElement {
  if (shape.kind === 'ellipse') {
    const ellipse = document.createElementNS(SVG_NS, 'ellipse')
    ellipse.setAttribute('rx', String(shape.width / 2))
    ellipse.setAttribute('ry', String(shape.height / 2))
    applyFill(ellipse, shape)
    return ellipse
  }

  const rect = document.createElementNS(SVG_NS, 'rect')
  rect.setAttribute('x', String(-shape.width / 2))
  rect.setAttribute('y', String(-shape.height / 2))
  rect.setAttribute('width', String(shape.width))
  rect.setAttribute('height', String(shape.height))
  applyFill(rect, shape)
  return rect
}

/** Applies an evaluated state (position, rotation, opacity) to its SVG element. */
function renderShape(element: SVGElement | undefined, evaluated: EvaluatedShape): void {
  if (!element) return
  element.setAttribute(
    'transform',
    `translate(${evaluated.center.x} ${evaluated.center.y}) rotate(${evaluated.rotation})`
  )
  element.setAttribute('opacity', String(evaluated.opacity))
}

/**
 * Mounts an SVG stage rendering `scene` into `container` and runs the
 * animation loop. The loop is intentionally minimal: the editor UI will
 * replace it with an explicit playhead-driven renderer.
 */
export function mountStage(container: HTMLElement, scene: Scene): void {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${scene.width} ${scene.height}`)
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svg.classList.add('stage__canvas')
  container.appendChild(svg)

  const elements = new Map<string, SVGElement>()
  for (const shape of scene.shapes) {
    const element = createShapeElement(shape)
    elements.set(shape.id, element)
    svg.appendChild(element)
  }

  let start: number | null = null
  const tick = (now: number): void => {
    if (start === null) start = now
    for (const evaluated of evaluateScene(scene, now - start)) {
      renderShape(elements.get(evaluated.id), evaluated)
    }
    window.requestAnimationFrame(tick)
  }
  window.requestAnimationFrame(tick)
}
