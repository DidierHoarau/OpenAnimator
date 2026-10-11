import { describe, expect, it } from 'vitest'

import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  identityView,
  panView,
  zoomAtView
} from './viewTransform'

describe('viewTransform', () => {
  it('identity view is scale 1 with a zero origin', () => {
    expect(identityView()).toEqual({ scale: 1, tx: 0, ty: 0 })
  })

  it('clampScale bounds the scale to [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(5)).toBe(5)
    expect(clampScale(0.01)).toBe(MIN_SCALE)
    expect(clampScale(100)).toBe(MAX_SCALE)
  })

  it('zoom keeps the focus point fixed', () => {
    // The focus is visible at 1/4 of the viewBox; it must stay at 1/4 after zoom.
    const view = { scale: 1, tx: 0, ty: 0 }
    const focus = { x: 240, y: 135 }
    const zoomed = zoomAtView(view, focus, 2)
    expect(zoomed.scale).toBe(2)
    const fractionBefore = (focus.x - view.tx) / 960
    const fractionAfter = (focus.x - zoomed.tx) / (960 / zoomed.scale)
    expect(fractionAfter).toBeCloseTo(fractionBefore)
    const fractionYBefore = (focus.y - view.ty) / 540
    const fractionYAfter = (focus.y - zoomed.ty) / (540 / zoomed.scale)
    expect(fractionYAfter).toBeCloseTo(fractionYBefore)
  })

  it('zooming an offset view keeps its focus point fixed', () => {
    const view = { scale: 2, tx: 120, ty: -40 }
    const focus = { x: 400, y: 200 }
    const zoomed = zoomAtView(view, focus, 0.5)
    expect(zoomed.scale).toBe(1)
    const stageFractionX = (focus.x - view.tx) / (960 / view.scale)
    expect((focus.x - zoomed.tx) / (960 / zoomed.scale)).toBeCloseTo(stageFractionX)
    const stageFractionY = (focus.y - view.ty) / (540 / view.scale)
    expect((focus.y - zoomed.ty) / (540 / zoomed.scale)).toBeCloseTo(stageFractionY)
  })

  it('zoom clamps at both scale bounds while keeping the focus fixed', () => {
    const view = identityView()
    const focus = { x: 100, y: 100 }
    expect(zoomAtView(view, focus, 1000).scale).toBe(MAX_SCALE)
    expect(zoomAtView(view, focus, 0.0001).scale).toBe(MIN_SCALE)
  })

  it('a zoom factor of 1 leaves the view unchanged', () => {
    const view = { scale: 2.5, tx: 33, ty: -12 }
    expect(zoomAtView(view, { x: 42, y: 42 }, 1)).toEqual(view)
  })

  it('panView shifts the origin and keeps the scale', () => {
    const view = { scale: 2, tx: 10, ty: 20 }
    expect(panView(view, -5, 7)).toEqual({ scale: 2, tx: 5, ty: 27 })
  })

  it('pan and zoom compose and the identity round-trips', () => {
    let view = identityView()
    view = zoomAtView(view, { x: 480, y: 270 }, 4)
    view = panView(view, 100, -50)
    view = panView(view, -100, 50)
    view = zoomAtView(view, { x: 480, y: 270 }, 1 / 4)
    expect(view.scale).toBeCloseTo(1)
    expect(view.tx).toBeCloseTo(0)
    expect(view.ty).toBeCloseTo(0)
  })
})
