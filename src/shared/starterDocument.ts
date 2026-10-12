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
export function createStarterDocument(): AnimatorDocument {
  const backdrop: PrimitiveNode = {
    type: 'primitive',
    primitive: 'rect',
    id: createId('node'),
    center: { x: 480, y: 270 },
    width: 960,
    height: 540,
    rotation: 0,
    fill: '#10151b',
    opacity: 1
  }

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
        nodes: [ballNode(ballId, 180, 180)],
        tween: { easing: 'ease-in-out' as const }
      },
      {
        frame: 12,
        nodes: [ballNode(ballId, 480, 380)],
        tween: { easing: 'ease-in-out' as const }
      },
      { frame: 24, nodes: [ballNode(ballId, 780, 180)] }
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
    schemaVersion: 4,
    name: 'Untitled',
    width: 960,
    height: 540,
    fps: 24,
    background: '#0b0e12',
    // Topmost layer first.
    layers: [demoLayer, backgroundLayer],
    frames: 25,
    assets: []
  }
}
