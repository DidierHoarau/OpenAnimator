/**
 * JSON Schema of the OpenAnimator document (schemaVersion 4) — the generation
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
      fill: { type: 'string' },
      stroke: { type: 'string' },
      strokeWidth: { type: 'number', minimum: 0 },
      d: { type: 'string', minLength: 1 },
      text: { type: 'string' },
      fontFamily: { type: 'string' },
      fontSize: { type: 'number', exclusiveMinimum: 0 },
      fontWeight: { type: 'number', minimum: 1, maximum: 1000 },
      align: { enum: ['left', 'center', 'right'] },
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
  $id: 'https://github.com/DidierHoarau/OpenAnimator/document-v4.json',
  title: 'OpenAnimator document (v4)',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'name', 'width', 'height', 'fps', 'background', 'layers', 'assets'],
  properties: {
    schemaVersion: { const: 4 },
    name: { type: 'string', minLength: 1 },
    width: { type: 'number', exclusiveMinimum: 0 },
    height: { type: 'number', exclusiveMinimum: 0 },
    fps: { type: 'number', exclusiveMinimum: 0 },
    background: { type: 'string' },
    frames: { type: 'integer', minimum: 1 },
    holdStep: { type: 'integer', minimum: 1, maximum: 16 },
    layers: { type: 'array', items: { $ref: '#/definitions/layer' } },
    assets: { type: 'array', items: { $ref: '#/definitions/asset' } }
  },
  definitions: {
    vec2: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' } }
    },
    easing: easingSchema(),
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
    layer: {
      oneOf: [{ $ref: '#/definitions/objectLayer' }, { $ref: '#/definitions/drawingLayer' }]
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
