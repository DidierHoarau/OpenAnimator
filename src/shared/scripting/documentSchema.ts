/**
 * JSON Schema of the OpenAnimator document (schemaVersion 9) — the generation
 * contract for tools and LLMs that produce `document.json` payloads. The
 * schema mirrors the structural validation in `document.ts`
 * (`isAnimatorDocument`/`isSceneNode`); documents are always re-validated
 * structurally after schema validation, so schema validation can never be
 * the only gate. Validate LLM output against this schema, feed the errors
 * back to the model (validate-and-retry), then apply it through
 * `migrateDocument` (which performs the final deep validation).
 *
 * Scene nodes are defined once with `if/then` branches per node kind — the
 * `allOf`+`additionalProperties` ref pattern would wrongly reject inherited
 * base fields. `sceneNodeSchema` is shared with the scripting command schema
 * (which relaxes the base-field requirements so scripts can omit ids and
 * sizes and receive defaults).
 */

export interface Vec2 {
  x: number
  y: number
}

export const EASING_VALUES = ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const

/** Maximum number of colors in the document palette. */
export const MAX_PALETTE_COLORS = 48

/** Maximum number of entries in a stroke dash pattern. */
export const MAX_STROKE_DASH_VALUES = 16

/** Hex color pattern accepted by the document and command contracts. */
export const HEX_COLOR_PATTERN = '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'

/** Tween channel names of per-property easing overrides. */
export const TWEEN_CHANNELS = ['transform', 'opacity', 'fill'] as const

/** Shared non-null easing definition: a named easing or a closed cubic
 * bezier. Used by the document contract and the command contract. */
export function easingSchema(): Record<string, unknown> {
  return {
    anyOf: [
      { enum: [...EASING_VALUES] },
      {
        type: 'object',
        additionalProperties: false,
        required: ['x1', 'y1', 'x2', 'y2'],
        properties: {
          x1: { type: 'number', minimum: 0, maximum: 1 },
          y1: { type: 'number' },
          x2: { type: 'number', minimum: 0, maximum: 1 },
          y2: { type: 'number' }
        }
      }
    ]
  }
}

/** Shared gradient paint definition: one strict linear or radial shape, 2–8
 * stops with 0..1 offsets, hex colors and an optional 0..1 opacity; unknown
 * fields are rejected. */
export function gradientPaintSchema(): Record<string, unknown> {
  const stop = {
    type: 'object',
    additionalProperties: false,
    required: ['offset', 'color'],
    properties: {
      offset: { type: 'number', minimum: 0, maximum: 1 },
      color: { type: 'string', pattern: HEX_COLOR_PATTERN },
      alpha: { type: 'number', minimum: 0, maximum: 1 }
    }
  }
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'angle', 'stops'],
        properties: {
          type: { const: 'linear' },
          angle: { type: 'number' },
          stops: { type: 'array', minItems: 2, maxItems: 8, items: stop }
        }
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'cx', 'cy', 'r', 'stops'],
        properties: {
          type: { const: 'radial' },
          cx: { type: 'number' },
          cy: { type: 'number' },
          r: { type: 'number' },
          stops: { type: 'array', minItems: 2, maxItems: 8, items: stop }
        }
      }
    ]
  }
}

/** Shared paint reference: a flat color string or a gradient object. */
export function paintSchema(): Record<string, unknown> {
  return {
    oneOf: [{ type: 'string', minLength: 1 }, gradientPaintSchema()]
  }
}

/** Shared per-channel tween easing overrides: only the channel keys, each a
 * non-null easing; any subset of the channels may be present. */
export function tweenEasingsSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(TWEEN_CHANNELS.map((channel) => [channel, easingSchema()]))
  }
}

/** Shared palette definition: up to 48 hex colors. */
export function paletteSchema(): Record<string, unknown> {
  return {
    type: 'array',
    maxItems: MAX_PALETTE_COLORS,
    items: { type: 'string', pattern: HEX_COLOR_PATTERN }
  }
}

/** Shared embedded-font definition: one subset stored as a document
 * resource. */
export function embeddedFontSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'family', 'weight', 'resourceId', 'glyphs', 'license'],
    properties: {
      id: { type: 'string', minLength: 1 },
      family: { type: 'string', minLength: 1 },
      weight: { type: 'number', minimum: 1, maximum: 1000 },
      italic: { type: 'boolean' },
      resourceId: { type: 'string', minLength: 1 },
      glyphs: { type: 'array', items: { type: 'string' } },
      license: { type: 'string' }
    }
  }
}

const NODE_BASE_FIELDS = {
  id: { type: 'string', minLength: 1 },
  name: { type: 'string' },
  center: { $ref: '#/definitions/vec2' },
  width: { type: 'number', minimum: 0 },
  height: { type: 'number', minimum: 0 },
  rotation: { type: 'number' },
  opacity: { type: 'number', minimum: 0, maximum: 1 }
} as const

const NODE_KIND_BRANCHES = [
  {
    if: { properties: { type: { const: 'primitive' } }, required: ['type'] },
    then: { required: ['primitive', 'fill'] }
  },
  {
    if: { properties: { type: { const: 'path' } }, required: ['type'] },
    then: { required: ['d'] }
  },
  {
    if: { properties: { type: { const: 'text' } }, required: ['type'] },
    then: { required: ['text', 'fontFamily', 'fontSize', 'fontWeight', 'fill', 'align'] }
  },
  {
    if: { properties: { type: { const: 'image' } }, required: ['type'] },
    then: { required: ['resourceId', 'naturalWidth', 'naturalHeight', 'smoothing'] }
  },
  {
    if: { properties: { type: { const: 'group' } }, required: ['type'] },
    then: { required: ['children'] }
  },
  {
    if: { properties: { type: { const: 'symbol' } }, required: ['type'] },
    then: { required: ['assetId'] }
  }
] as const

/** Scene-node schema shared by the document contract (`requireBase: true`)
 * and the command contract (`requireBase: false`). */
export function sceneNodeSchema(requireBase: boolean): Record<string, unknown> {
  const required: string[] = ['type']
  if (requireBase) required.push('id', 'center', 'width', 'height', 'rotation', 'opacity')
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties: {
      type: { enum: ['primitive', 'path', 'text', 'image', 'group', 'symbol'] },
      ...NODE_BASE_FIELDS,
      primitive: { enum: ['rect', 'ellipse'] },
      fill: { $ref: '#/definitions/paint' },
      stroke: { $ref: '#/definitions/paint' },
      strokeWidth: { type: 'number', minimum: 0 },
      d: { type: 'string', minLength: 1 },
      text: { type: 'string' },
      fontFamily: { type: 'string' },
      fontSize: { type: 'number', exclusiveMinimum: 0 },
      fontWeight: { type: 'number', minimum: 1, maximum: 1000 },
      align: { enum: ['left', 'center', 'right'] },
      fontStyle: { enum: ['normal', 'italic'] },
      ligatures: { type: 'boolean' },
      letterSpacing: { type: 'number' },
      lineHeight: { type: 'number', minimum: 0.5, maximum: 5 },
      verticalAlign: { enum: ['top', 'middle', 'bottom'] },
      fontFallback: { type: 'array', maxItems: 8, items: { type: 'string' } },
      strokeLinecap: { enum: ['butt', 'round', 'square'] },
      strokeLinejoin: { enum: ['miter', 'round', 'bevel'] },
      strokeDasharray: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_STROKE_DASH_VALUES,
        items: { type: 'number', minimum: 0 },
        // At least one dash must be positive (draft-07 `contains`), matching
        // the core `isStrokeDasharray` and the hand-rolled validator.
        contains: { type: 'number', exclusiveMinimum: 0 }
      },
      strokeDashoffset: { type: 'number' },
      resourceId: { type: 'string' },
      naturalWidth: { type: 'number', minimum: 1 },
      naturalHeight: { type: 'number', minimum: 1 },
      smoothing: { type: 'boolean' },
      children: { type: 'array', items: { $ref: '#/definitions/sceneNode' } },
      assetId: { type: 'string' }
    },
    allOf: NODE_KIND_BRANCHES
  }
}

export const DOCUMENT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://github.com/DidierHoarau/OpenAnimator/document-v9.json',
  title: 'OpenAnimator document (v9)',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'name', 'width', 'height', 'fps', 'background', 'layers', 'assets', 'palette', 'fonts'],
  properties: {
    schemaVersion: { const: 9 },
    name: { type: 'string', minLength: 1 },
    width: { type: 'number', exclusiveMinimum: 0 },
    height: { type: 'number', exclusiveMinimum: 0 },
    fps: { type: 'number', exclusiveMinimum: 0 },
    background: { type: 'string' },
    frames: { type: 'integer', minimum: 1 },
    holdStep: { type: 'integer', minimum: 1, maximum: 16 },
    layers: { type: 'array', items: { $ref: '#/definitions/layer' } },
    assets: { type: 'array', items: { $ref: '#/definitions/asset' } },
    palette: { $ref: '#/definitions/palette' },
    fonts: { type: 'array', items: { $ref: '#/definitions/embeddedFont' } }
  },
  definitions: {
    vec2: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' } }
    },
    easing: easingSchema(),
    tweenEasings: tweenEasingsSchema(),
    paint: paintSchema(),
    palette: paletteSchema(),
    embeddedFont: embeddedFontSchema(),
    sceneNode: sceneNodeSchema(true),
    keyframe: {
      type: 'object',
      additionalProperties: false,
      required: ['frame', 'nodes'],
      properties: {
        frame: { type: 'integer', minimum: 0 },
        nodes: { type: 'array', items: { $ref: '#/definitions/sceneNode' } },
        tween: {
          type: 'object',
          additionalProperties: false,
          required: ['easing'],
          properties: {
            easing: { $ref: '#/definitions/easing' },
            easings: { $ref: '#/definitions/tweenEasings' },
            path: { enum: ['linear', 'smooth'] }
          }
        }
      }
    },
    objectLayer: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id', 'name', 'visible', 'locked', 'keyframes'],
      properties: {
        kind: { const: 'object' },
        id: { type: 'string', minLength: 1 },
        name: { type: 'string' },
        visible: { type: 'boolean' },
        locked: { type: 'boolean' },
        keyframes: { type: 'array', items: { $ref: '#/definitions/keyframe' }, minItems: 1 }
      }
    },
    drawingLayer: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id', 'name', 'visible', 'locked', 'resolutionScale', 'cells'],
      properties: {
        kind: { const: 'drawing' },
        id: { type: 'string', minLength: 1 },
        name: { type: 'string' },
        visible: { type: 'boolean' },
        locked: { type: 'boolean' },
        resolutionScale: { type: 'number', exclusiveMinimum: 0 },
        cells: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['frame', 'resourceId'],
            properties: {
              frame: { type: 'integer', minimum: 0 },
              resourceId: { type: 'string' }
            }
          }
        }
      }
    },
    cameraPose: {
      type: 'object',
      additionalProperties: false,
      required: ['center', 'zoom', 'rotation'],
      properties: {
        center: { $ref: '#/definitions/vec2' },
        zoom: { type: 'number', exclusiveMinimum: 0 },
        rotation: { type: 'number' }
      }
    },
    cameraKeyframe: {
      type: 'object',
      additionalProperties: false,
      required: ['frame', 'pose'],
      properties: {
        frame: { type: 'integer', minimum: 0 },
        pose: { $ref: '#/definitions/cameraPose' },
        tween: {
          type: 'object',
          additionalProperties: false,
          required: ['easing'],
          properties: {
            easing: { $ref: '#/definitions/easing' },
            path: { enum: ['linear', 'smooth'] }
          }
        }
      }
    },
    cameraLayer: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id', 'name', 'visible', 'locked', 'keyframes'],
      properties: {
        kind: { const: 'camera' },
        id: { type: 'string', minLength: 1 },
        name: { type: 'string' },
        visible: { type: 'boolean' },
        locked: { type: 'boolean' },
        keyframes: { type: 'array', items: { $ref: '#/definitions/cameraKeyframe' } }
      }
    },
    audioLayer: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id', 'name', 'visible', 'locked', 'resourceId', 'startFrame', 'volume'],
      properties: {
        kind: { const: 'audio' },
        id: { type: 'string', minLength: 1 },
        name: { type: 'string' },
        visible: { type: 'boolean' },
        locked: { type: 'boolean' },
        resourceId: { type: 'string', minLength: 1 },
        startFrame: { type: 'integer', minimum: 0 },
        volume: { type: 'number', minimum: 0, maximum: 1 }
      }
    },
    layer: {
      oneOf: [
        { $ref: '#/definitions/objectLayer' },
        { $ref: '#/definitions/drawingLayer' },
        { $ref: '#/definitions/cameraLayer' },
        { $ref: '#/definitions/audioLayer' }
      ]
    },
    asset: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name', 'kind', 'createdAt'],
      properties: {
        id: { type: 'string', minLength: 1 },
        name: { type: 'string' },
        kind: { enum: ['symbol', 'image'] },
        content: { $ref: '#/definitions/sceneNode' },
        resourceId: { type: 'string' },
        naturalWidth: { type: 'number', minimum: 1 },
        naturalHeight: { type: 'number', minimum: 1 },
        createdAt: { type: 'number' }
      }
    }
  }
} as const
