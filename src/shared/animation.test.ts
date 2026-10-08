import { describe, expect, it } from 'vitest'

import { evaluateScene } from './animation'
import { createDefaultScene } from './scene'
import type { Scene } from './scene'

describe('evaluateScene', () => {
  it('leaves shapes without keyframes untouched', () => {
    const scene = createDefaultScene()
    const [backdrop] = evaluateScene(scene, 1234)
    expect(backdrop.id).toBe('backdrop')
    expect(backdrop.center).toEqual({ x: 480, y: 270 })
    expect(backdrop.rotation).toBe(0)
    expect(backdrop.opacity).toBe(1)
  })

  it('animates a keyframed property with its easing', () => {
    const scene = createDefaultScene()
    const ball = evaluateScene(scene, 500).find((shape) => shape.id === 'ball')
    expect(ball).toBeDefined()
    // Progress 0.25 with ease-in-out: 160 + (800 - 160) * 0.0625 = 200.
    expect(ball?.center.x).toBeCloseTo(200, 6)
  })

  it('loops the timeline over the scene duration', () => {
    const scene = createDefaultScene()
    const spinner = evaluateScene(scene, 4500).find((shape) => shape.id === 'spinner')
    // Loop time is 500ms: linear rotation 0 -> 360 over 4000ms gives 45 degrees.
    expect(spinner?.rotation).toBeCloseTo(45, 6)
  })
})

describe('propertyValue semantics', () => {
  const scene: Scene = {
    width: 100,
    height: 100,
    durationMs: 0,
    shapes: [
      {
        id: 'shape',
        kind: 'rect',
        center: { x: 0, y: 0 },
        width: 10,
        height: 10,
        rotation: 0,
        fill: '#ffffff',
        opacity: 1,
        keyframes: [
          { property: 'center.x', from: 0, to: 100, startMs: 1000, endMs: 2000, easing: 'linear' }
        ]
      }
    ]
  }

  it('holds the static value before the first keyframe', () => {
    expect(evaluateScene(scene, 500)[0].center.x).toBe(0)
  })

  it('interpolates inside the keyframe window', () => {
    expect(evaluateScene(scene, 1500)[0].center.x).toBe(50)
  })

  it('holds the final value after the keyframe window', () => {
    expect(evaluateScene(scene, 2500)[0].center.x).toBe(100)
  })
})
