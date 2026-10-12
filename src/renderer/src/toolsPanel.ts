import { toolCompatibleWithLayer, type Editor, type Tool } from './editor'
import { el } from './dom'

interface ToolEntry {
  tool: Tool
  label: string
  title: string
  icon: string
}

/**
 * Grouped tool registry rendered as the vertical icon strip left of the
 * stage. Icons are inline SVG strokes that inherit currentColor.
 */
const TOOL_GROUPS: ToolEntry[][] = [
  [
    {
      tool: 'select',
      label: 'Select',
      title: 'Select and move shapes (V)',
      icon: '<path d="M4 4l7.07 17 2.51-7.39L21 11.07Z"/>'
    },
    {
      tool: 'direct',
      label: 'Direct selection',
      title:
        'Edit path anchors: drag anchors and handles, double-click an anchor for corner/smooth, double-click a segment to insert (A)',
      icon:
        '<path d="m5 3 5.6 13.4 1.8-5.2 5.2-1.8Z"/>' +
        '<circle cx="17.6" cy="17.6" r="2.4"/>' +
        '<path d="M11.4 11.4 15.2 15.2"/>'
    },
    {
      tool: 'hand',
      label: 'Hand',
      title: 'Pan the stage view (H, or hold Space and drag)',
      icon:
        '<path d="M18 11V6a2 2 0 0 0-4 0v5"/>' +
        '<path d="M14 10V4a2 2 0 0 0-4 0v2"/>' +
        '<path d="M10 10.5V6a2 2 0 0 0-4 0v8"/>' +
        '<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'
    },
    {
      tool: 'eyedropper',
      label: 'Eyedropper',
      title: 'Pick a stage color into the selection or the brush (I, or Alt+click from any tool)',
      icon:
        '<path d="m2 22 1-1h3l9-9"/>' +
        '<path d="M3 21v-3l9-9"/>' +
        '<path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.7.7a2.1 2.1 0 1 1-3 3l-3.3-3.3a2.1 2.1 0 1 1 3-3l.6.6Z"/>'
    }
  ],
  [
    {
      tool: 'brush',
      label: 'Brush',
      title: 'Paint on the current drawing layer (B)',
      icon:
        '<path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/>' +
        '<path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>'
    },
    {
      tool: 'eraser',
      label: 'Eraser',
      title: 'Erase on the current drawing layer (E)',
      icon:
        '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/>' +
        '<path d="M22 21H7"/>' +
        '<path d="m5 11 9 9"/>'
    }
  ],
  [
    {
      tool: 'rect',
      label: 'Rectangle',
      title: 'Draw a rectangle (R)',
      icon: '<rect x="4" y="6" width="16" height="12" rx="1"/>'
    },
    {
      tool: 'ellipse',
      label: 'Ellipse',
      title: 'Draw an ellipse (O)',
      icon: '<circle cx="12" cy="12" r="8"/>'
    },
    {
      tool: 'line',
      label: 'Line',
      title: 'Draw a straight line (L)',
      icon: '<path d="M5 19 19 5"/>'
    },
    {
      tool: 'pen',
      label: 'Pen',
      title:
        'Draw a Bezier path: click to place anchors, drag for handles, click the first anchor or press Enter to finish (P)',
      icon:
        '<path d="m12 19 7-7 3 3-7 7-3-3z"/>' +
        '<path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>' +
        '<path d="m2 2 7.586 7.586"/>' +
        '<circle cx="11" cy="11" r="2"/>'
    },
    {
      tool: 'vector',
      label: 'Vector brush',
      title: 'Draw a smooth vector stroke, committed as an editable path (N)',
      icon:
        '<path d="M4 18c2.5-7 5-7 7.5-2.5S16.5 19 20 6"/>' +
        '<circle cx="4" cy="18" r="1.6"/>' +
        '<circle cx="20" cy="6" r="1.6"/>'
    }
  ],
  [
    {
      tool: 'text',
      label: 'Text',
      title: 'Place text on the stage (T)',
      icon: '<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>'
    }
  ]
]

/** Builds the vertical icon tool panel shown left of the stage. */
export function buildToolsPanel(editor: Editor): HTMLElement {
  const panel = el('aside', 'tools-panel')
  const buttons: HTMLButtonElement[] = []
  for (const group of TOOL_GROUPS) {
    const groupEl = el('div', 'tools-group')
    for (const entry of group) {
      const button = el('button', 'tool-button')
      button.type = 'button'
      button.dataset.tool = entry.tool
      button.title = entry.title
      button.setAttribute('aria-label', entry.label)
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.7')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.innerHTML = entry.icon
      button.appendChild(svg)
      button.addEventListener('click', () => editor.setTool(entry.tool))
      buttons.push(button)
      groupEl.appendChild(button)
    }
    panel.appendChild(groupEl)
  }

  const update = (): void => {
    for (const button of buttons) {
      const tool = (button.dataset.tool ?? 'select') as Tool
      // Tools that cannot act on the current layer kind are dimmed, e.g. the
      // brush on an object layer or the rectangle tool on a drawing layer.
      button.disabled = !toolCompatibleWithLayer(tool, editor.currentLayer)
      button.classList.toggle('active', tool === editor.tool)
    }
  }
  update()
  editor.onUiChange(update)
  return panel
}
