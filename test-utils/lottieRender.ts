/**
 * Shared lottie-web render harness for the export gate: exported Lottie JSON
 * is fed to the real lottie-web player (the same 5.13 light build the app
 * documents) and the rendered SVG markup is inspected. Vitest runs it inside
 * the happy-dom environment; the Playwright Node process bootstraps an
 * equivalent happy-dom window before loading the player, so one loader serves
 * both test layers.
 */

/** The audio object lottie-web drives; the default no-Howl stub lacks
 * `volume`, so tests that exercise an embedded audio layer pass a factory. */
export interface AudioStub {
  volume(value: number): void
  play(): void
  seek(value?: number): number
  playing(): boolean
  rate(value?: number): void
  setVolume(value: number): void
  pause(): void
}

export interface LoadedLottieAnimation {
  /** Wrapper element, already attached to the document body. */
  container: HTMLElement
  goToAndStop(frame: number, isFrame: boolean): void
  play(): void
  destroy(): void
}

export interface LottieLoadOptions {
  audioFactory?: (assetPath: string) => AudioStub
}

export interface LottieRenderHarness {
  /** Loads animation data with the SVG renderer (autoplay off). The caller
   * destroys the animation and removes the container. */
  load(animationData: Record<string, unknown>, options?: LottieLoadOptions): LoadedLottieAnimation
  /** Loads animation data, seeks to `frame` and returns the container's
   * rendered SVG markup (the animation is destroyed again). */
  renderAt(animationData: Record<string, unknown>, frame: number): string
}

interface LottiePlayer {
  loadAnimation(options: {
    container: HTMLElement
    renderer: string
    autoplay: boolean
    animationData: Record<string, unknown>
    audioFactory?: (assetPath: string) => AudioStub
  }): { goToAndStop(frame: number, isFrame: boolean): void; play(): void; destroy(): void }
}

/** lottie-web's light build probes a canvas 2D context even for the SVG
 * renderer; happy-dom implements none, so a minimal stub keeps it happy. */
function stubCanvas(): void {
  const proto = window.HTMLCanvasElement.prototype as unknown as { getContext: unknown }
  proto.getContext = function getContext(this: HTMLCanvasElement) {
    return {
      canvas: this,
      fillRect: () => {},
      clearRect: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData: () => {},
      createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      setTransform: () => {},
      drawImage: () => {},
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      bezierCurveTo: () => {},
      quadraticCurveTo: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
      clip: () => {},
      measureText: () => ({ width: 0 }),
      fillText: () => {},
      strokeText: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createPattern: () => null,
      scale: () => {},
      rotate: () => {},
      translate: () => {},
      transform: () => {},
      rect: () => {},
      ellipse: () => {},
      isPointInPath: () => false
    }
  }
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

/** Vitest's happy-dom environment already provides `window`; a bare Node
 * process (the Playwright worker) gets a fresh happy-dom window whose
 * globals — including the constructor properties the SVG renderer uses —
 * are installed on `globalThis` before lottie-web is imported. */
async function ensureBrowserGlobals(): Promise<void> {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    stubCanvas()
    return
  }
  const { Window } = await import('happy-dom')
  const dom = new Window({ url: 'http://localhost' })
  defineGlobal('window', dom)
  defineGlobal('document', dom.document)
  defineGlobal('navigator', dom.navigator)
  defineGlobal('location', dom.location)
  defineGlobal('history', dom.history)
  defineGlobal('getComputedStyle', dom.getComputedStyle.bind(dom))
  defineGlobal('requestAnimationFrame', dom.requestAnimationFrame.bind(dom))
  defineGlobal('cancelAnimationFrame', dom.cancelAnimationFrame.bind(dom))
  defineGlobal('Event', dom.Event)
  defineGlobal('CustomEvent', dom.CustomEvent)
  defineGlobal('Node', dom.Node)
  defineGlobal('Element', dom.Element)
  defineGlobal('HTMLElement', dom.HTMLElement)
  defineGlobal('HTMLCanvasElement', dom.HTMLCanvasElement)
  defineGlobal('SVGElement', dom.SVGElement)
  defineGlobal('Image', dom.Image)
  stubCanvas()
}

export async function createLottieRenderHarness(): Promise<LottieRenderHarness> {
  await ensureBrowserGlobals()
  // The explicit `.js` specifier resolves in bundled (Vite) and Node
  // (CommonJS-transpiled e2e) contexts alike; `lottie_light.d.ts` sits next
  // to it for types.
  const player = ((await import('lottie-web/build/player/lottie_light.js')) as unknown as {
    default: LottiePlayer
  }).default
  const load = (
    animationData: Record<string, unknown>,
    options: LottieLoadOptions = {}
  ): LoadedLottieAnimation => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const animation = player.loadAnimation({
      container,
      renderer: 'svg',
      autoplay: false,
      animationData,
      ...(options.audioFactory ? { audioFactory: options.audioFactory } : {})
    })
    return {
      container,
      goToAndStop: (frame, isFrame) => animation.goToAndStop(frame, isFrame),
      play: () => animation.play(),
      destroy: () => animation.destroy()
    }
  }
  return {
    load,
    renderAt(animationData, frame) {
      const animation = load(animationData)
      animation.goToAndStop(frame, true)
      const markup = animation.container.innerHTML
      animation.destroy()
      animation.container.remove()
      return markup
    }
  }
}
