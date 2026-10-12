import type { AnimatorDocument, PrimitiveNode } from './model'
import { createId } from './document'

function ballNode(id: string, x: number, y: number): PrimitiveNode {
  return {
    type: 'primitive',
    primitive: 'ellipse',
    id,
    center: { x, y },
    width: 90,
    height: 90,
    rotation: 0,
    fill: '#f59e0b',
    stroke: '#fcd34d',
    strokeWidth: 3,
    opacity: 1
  }
}

/** Document used for new projects and as a first-run demo of tweening. */
export function createStarterDocument(width = 960, height = 540, fps = 24): AnimatorDocument {
  const backdrop: PrimitiveNode = {
    type: 'primitive',
    primitive: 'rect',
    id: createId('node'),
    center: { x: width / 2, y: height / 2 },
    width,
    height,
    rotation: 0,
    fill: '#10151b',
    opacity: 1
  }

  // The demo arc scales with the stage so it stays inside the visible area.
  const sx = width / 960
  const sy = height / 540
  const ballId = createId('node')
  const demoLayer = {
    kind: 'object' as const,
    id: createId('layer'),
    name: 'Demo',
    visible: true,
    locked: false,
    keyframes: [
      {
        frame: 0,
        nodes: [ballNode(ballId, 180 * sx, 180 * sy)],
        tween: { easing: 'ease-in-out' as const }
      },
      {
        frame: 12,
        nodes: [ballNode(ballId, 480 * sx, 380 * sy)],
        tween: { easing: 'ease-in-out' as const }
      },
      { frame: 24, nodes: [ballNode(ballId, 780 * sx, 180 * sy)] }
    ]
  }

  const backgroundLayer = {
    kind: 'object' as const,
    id: createId('layer'),
    name: 'Background',
    visible: true,
    locked: false,
    keyframes: [{ frame: 0, nodes: [backdrop] }]
  }

  return {
    schemaVersion: 8,
    name: 'Untitled',
    width,
    height,
    fps,
    background: '#0b0e12',
    // Topmost layer first.
    layers: [demoLayer, backgroundLayer],
    frames: 25,
    assets: [],
    palette: [],
    fonts: []
  }
}
