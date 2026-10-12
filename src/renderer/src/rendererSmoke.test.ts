// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDocument } from '@shared/document'
import { RenderScheduler } from '@shared/renderScheduler'

import { DrawingSession, type DrawingSessionDeps } from './drawing'
import { Editor } from './editor'
import { PropertiesView } from './properties'
import { StageView } from './stage'
import { TimelineView } from './timeline'

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

/**
 * Renderer smoke test: runs the real view classes (StageView, TimelineView,
 * PropertiesView) against a real Editor over the real notification chain —
 * the exact integration whose silent breakage used to freeze the application
 * the moment raster content existed. The canvas/resource side effects are
 * faked at their DOM boundaries; everything between them is production code.
 */

function fakeCanvas2d(): CanvasRenderingContext2D {
  return {
    save: () => {},
    restore: () => {},
    clearRect: () => {},
    drawImage: () => {},
    beginPath: () => {},
    moveTo: () => {},
    quadraticCurveTo: () => {},
    stroke: () => {},
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    strokeStyle: '#000',
    lineCap: 'round',
    lineJoin: 'round',
    lineWidth: 1
  } as unknown as CanvasRenderingContext2D
}

function fakeDrawingDeps(): DrawingSessionDeps {
  return {
    createCanvas: (width: number, height: number) =>
      ({ width, height, getContext: () => fakeCanvas2d() }) as unknown as HTMLCanvasElement,
    loadImage: () => Promise.resolve({ width: 10, height: 10 } as CanvasImageSource),
    encodePng: () => Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  }
}

function mockApi(): void {
  const api = {
    versions: () => Promise.resolve({ app: '0.0.0', electron: '0', chrome: '0', node: '0' }),
    addResource: () => Promise.resolve({ resourceId: `res-${Math.random().toString(36).slice(2, 8)}`, deduped: false }),
    saveProjectAs: () => Promise.resolve({ canceled: true } as const),
    saveProjectTo: () => Promise.resolve({ ok: true } as const),
    openProjectDialog: () => Promise.resolve({ canceled: true } as const),
    readProjectFile: () => Promise.resolve({ ok: false, error: 'unused' } as const),
    getRecentProjects: () => Promise.resolve([]),
    rememberProject: () => Promise.resolve([]),
    pickImageFile: () => Promise.resolve({ canceled: true } as const),
    purgeUnusedResources: () => Promise.resolve({ removed: 0 }),
    resetResourceStore: () => Promise.resolve(),
    listLibrary: () => Promise.resolve({ assets: [], resources: {} }),
    addLibraryAsset: () => Promise.resolve(),
    removeLibraryAsset: () => Promise.resolve(),
    renameLibraryAsset: () => Promise.resolve()
  }
  vi.stubGlobal('api', api)
  ;(window as unknown as { api: unknown }).api = api
}

describe('renderer smoke (real views, real editor)', () => {
  let editor: Editor
  let stage: StageView
  let timelineHost: HTMLElement
  let propertiesHost: HTMLElement

  beforeEach(() => {
    mockApi()
    editor = new Editor(createDocument('smoke', 320, 180, 12), {
      createTransparentPng: () => Promise.resolve(new Uint8Array([0]))
    })
    const stageHost = document.createElement('main')
    timelineHost = document.createElement('section')
    propertiesHost = document.createElement('aside')
    document.body.append(stageHost, timelineHost, propertiesHost)
    stage = new StageView(editor, stageHost, { scheduler: syncScheduler() })
    new TimelineView(editor, timelineHost)
    new PropertiesView(editor, propertiesHost)
  })

  it('renders a committed drawing cell on the stage and in the filmstrip', async () => {
    editor.addLayerAtBottom('drawing')
    expect(editor.tool).toBe('brush')
    const layerId = editor.currentLayerId

    // Expand the layer row so its filmstrip is part of the timeline DOM.
    const rowToggle = timelineHost.querySelector<HTMLElement>(
      `.tl-row[data-layer-id="${layerId}"] .tl-toggle`
    )
    expect(rowToggle).not.toBeNull()
    rowToggle!.click()

    // One brush stroke: the session commits the buffer as the cell at frame 0.
    const session = new DrawingSession(editor, { eraser: false, onPaint: () => {} }, fakeDrawingDeps())
    expect(await session.begin({ x: 10, y: 10, pressure: 0.5 })).toBe(true)
    session.extend({ x: 40, y: 30, pressure: 0.5 })
    expect(await session.end()).toBe(true)

    // The cell exists and the stage SVG re-rendered with it as an image.
    const layer = editor.document.layers.find((candidate) => candidate.id === layerId)
    expect(layer?.kind).toBe('drawing')
    if (layer?.kind !== 'drawing') return
    expect(layer.cells).toHaveLength(1)
    const stageMarkup = stage.element.innerHTML
    expect(stageMarkup).toContain('<image')
    expect(stageMarkup).toContain('blob:')

    // The expanded filmstrip carries a real thumbnail image element.
    const filmstrip = timelineHost.querySelector('.tl-filmstrip')
    expect(filmstrip).not.toBeNull()
    expect(filmstrip!.querySelectorAll('img').length).toBeGreaterThan(0)
  })

  it('deleting the current drawing layer re-renders the timeline and auto-switches the tool', async () => {
    editor.addLayerAtBottom('drawing')
    const drawingLayerId = editor.currentLayerId
    const session = new DrawingSession(editor, { eraser: false, onPaint: () => {} }, fakeDrawingDeps())
    await session.begin({ x: 5, y: 5, pressure: 0.5 })
    await session.end()
    expect(editor.tool).toBe('brush')

    editor.removeLayer(drawingLayerId)

    expect(editor.currentLayer?.kind).toBe('object')
    expect(editor.tool).toBe('select')
    // The filmstrip row is gone from the re-rendered timeline.
    expect(timelineHost.querySelector('.tl-filmstrip')).toBeNull()
    // The stage no longer renders the deleted cell's image.
    expect(stage.element.innerHTML).not.toContain('<image')
  })

  it('keeps the statusbar/properties registered when the stage render throws', () => {
    // Simulates the historical failure mode: a view registered before others
    // throws during a document change; later views must still update.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let stageRenders = 0
    const originalRender = stage.render.bind(stage)
    stage.render = () => {
      stageRenders += 1
      throw new Error('render boom')
    }
    try {
      const statusbarUpdate = vi.fn()
      editor.onDocChange(statusbarUpdate)
      editor.addNode({
        id: 'n1',
        type: 'primitive',
        primitive: 'rect',
        center: { x: 0, y: 0 },
        width: 10,
        height: 10,
        rotation: 0,
        fill: '#ffffff',
        opacity: 1
      })
      // The broken view failed, the error was surfaced, and every later
      // listener still ran.
      expect(stageRenders).toBeGreaterThan(0)
      expect(errorSpy).toHaveBeenCalled()
      expect(statusbarUpdate).toHaveBeenCalled()
      expect(timelineHost.querySelector('.tl-row')).not.toBeNull()
    } finally {
      stage.render = originalRender
      errorSpy.mockRestore()
    }
  })

  it('ships a CSP that allows blob: images', () => {
    const html = readFileSync('src/renderer/index.html', 'utf8')
    const match = /img-src [^"]*/.exec(html)
    expect(match).not.toBeNull()
    expect(match![0]).toContain('blob:')
  })
})
