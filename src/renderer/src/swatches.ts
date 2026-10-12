import { el } from './dom'

export interface SwatchStripOptions {
  /** Tooltip prefix, e.g. "Document palette". */
  title: string
  /** Click handler: apply the picked color. */
  onPick: (color: string) => void
  /** When set, right-clicking a swatch removes it from its palette. */
  onRemove?: (color: string) => void
}

/**
 * Reusable horizontal strip of color swatches (document or global palette).
 * A strip with no colors hides itself, so empty palettes take no panel space.
 */
export class SwatchStrip {
  readonly root: HTMLDivElement
  private colors: string[] = []
  private active: string | null = null
  private disabled = false

  constructor(private readonly options: SwatchStripOptions) {
    this.root = el('div', 'swatch-strip')
    this.root.classList.add('hidden')
  }

  setColors(colors: string[]): void {
    const unchanged =
      colors.length === this.colors.length && colors.every((color, index) => color === this.colors[index])
    this.colors = [...colors]
    this.root.classList.toggle('hidden', this.colors.length === 0)
    if (!unchanged) this.rebuild()
  }

  /** Marks one color as active (e.g. the current paint); null clears it. */
  setActive(color: string | null): void {
    this.active = color
    for (const button of this.buttons()) {
      button.classList.toggle('active', button.dataset.color === this.active)
    }
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled
    for (const button of this.buttons()) button.disabled = disabled
  }

  private buttons(): HTMLButtonElement[] {
    return Array.from(this.root.querySelectorAll('button'))
  }

  private rebuild(): void {
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild)
    for (const color of this.colors) {
      const button = el('button', 'swatch-chip')
      button.type = 'button'
      button.dataset.color = color
      button.style.background = color
      button.title = this.options.onRemove
        ? `${color} — click to apply, right-click to remove from ${this.options.title.toLowerCase()}`
        : `${color} — click to apply (${this.options.title})`
      button.classList.toggle('active', color === this.active)
      button.disabled = this.disabled
      button.addEventListener('click', () => this.options.onPick(color))
      if (this.options.onRemove) {
        const remove = this.options.onRemove
        button.addEventListener('contextmenu', (event) => {
          event.preventDefault()
          remove(color)
        })
      }
      this.root.appendChild(button)
    }
  }
}
