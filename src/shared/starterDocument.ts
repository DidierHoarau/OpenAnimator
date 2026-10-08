import type { AnimatorDocument, Shape } from './model'
import { createId } from './document'

function ballShape(id: string, x: number, y: number): Shape {
  return {
    id,
    kind: 'ellipse',
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
  const backdrop = {
    id: createId('shape'),
    kind: 'rect' as const,
    center: { x: 480, y: 270 },
    width: 960,
    height: 540,
    rotation: 0,
    fill: '#10151b',
    opacity: 1
  }

  const ballId = createId('shape')
  const demoLayer = {
    id: createId('layer'),
    name: 'Demo',
    visible: true,
    locked: false,
    keyframes: [
      {
        frame: 0,
        shapes: [ballShape(ballId, 180, 180)],
        tween: { easing: 'ease-in-out' as const }
      },
      {
        frame: 12,
        shapes: [ballShape(ballId, 480, 380)],
        tween: { easing: 'ease-in-out' as const }
      },
      { frame: 24, shapes: [ballShape(ballId, 780, 180)] }
    ]
  }

  const backgroundLayer = {
    id: createId('layer'),
    name: 'Background',
    visible: true,
    locked: false,
    keyframes: [{ frame: 0, shapes: [backdrop] }]
  }

  return {
    name: 'Untitled',
    width: 960,
    height: 540,
    fps: 24,
    background: '#0b0e12',
    // Topmost layer first.
    layers: [demoLayer, backgroundLayer]
  }
}
