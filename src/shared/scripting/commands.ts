import Ajv, { type ValidateFunction } from 'ajv'

import { ALIGN_MODES, DISTRIBUTE_AXES, type AlignMode, type DistributeAxis } from '../align'
import { parseHexColor } from '../color'
import { MAX_GRADIENT_STOPS, MIN_GRADIENT_STOPS } from '../paint'
import { DEFAULT_PREFERENCES, type AppPreferences } from '../preferences'
import {
  DOCUMENT_SCHEMA,
  EASING_VALUES,
  easingSchema,
  gradientPaintSchema,
  HEX_COLOR_PATTERN,
  MAX_PALETTE_COLORS,
  MAX_STROKE_DASH_VALUES,
  paintSchema,
  sceneNodeSchema
} from './documentSchema'

/**
 * The scripting command contract: a JSON list of atomic commands applied in
 * order through the same editor pipeline as UI gestures (one undo entry per
 * command, identical validation). This is the machine surface for LLMs —
 * validate the payload here, apply it through `executeScriptCommands`, and
 * feed the returned issues back to the model (validate-and-retry).
 *
 * Defaults are deliberately generous (ids, sizes and frames may be omitted):
 * the executor fills them in and reports what it chose as warnings, so a
 * model gets actionable feedback instead of hard failures.
 *
 * The renderer validates payloads with the hand-rolled `validateScriptPayload`
 * below, NOT ajv: ajv compiles schemas with `new Function`, which the app's
 * CSP (`script-src 'self'`) forbids — a top-level ajv compile crashes the
 * renderer at boot. `COMMANDS_SCHEMA` stays the machine-readable contract for
 * external tooling, and the validator is kept in sync with it by tests.
 */

export type ScriptCommand =
  | {
      op: 'addLayer'
      kind?: 'object' | 'drawing' | 'camera' | 'audio'
      name?: string
      /** Required for `kind: 'audio'` (an existing session resource). */
      resourceId?: string
      startFrame?: number
    }
  | { op: 'renameLayer'; layerId: string; name: string }
  | { op: 'removeLayer'; layerId: string }
  | { op: 'addNode'; node: Record<string, unknown>; layerId?: string; frame?: number }
  | { op: 'updateNode'; nodeId: string; layerId?: string; frame?: number; patch: Record<string, unknown> }
  | { op: 'deleteNode'; nodeId: string; layerId?: string }
  | { op: 'setKeyframe'; nodeId: string; layerId?: string; frame?: number; patch?: Record<string, unknown> }
  | { op: 'removeNodeKeyframe'; nodeId: string; layerId?: string; frame?: number }
  | {
      op: 'setTween'
      layerId?: string
      frame?: number
      easing?: string | null | { x1: number; y1: number; x2: number; y2: number }
      path?: 'linear' | 'smooth'
    }
  | { op: 'moveKeyframe'; nodeId: string; layerId?: string; fromFrame: number; toFrame: number }
  | { op: 'copyKeyframes'; nodeId: string; layerId?: string; fromFrame: number; toFrame?: number; targetFrame: number }
  | { op: 'setHoldStep'; step: number }
  | { op: 'setCell'; layerId?: string; frame?: number; resourceId: string }
  | { op: 'setDuration'; frames: number }
  | { op: 'setFps'; fps: number }
  | { op: 'setPalette'; colors: string[] }
  | { op: 'seek'; frame: number }
  | {
      op: 'setCameraKeyframe'
      frame: number
      center?: { x: number; y: number }
      zoom?: number
      rotation?: number
      /** When given, ensures (true) or removes (false) the tween on the keyframe. */
      tween?: boolean
    }
  | { op: 'removeCameraKeyframe'; frame: number }
  | { op: 'setAudio'; layerId: string; startFrame?: number; volume?: number; muted?: boolean }
  | { op: 'group'; nodeIds: string[]; layerId?: string; frame?: number }
  | { op: 'ungroup'; nodeIds: string[]; layerId?: string; frame?: number }
  | { op: 'breakApart'; nodeId: string; layerId?: string; frame?: number }
  | { op: 'createSymbol'; nodeIds: string[]; layerId?: string; frame?: number; name?: string }
  | {
      op: 'placeAsset'
      assetId: string
      layerId?: string
      frame?: number
      at?: { x: number; y: number }
    }
  | { op: 'editSymbol'; assetId: string }
  | { op: 'endSymbolEdit'; commit: boolean }
  | { op: 'renameAsset'; assetId: string; name: string }
  | { op: 'duplicateAsset'; assetId: string }
  | { op: 'deleteAsset'; assetId: string }
  | { op: 'saveToLibrary'; assetId: string }
  | {
      op: 'insertFromLibrary'
      assetId?: string
      name?: string
      layerId?: string
      frame?: number
      at?: { x: number; y: number }
    }
  | { op: 'insertFrames'; layerId?: string; frame?: number; count?: number }
  | { op: 'removeFrames'; layerId?: string; frame?: number; count?: number }
  | { op: 'moveCell'; layerId?: string; fromFrame: number; toFrame: number }
  | { op: 'moveNodeToFrame'; nodeId: string; targetFrame: number; layerId?: string }
  | { op: 'duplicateNodes' }
  | { op: 'align'; mode: AlignMode }
  | { op: 'distribute'; axis: DistributeAxis }
  | { op: 'setPreferences'; preferences: Partial<AppPreferences> }
  | {
      op: 'setPathAnchors'
      nodeId: string
      layerId?: string
      frame?: number
      /** Full replacement subpath/anchor list (covers add, move, remove and
       * corner/smooth toggles in one undo step). */
      subpaths: ScriptSubpath[]
    }

/** One editable subpath of a `setPathAnchors` command. */
export interface ScriptSubpath {
  closed: boolean
  anchors: ScriptPathAnchor[]
}

/** One anchor of a `setPathAnchors` command; handles are offsets from the
 * anchor point, exactly like the model's `PathAnchor`. */
export interface ScriptPathAnchor {
  x: number
  y: number
  in?: { x: number; y: number }
  out?: { x: number; y: number }
}

/** One validation or application outcome, designed to be fed back to a model. */
export interface ScriptIssue {
  index: number
  message: string
  severity: 'error' | 'warning'
}

/**
 * JSON-schema shape of a preferences patch, derived from the defaults so the
 * schema tracks new preference keys automatically (ranges are clamped by the
 * store's sanitizer, so the schema only pins the primitive type).
 */
const PREFERENCE_PATCH_PROPERTIES = Object.fromEntries(
  Object.entries(DEFAULT_PREFERENCES).map(([key, value]) => [
    key,
    { type: typeof value === 'boolean' ? 'boolean' : 'number' }
  ])
) as Record<string, { type: 'boolean' | 'number' }>

export const COMMANDS_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://github.com/DidierHoarau/OpenAnimator/commands-v1.json',
  title: 'OpenAnimator script commands (v1)',
  type: 'object',
  additionalProperties: false,
  required: ['commands'],
  properties: {
    commands: { type: 'array', minItems: 1, items: { $ref: '#/definitions/command' } }
  },
  definitions: {
    vec2: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' } }
    },
    /** One editable path anchor (setPathAnchors). */
    pathAnchor: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        in: { $ref: '#/definitions/vec2' },
        out: { $ref: '#/definitions/vec2' }
      }
    },
    /** One editable subpath (setPathAnchors). */
    anchorSubpath: {
      type: 'object',
      additionalProperties: false,
      required: ['anchors', 'closed'],
      properties: {
        closed: { type: 'boolean' },
        anchors: { type: 'array', minItems: 2, items: { $ref: '#/definitions/pathAnchor' } }
      }
    },
    anchorSubpaths: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/definitions/anchorSubpath' }
    },
    easing: easingSchema(),
    /** setTween's easing also accepts null, which turns the tween off. */
    tweenEasing: { anyOf: [{ $ref: '#/definitions/easing' }, { type: 'null' }] },
    /** Paint value of fill/stroke fields: a flat color or a strict gradient. */
    paint: paintSchema(),
    gradientPaint: gradientPaintSchema(),
    sceneNode: sceneNodeSchema(false),
    /** Loose structural patch of a node: only known fields, no deep shape. */
    nodePatch: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        center: { $ref: '#/definitions/vec2' },
        width: { type: 'number', minimum: 0 },
        height: { type: 'number', minimum: 0 },
        rotation: { type: 'number' },
        opacity: { type: 'number', minimum: 0, maximum: 1 },
        fill: { $ref: '#/definitions/paint' },
        stroke: { $ref: '#/definitions/paint' },
        strokeWidth: { type: 'number', minimum: 0 },
        d: { type: 'string' },
        text: { type: 'string' },
        fontFamily: { type: 'string' },
        fontSize: { type: 'number', exclusiveMinimum: 0 },
        fontWeight: { type: 'number', minimum: 1, maximum: 1000 },
        align: { enum: ['left', 'center', 'right'] },
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
          contains: { type: 'number', exclusiveMinimum: 0 }
        },
        strokeDashoffset: { type: 'number' }
      }
    },
    frameNumber: { type: 'integer', minimum: 0 },
    /** Non-empty list of node ids (group-style commands). */
    stringList: { type: 'array', minItems: 1, items: { type: 'string' } },
    /** Partial preferences patch; unknown keys are rejected. */
    preferencesPatch: {
      type: 'object',
      additionalProperties: false,
      properties: PREFERENCE_PATCH_PROPERTIES
    },
    command: {
      type: 'object',
      required: ['op'],
      properties: {
        op: {
          enum: [
            'addLayer',
            'renameLayer',
            'removeLayer',
            'addNode',
            'updateNode',
            'deleteNode',
            'setKeyframe',
            'removeNodeKeyframe',
            'setTween',
            'moveKeyframe',
            'copyKeyframes',
            'setHoldStep',
            'setCell',
            'setDuration',
            'setFps',
            'setPalette',
            'seek',
            'setCameraKeyframe',
            'removeCameraKeyframe',
            'setAudio',
            'group',
            'ungroup',
            'breakApart',
            'createSymbol',
            'placeAsset',
            'editSymbol',
            'endSymbolEdit',
            'renameAsset',
            'duplicateAsset',
            'deleteAsset',
            'saveToLibrary',
            'insertFromLibrary',
            'insertFrames',
            'removeFrames',
            'moveCell',
            'moveNodeToFrame',
            'duplicateNodes',
            'align',
            'distribute',
            'setPreferences',
            'setPathAnchors'
          ]
        },
        kind: { enum: ['object', 'drawing', 'camera', 'audio'] },
        name: { type: 'string' },
        layerId: { type: 'string' },
        nodeId: { type: 'string' },
        nodeIds: { $ref: '#/definitions/stringList' },
        assetId: { type: 'string' },
        node: { $ref: '#/definitions/sceneNode' },
        patch: { $ref: '#/definitions/nodePatch' },
        frame: { $ref: '#/definitions/frameNumber' },
        fromFrame: { $ref: '#/definitions/frameNumber' },
        toFrame: { $ref: '#/definitions/frameNumber' },
        targetFrame: { $ref: '#/definitions/frameNumber' },
        startFrame: { $ref: '#/definitions/frameNumber' },
        step: { type: 'integer', minimum: 1, maximum: 16 },
        count: { type: 'integer', minimum: 1, maximum: 999 },
        commit: { type: 'boolean' },
        at: { $ref: '#/definitions/vec2' },
        path: { enum: ['linear', 'smooth'] },
        resourceId: { type: 'string' },
        frames: { type: 'integer', minimum: 1 },
        fps: { type: 'number', exclusiveMinimum: 0 },
        center: { $ref: '#/definitions/vec2' },
        zoom: { type: 'number', exclusiveMinimum: 0 },
        rotation: { type: 'number' },
        tween: { type: 'boolean' },
        volume: { type: 'number', minimum: 0, maximum: 1 },
        muted: { type: 'boolean' },
        colors: {
          type: 'array',
          maxItems: MAX_PALETTE_COLORS,
          items: { type: 'string', pattern: HEX_COLOR_PATTERN }
        },
        easing: { $ref: '#/definitions/tweenEasing' },
        mode: { enum: ALIGN_MODES },
        axis: { enum: DISTRIBUTE_AXES },
        subpaths: { $ref: '#/definitions/anchorSubpaths' },
        preferences: { $ref: '#/definitions/preferencesPatch' }
      },
      allOf: [
        {
          if: { properties: { op: { const: 'addLayer' } }, required: ['op'] },
          then: {
            additionalProperties: false,
            properties: { op: {}, kind: {}, name: {}, resourceId: {}, startFrame: {} }
          }
        },
        {
          if: {
            properties: { op: { const: 'addLayer' }, kind: { const: 'audio' } },
            required: ['op', 'kind']
          },
          then: { required: ['resourceId'] }
        },
        {
          if: { properties: { op: { const: 'renameLayer' } }, required: ['op'] },
          then: { required: ['layerId', 'name'], additionalProperties: false, properties: { op: {}, layerId: {}, name: {} } }
        },
        {
          if: { properties: { op: { const: 'removeLayer' } }, required: ['op'] },
          then: { required: ['layerId'], additionalProperties: false, properties: { op: {}, layerId: {} } }
        },
        {
          if: { properties: { op: { const: 'addNode' } }, required: ['op'] },
          then: { required: ['node'], additionalProperties: false, properties: { op: {}, node: {}, layerId: {}, frame: {} } }
        },
        {
          if: { properties: { op: { const: 'updateNode' } }, required: ['op'] },
          then: { required: ['nodeId', 'patch'], additionalProperties: false, properties: { op: {}, nodeId: {}, layerId: {}, frame: {}, patch: {} } }
        },
        {
          if: { properties: { op: { const: 'deleteNode' } }, required: ['op'] },
          then: { required: ['nodeId'], additionalProperties: false, properties: { op: {}, nodeId: {}, layerId: {} } }
        },
        {
          if: { properties: { op: { const: 'setKeyframe' } }, required: ['op'] },
          then: { required: ['nodeId'], additionalProperties: false, properties: { op: {}, nodeId: {}, layerId: {}, frame: {}, patch: {} } }
        },
        {
          if: { properties: { op: { const: 'removeNodeKeyframe' } }, required: ['op'] },
          then: { required: ['nodeId'], additionalProperties: false, properties: { op: {}, nodeId: {}, layerId: {}, frame: {} } }
        },
        {
          if: { properties: { op: { const: 'setTween' } }, required: ['op'] },
          then: {
            additionalProperties: false,
            properties: {
              op: {},
              layerId: {},
              frame: {},
              easing: { $ref: '#/definitions/tweenEasing' },
              path: { enum: ['linear', 'smooth'] }
            }
          }
        },
        {
          if: { properties: { op: { const: 'moveKeyframe' } }, required: ['op'] },
          then: {
            required: ['nodeId', 'fromFrame', 'toFrame'],
            additionalProperties: false,
            properties: { op: {}, nodeId: {}, layerId: {}, fromFrame: {}, toFrame: {} }
          }
        },
        {
          if: { properties: { op: { const: 'copyKeyframes' } }, required: ['op'] },
          then: {
            required: ['nodeId', 'fromFrame', 'targetFrame'],
            additionalProperties: false,
            properties: { op: {}, nodeId: {}, layerId: {}, fromFrame: {}, toFrame: {}, targetFrame: {} }
          }
        },
        {
          if: { properties: { op: { const: 'setHoldStep' } }, required: ['op'] },
          then: { required: ['step'], additionalProperties: false, properties: { op: {}, step: {} } }
        },
        {
          if: { properties: { op: { const: 'setCell' } }, required: ['op'] },
          then: { required: ['resourceId'], additionalProperties: false, properties: { op: {}, layerId: {}, frame: {}, resourceId: {} } }
        },
        {
          if: { properties: { op: { const: 'setDuration' } }, required: ['op'] },
          then: { required: ['frames'], additionalProperties: false, properties: { op: {}, frames: {} } }
        },
        {
          if: { properties: { op: { const: 'setFps' } }, required: ['op'] },
          then: { required: ['fps'], additionalProperties: false, properties: { op: {}, fps: {} } }
        },
        {
          if: { properties: { op: { const: 'setPalette' } }, required: ['op'] },
          then: { required: ['colors'], additionalProperties: false, properties: { op: {}, colors: {} } }
        },
        {
          if: { properties: { op: { const: 'seek' } }, required: ['op'] },
          then: { required: ['frame'], additionalProperties: false, properties: { op: {}, frame: {} } }
        },
        {
          if: { properties: { op: { const: 'setCameraKeyframe' } }, required: ['op'] },
          then: {
            required: ['frame'],
            additionalProperties: false,
            properties: { op: {}, frame: {}, center: {}, zoom: {}, rotation: {}, tween: {} }
          }
        },
        {
          if: { properties: { op: { const: 'removeCameraKeyframe' } }, required: ['op'] },
          then: { required: ['frame'], additionalProperties: false, properties: { op: {}, frame: {} } }
        },
        {
          if: { properties: { op: { const: 'setAudio' } }, required: ['op'] },
          then: {
            required: ['layerId'],
            additionalProperties: false,
            properties: { op: {}, layerId: {}, startFrame: {}, volume: {}, muted: {} }
          }
        },
        {
          if: { properties: { op: { const: 'group' } }, required: ['op'] },
          then: {
            required: ['nodeIds'],
            additionalProperties: false,
            properties: { op: {}, nodeIds: {}, layerId: {}, frame: {} }
          }
        },
        {
          if: { properties: { op: { const: 'ungroup' } }, required: ['op'] },
          then: {
            required: ['nodeIds'],
            additionalProperties: false,
            properties: { op: {}, nodeIds: {}, layerId: {}, frame: {} }
          }
        },
        {
          if: { properties: { op: { const: 'breakApart' } }, required: ['op'] },
          then: {
            required: ['nodeId'],
            additionalProperties: false,
            properties: { op: {}, nodeId: {}, layerId: {}, frame: {} }
          }
        },
        {
          if: { properties: { op: { const: 'createSymbol' } }, required: ['op'] },
          then: {
            required: ['nodeIds'],
            additionalProperties: false,
            properties: { op: {}, nodeIds: {}, layerId: {}, frame: {}, name: {} }
          }
        },
        {
          if: { properties: { op: { const: 'placeAsset' } }, required: ['op'] },
          then: {
            required: ['assetId'],
            additionalProperties: false,
            properties: { op: {}, assetId: {}, layerId: {}, frame: {}, at: {} }
          }
        },
        {
          if: { properties: { op: { const: 'editSymbol' } }, required: ['op'] },
          then: {
            required: ['assetId'],
            additionalProperties: false,
            properties: { op: {}, assetId: {} }
          }
        },
        {
          if: { properties: { op: { const: 'endSymbolEdit' } }, required: ['op'] },
          then: {
            required: ['commit'],
            additionalProperties: false,
            properties: { op: {}, commit: {} }
          }
        },
        {
          if: { properties: { op: { const: 'renameAsset' } }, required: ['op'] },
          then: {
            required: ['assetId', 'name'],
            additionalProperties: false,
            properties: { op: {}, assetId: {}, name: {} }
          }
        },
        {
          if: { properties: { op: { const: 'duplicateAsset' } }, required: ['op'] },
          then: {
            required: ['assetId'],
            additionalProperties: false,
            properties: { op: {}, assetId: {} }
          }
        },
        {
          if: { properties: { op: { const: 'deleteAsset' } }, required: ['op'] },
          then: {
            required: ['assetId'],
            additionalProperties: false,
            properties: { op: {}, assetId: {} }
          }
        },
        {
          if: { properties: { op: { const: 'saveToLibrary' } }, required: ['op'] },
          then: {
            required: ['assetId'],
            additionalProperties: false,
            properties: { op: {}, assetId: {} }
          }
        },
        {
          if: { properties: { op: { const: 'insertFromLibrary' } }, required: ['op'] },
          then: {
            anyOf: [{ required: ['assetId'] }, { required: ['name'] }],
            additionalProperties: false,
            properties: { op: {}, assetId: {}, name: {}, layerId: {}, frame: {}, at: {} }
          }
        },
        {
          if: { properties: { op: { const: 'insertFrames' } }, required: ['op'] },
          then: {
            additionalProperties: false,
            properties: { op: {}, layerId: {}, frame: {}, count: {} }
          }
        },
        {
          if: { properties: { op: { const: 'removeFrames' } }, required: ['op'] },
          then: {
            additionalProperties: false,
            properties: { op: {}, layerId: {}, frame: {}, count: {} }
          }
        },
        {
          if: { properties: { op: { const: 'moveCell' } }, required: ['op'] },
          then: {
            required: ['fromFrame', 'toFrame'],
            additionalProperties: false,
            properties: { op: {}, layerId: {}, fromFrame: {}, toFrame: {} }
          }
        },
        {
          if: { properties: { op: { const: 'moveNodeToFrame' } }, required: ['op'] },
          then: {
            required: ['nodeId', 'targetFrame'],
            additionalProperties: false,
            properties: { op: {}, nodeId: {}, layerId: {}, targetFrame: {} }
          }
        },
        {
          if: { properties: { op: { const: 'duplicateNodes' } }, required: ['op'] },
          then: { additionalProperties: false, properties: { op: {} } }
        },
        {
          if: { properties: { op: { const: 'align' } }, required: ['op'] },
          then: {
            required: ['mode'],
            additionalProperties: false,
            properties: { op: {}, mode: {} }
          }
        },
        {
          if: { properties: { op: { const: 'distribute' } }, required: ['op'] },
          then: {
            required: ['axis'],
            additionalProperties: false,
            properties: { op: {}, axis: {} }
          }
        },
        {
          if: { properties: { op: { const: 'setPreferences' } }, required: ['op'] },
          then: {
            required: ['preferences'],
            additionalProperties: false,
            properties: { op: {}, preferences: {} }
          }
        },
        {
          if: { properties: { op: { const: 'setPathAnchors' } }, required: ['op'] },
          then: {
            required: ['nodeId', 'subpaths'],
            additionalProperties: false,
            properties: { op: {}, nodeId: {}, layerId: {}, frame: {}, subpaths: {} }
          }
        }
      ]
    }
  }
} as const

/** Field shape table mirrored from `COMMANDS_SCHEMA.definitions.command`. */
export interface FieldSpec {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
  required?: boolean
  min?: number
  max?: number
  exclusiveMin?: number
  enum?: readonly string[]
  nullable?: boolean
  /** String field that may also be a closed cubic bezier object. */
  bezier?: boolean
  /** Field that may also be a strict gradient object (paint). */
  paint?: boolean
  /** Array items must be `#rgb`/`#rrggbb` strings. */
  hexColors?: boolean
  /** Array items must be strings (the item shape of loose string lists). */
  stringItems?: boolean
  /** Array items must be finite numbers ≥ 0 with at least one > 0 (stroke
   * dash patterns). */
  numberItems?: boolean
  /** Array items are editable subpath objects (setPathAnchors). */
  pathSubpaths?: boolean
  minItems?: number
  maxItems?: number
}

export const OPS = [
  'addLayer',
  'renameLayer',
  'removeLayer',
  'addNode',
  'updateNode',
  'deleteNode',
  'setKeyframe',
  'removeNodeKeyframe',
  'setTween',
  'moveKeyframe',
  'copyKeyframes',
  'setHoldStep',
  'setCell',
  'setDuration',
  'setFps',
  'setPalette',
  'seek',
  'setCameraKeyframe',
  'removeCameraKeyframe',
  'setAudio',
  'group',
  'ungroup',
  'breakApart',
  'createSymbol',
  'placeAsset',
  'editSymbol',
  'endSymbolEdit',
  'renameAsset',
  'duplicateAsset',
  'deleteAsset',
  'saveToLibrary',
  'insertFromLibrary',
  'insertFrames',
  'removeFrames',
  'moveCell',
  'moveNodeToFrame',
  'duplicateNodes',
  'align',
  'distribute',
  'setPreferences',
  'setPathAnchors'
] as const

/** One scripting op name. */
export type Op = (typeof OPS)[number]

export const OP_FIELDS: Record<Op, Record<string, FieldSpec>> = {
  addLayer: {
    kind: { type: 'string', enum: ['object', 'drawing', 'camera', 'audio'] },
    name: { type: 'string' },
    resourceId: { type: 'string' },
    startFrame: { type: 'integer', min: 0 }
  },
  renameLayer: {
    layerId: { type: 'string', required: true },
    name: { type: 'string', required: true }
  },
  removeLayer: { layerId: { type: 'string', required: true } },
  addNode: {
    node: { type: 'object', required: true },
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 }
  },
  updateNode: {
    nodeId: { type: 'string', required: true },
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 },
    patch: { type: 'object', required: true }
  },
  deleteNode: { nodeId: { type: 'string', required: true }, layerId: { type: 'string' } },
  setKeyframe: {
    nodeId: { type: 'string', required: true },
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 },
    patch: { type: 'object' }
  },
  removeNodeKeyframe: {
    nodeId: { type: 'string', required: true },
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 }
  },
  setTween: {
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 },
    easing: { type: 'string', enum: EASING_VALUES, nullable: true, bezier: true },
    path: { type: 'string', enum: ['linear', 'smooth'] }
  },
  moveKeyframe: {
    nodeId: { type: 'string', required: true },
    layerId: { type: 'string' },
    fromFrame: { type: 'integer', min: 0, required: true },
    toFrame: { type: 'integer', min: 0, required: true }
  },
  copyKeyframes: {
    nodeId: { type: 'string', required: true },
    layerId: { type: 'string' },
    fromFrame: { type: 'integer', min: 0, required: true },
    toFrame: { type: 'integer', min: 0 },
    targetFrame: { type: 'integer', min: 0, required: true }
  },
  setHoldStep: { step: { type: 'integer', min: 1, max: 16, required: true } },
  setCell: {
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 },
    resourceId: { type: 'string', required: true }
  },
  setDuration: { frames: { type: 'integer', min: 1, required: true } },
  setFps: { fps: { type: 'number', exclusiveMin: 0, required: true } },
  setPalette: { colors: { type: 'array', hexColors: true, maxItems: MAX_PALETTE_COLORS, required: true } },
  seek: { frame: { type: 'integer', min: 0, required: true } },
  setCameraKeyframe: {
    frame: { type: 'integer', min: 0, required: true },
    center: { type: 'object' },
    zoom: { type: 'number', exclusiveMin: 0 },
    rotation: { type: 'number' },
    tween: { type: 'boolean' }
  },
  removeCameraKeyframe: { frame: { type: 'integer', min: 0, required: true } },
  setAudio: {
    layerId: { type: 'string', required: true },
    startFrame: { type: 'integer', min: 0 },
    volume: { type: 'number', min: 0, max: 1 },
    muted: { type: 'boolean' }
  },
  group: {
    nodeIds: { type: 'array', stringItems: true, minItems: 1, required: true },
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 }
  },
  ungroup: {
    nodeIds: { type: 'array', stringItems: true, minItems: 1, required: true },
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 }
  },
  breakApart: {
    nodeId: { type: 'string', required: true },
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 }
  },
  createSymbol: {
    nodeIds: { type: 'array', stringItems: true, minItems: 1, required: true },
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 },
    name: { type: 'string' }
  },
  placeAsset: {
    assetId: { type: 'string', required: true },
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 },
    at: { type: 'object' }
  },
  editSymbol: { assetId: { type: 'string', required: true } },
  endSymbolEdit: { commit: { type: 'boolean', required: true } },
  renameAsset: {
    assetId: { type: 'string', required: true },
    name: { type: 'string', required: true }
  },
  duplicateAsset: { assetId: { type: 'string', required: true } },
  deleteAsset: { assetId: { type: 'string', required: true } },
  saveToLibrary: { assetId: { type: 'string', required: true } },
  insertFromLibrary: {
    assetId: { type: 'string' },
    name: { type: 'string' },
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 },
    at: { type: 'object' }
  },
  insertFrames: {
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 },
    count: { type: 'integer', min: 1, max: 999 }
  },
  removeFrames: {
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 },
    count: { type: 'integer', min: 1, max: 999 }
  },
  moveCell: {
    layerId: { type: 'string' },
    fromFrame: { type: 'integer', min: 0, required: true },
    toFrame: { type: 'integer', min: 0, required: true }
  },
  moveNodeToFrame: {
    nodeId: { type: 'string', required: true },
    layerId: { type: 'string' },
    targetFrame: { type: 'integer', min: 0, required: true }
  },
  duplicateNodes: {},
  align: {
    mode: { type: 'string', enum: ALIGN_MODES, required: true }
  },
  distribute: {
    axis: { type: 'string', enum: DISTRIBUTE_AXES, required: true }
  },
  setPreferences: {
    preferences: { type: 'object', required: true }
  },
  setPathAnchors: {
    nodeId: { type: 'string', required: true },
    layerId: { type: 'string' },
    frame: { type: 'integer', min: 0 },
    subpaths: { type: 'array', pathSubpaths: true, minItems: 1, required: true }
  }
}

/** Base node fields every scene node may carry (relaxed: all optional). */
const NODE_BASE_FIELDS: Record<string, FieldSpec> = {
  id: { type: 'string' },
  name: { type: 'string' },
  center: { type: 'object' },
  width: { type: 'number', min: 0 },
  height: { type: 'number', min: 0 },
  rotation: { type: 'number' },
  opacity: { type: 'number', min: 0, max: 1 }
}

/** Optional stroke-style fields shared by every stroked node kind and by
 * node patches (linecap/linejoin/dash pattern/dash offset). */
const STROKE_STYLE_FIELDS: Record<string, FieldSpec> = {
  strokeLinecap: { type: 'string', enum: ['butt', 'round', 'square'] },
  strokeLinejoin: { type: 'string', enum: ['miter', 'round', 'bevel'] },
  strokeDasharray: {
    type: 'array',
    numberItems: true,
    minItems: 1,
    maxItems: MAX_STROKE_DASH_VALUES
  },
  strokeDashoffset: { type: 'number' }
}

/** Per-kind extra fields; the values are required when the kind matches. */
const NODE_KIND_FIELDS: Record<string, Record<string, FieldSpec>> = {
  primitive: {
    primitive: { type: 'string', enum: ['rect', 'ellipse'], required: true },
    fill: { type: 'string', paint: true, required: true },
    stroke: { type: 'string', paint: true },
    strokeWidth: { type: 'number', min: 0 },
    ...STROKE_STYLE_FIELDS
  },
  path: {
    d: { type: 'string', required: true },
    fill: { type: 'string', paint: true },
    stroke: { type: 'string', paint: true },
    strokeWidth: { type: 'number', min: 0 },
    ...STROKE_STYLE_FIELDS
  },
  text: {
    text: { type: 'string', required: true },
    fontFamily: { type: 'string', required: true },
    fontSize: { type: 'number', exclusiveMin: 0, required: true },
    fontWeight: { type: 'number', min: 1, max: 1000, required: true },
    fill: { type: 'string', paint: true, required: true },
    align: { type: 'string', enum: ['left', 'center', 'right'], required: true },
    letterSpacing: { type: 'number' },
    lineHeight: { type: 'number', min: 0.5, max: 5 },
    stroke: { type: 'string', paint: true },
    strokeWidth: { type: 'number', min: 0 },
    verticalAlign: { type: 'string', enum: ['top', 'middle', 'bottom'] },
    fontFallback: { type: 'array', stringItems: true, maxItems: 8 },
    ...STROKE_STYLE_FIELDS
  },
  image: {
    resourceId: { type: 'string', required: true },
    naturalWidth: { type: 'number', min: 1, required: true },
    naturalHeight: { type: 'number', min: 1, required: true },
    smoothing: { type: 'boolean', required: true }
  },
  group: { children: { type: 'object', required: true } },
  symbol: { assetId: { type: 'string', required: true } }
}

const NODE_PATCH_FIELDS: Record<string, FieldSpec> = {
  name: { type: 'string' },
  center: { type: 'object' },
  width: { type: 'number', min: 0 },
  height: { type: 'number', min: 0 },
  rotation: { type: 'number' },
  opacity: { type: 'number', min: 0, max: 1 },
  fill: { type: 'string', paint: true },
  stroke: { type: 'string', paint: true },
  strokeWidth: { type: 'number', min: 0 },
  d: { type: 'string' },
  text: { type: 'string' },
  fontFamily: { type: 'string' },
  fontSize: { type: 'number', exclusiveMin: 0 },
  fontWeight: { type: 'number', min: 1, max: 1000 },
  align: { type: 'string', enum: ['left', 'center', 'right'] },
  letterSpacing: { type: 'number' },
  lineHeight: { type: 'number', min: 0.5, max: 5 },
  verticalAlign: { type: 'string', enum: ['top', 'middle', 'bottom'] },
  fontFallback: { type: 'array', stringItems: true, maxItems: 8 },
  ...STROKE_STYLE_FIELDS
}

class Collector {
  readonly errors: string[] = []
  at(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`)
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function checkField(collector: Collector, path: string, spec: FieldSpec, value: unknown): void {
  if (value === null && spec.nullable) return
  const kind = describeType(value)
  if (spec.bezier && kind === 'object') {
    checkBezierEasing(collector, path, value)
    return
  }
  if (spec.paint) {
    if (kind === 'string') {
      if ((value as string).trim().length === 0) collector.at(path, 'must not be empty')
      return
    }
    if (kind === 'object') {
      checkGradientPaint(collector, path, value)
      return
    }
    collector.at(path, `must be a color string or gradient object (got ${kind})`)
    return
  }
  if (spec.type === 'array') {
    if (kind !== 'array') {
      collector.at(path, `must be array (got ${kind})`)
      return
    }
    const items = value as unknown[]
    if (spec.minItems !== undefined && items.length < spec.minItems) {
      collector.at(path, `must have at least ${spec.minItems} item${spec.minItems === 1 ? '' : 's'}`)
    }
    if (spec.maxItems !== undefined && items.length > spec.maxItems) {
      collector.at(path, `must have at most ${spec.maxItems} items`)
    }
    if (spec.hexColors) {
      items.forEach((item, index) => {
        if (typeof item !== 'string' || parseHexColor(item) === null) {
          collector.at(`${path}/${index}`, 'must be a hex color (#rgb or #rrggbb)')
        }
      })
    }
    if (spec.stringItems) {
      items.forEach((item, index) => {
        if (typeof item !== 'string') {
          collector.at(`${path}/${index}`, 'must be string')
        }
      })
    }
    if (spec.numberItems) {
      items.forEach((item, index) => {
        if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) {
          collector.at(`${path}/${index}`, 'must be a number >= 0')
        }
      })
      if (
        items.length > 0 &&
        !items.some((item) => typeof item === 'number' && Number.isFinite(item) && item > 0)
      ) {
        collector.at(path, 'must not be all zeros')
      }
    }
    if (spec.pathSubpaths) {
      checkPathSubpaths(collector, path, items)
    }
    return
  }
  if (spec.type === 'boolean') {
    if (kind !== 'boolean') collector.at(path, 'must be boolean')
    return
  }
  if (spec.type === 'string') {
    if (kind !== 'string') {
      collector.at(path, `must be string (got ${kind})`)
      return
    }
    if (spec.enum && !spec.enum.includes(value as string)) {
      collector.at(path, `must be one of ${spec.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
    }
    return
  }
  if (spec.type === 'object') {
    if (kind !== 'object') {
      collector.at(path, `must be object (got ${kind})`)
      return
    }
    if (path.endsWith('/center') || path.endsWith('/at')) checkVec2(collector, path, value)
    else if (path.endsWith('/node')) validateSceneNode(collector, path, value)
    else if (path.endsWith('/patch')) validateNodePatch(collector, path, value)
    else if (path.endsWith('/preferences')) checkPreferencesPatch(collector, path, value)
    return
  }
  if (kind !== 'number') {
    collector.at(path, `must be ${spec.type === 'integer' ? 'integer' : 'number'} (got ${kind})`)
    return
  }
  const number = value as number
  if (!Number.isFinite(number)) {
    collector.at(path, 'must be a finite number')
    return
  }
  if (spec.type === 'integer' && !Number.isInteger(number)) {
    collector.at(path, 'must be an integer')
    return
  }
  if (spec.exclusiveMin !== undefined && number <= spec.exclusiveMin) {
    collector.at(path, `must be > ${spec.exclusiveMin}`)
  }
  if (spec.min !== undefined && number < spec.min) {
    collector.at(path, `must be >= ${spec.min}`)
  }
  if (spec.max !== undefined && number > spec.max) {
    collector.at(path, `must be <= ${spec.max}`)
  }
}

function checkVec2(collector: Collector, path: string, value: unknown): void {
  const vec = value as Record<string, unknown>
  for (const key of ['x', 'y'] as const) {
    if (typeof vec[key] !== 'number') collector.at(`${path}/${key}`, 'must be number')
  }
  for (const key of Object.keys(vec)) {
    if (key !== 'x' && key !== 'y') collector.at(`${path}/${key}`, 'must not have additional properties')
  }
}

/** Closed cubic bezier `{x1,y1,x2,y2}`: finite numbers, control-point x ∈ [0,1]. */
function checkBezierEasing(collector: Collector, path: string, value: unknown): void {
  const bezier = value as Record<string, unknown>
  for (const key of ['x1', 'y1', 'x2', 'y2'] as const) {
    const entry = bezier[key]
    if (entry === undefined) {
      collector.at(`${path}/${key}`, 'is required')
      continue
    }
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      collector.at(`${path}/${key}`, 'must be number')
      continue
    }
    if ((key === 'x1' || key === 'x2') && (entry < 0 || entry > 1)) {
      collector.at(`${path}/${key}`, 'must be >= 0 and <= 1')
    }
  }
  for (const key of Object.keys(bezier)) {
    if (key !== 'x1' && key !== 'y1' && key !== 'x2' && key !== 'y2') {
      collector.at(`${path}/${key}`, 'must not have additional properties')
    }
  }
}

function checkGradientNumber(collector: Collector, path: string, value: unknown): void {
  if (value === undefined) {
    collector.at(path, 'is required')
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    collector.at(path, 'must be number')
  }
}

function checkGradientStop(collector: Collector, path: string, value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    collector.at(path, 'must be object')
    return
  }
  const stop = value as Record<string, unknown>
  const offset = stop.offset
  if (offset === undefined) collector.at(`${path}/offset`, 'is required')
  else if (typeof offset !== 'number' || !Number.isFinite(offset)) {
    collector.at(`${path}/offset`, 'must be number')
  } else if (offset < 0 || offset > 1) {
    collector.at(`${path}/offset`, 'must be >= 0 and <= 1')
  }
  const color = stop.color
  if (color === undefined) collector.at(`${path}/color`, 'is required')
  else if (typeof color !== 'string' || parseHexColor(color) === null) {
    collector.at(`${path}/color`, 'must be a hex color (#rgb or #rrggbb)')
  }
  for (const key of Object.keys(stop)) {
    if (key !== 'offset' && key !== 'color') {
      collector.at(`${path}/${key}`, 'must not have additional properties')
    }
  }
}

/** Strict gradient paint check mirroring `gradientPaintSchema`: exactly one
 * linear or radial shape, 2–8 stops with 0..1 offsets and hex colors. */
function checkGradientPaint(collector: Collector, path: string, value: unknown): void {
  const gradient = value as Record<string, unknown>
  const type = gradient.type
  if (type !== 'linear' && type !== 'radial') {
    collector.at(`${path}/type`, 'must be one of "linear", "radial"')
    return
  }
  const allowed = type === 'linear' ? ['type', 'angle', 'stops'] : ['type', 'cx', 'cy', 'r', 'stops']
  for (const key of Object.keys(gradient)) {
    if (!allowed.includes(key)) collector.at(`${path}/${key}`, 'must not have additional properties')
  }
  if (type === 'linear') {
    checkGradientNumber(collector, `${path}/angle`, gradient.angle)
  } else {
    checkGradientNumber(collector, `${path}/cx`, gradient.cx)
    checkGradientNumber(collector, `${path}/cy`, gradient.cy)
    checkGradientNumber(collector, `${path}/r`, gradient.r)
  }
  const stops = gradient.stops
  if (stops === undefined) {
    collector.at(`${path}/stops`, 'is required')
    return
  }
  if (!Array.isArray(stops)) {
    collector.at(`${path}/stops`, 'must be array')
    return
  }
  if (stops.length < MIN_GRADIENT_STOPS || stops.length > MAX_GRADIENT_STOPS) {
    collector.at(
      `${path}/stops`,
      `must have between ${MIN_GRADIENT_STOPS} and ${MAX_GRADIENT_STOPS} items`
    )
  }
  stops.forEach((stop, index) => checkGradientStop(collector, `${path}/stops/${index}`, stop))
}

/** Strict `setPathAnchors` subpath list: each subpath carries a closed flag
 * and at least two anchors with finite `x`/`y` and optional `in`/`out`
 * handle offsets. */
function checkPathSubpaths(collector: Collector, path: string, items: unknown[]): void {
  items.forEach((entry, index) => {
    const subpathPath = `${path}/${index}`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      collector.at(subpathPath, 'must be object')
      return
    }
    const subpath = entry as Record<string, unknown>
    if (typeof subpath.closed !== 'boolean') collector.at(`${subpathPath}/closed`, 'must be boolean')
    const anchors = subpath.anchors
    if (!Array.isArray(anchors)) {
      collector.at(`${subpathPath}/anchors`, 'must be array')
    } else {
      if (anchors.length < 2) collector.at(`${subpathPath}/anchors`, 'must have at least 2 items')
      anchors.forEach((anchor, anchorIndex) => {
        checkPathAnchor(collector, `${subpathPath}/anchors/${anchorIndex}`, anchor)
      })
    }
    for (const key of Object.keys(subpath)) {
      if (key !== 'closed' && key !== 'anchors') {
        collector.at(`${subpathPath}/${key}`, 'must not have additional properties')
      }
    }
  })
}

function checkPathAnchor(collector: Collector, path: string, value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    collector.at(path, 'must be object')
    return
  }
  const anchor = value as Record<string, unknown>
  for (const key of ['x', 'y'] as const) {
    const entry = anchor[key]
    if (entry === undefined) collector.at(`${path}/${key}`, 'is required')
    else if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      collector.at(`${path}/${key}`, 'must be number')
    }
  }
  for (const key of ['in', 'out'] as const) {
    const entry = anchor[key]
    if (entry === undefined) continue
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      collector.at(`${path}/${key}`, 'must be object')
      continue
    }
    checkVec2(collector, `${path}/${key}`, entry)
  }
  for (const key of Object.keys(anchor)) {
    if (key !== 'x' && key !== 'y' && key !== 'in' && key !== 'out') {
      collector.at(`${path}/${key}`, 'must not have additional properties')
    }
  }
}

function validateSceneNodes(collector: Collector, path: string, value: unknown): void {
  if (!Array.isArray(value)) {
    collector.at(path, 'must be array')
    return
  }
  value.forEach((child, index) => validateSceneNode(collector, `${path}/${index}`, child))
}

function validateSceneNode(collector: Collector, path: string, value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    collector.at(path, 'must be object')
    return
  }
  const node = value as Record<string, unknown>
  const type = node.type
  if (typeof type !== 'string' || !NODE_KIND_FIELDS[type]) {
    collector.at(`${path}/type`, `must be one of ${Object.keys(NODE_KIND_FIELDS).join(', ')}`)
    return
  }
  const allowed = { ...NODE_BASE_FIELDS, ...NODE_KIND_FIELDS[type] }
  for (const [key, spec] of Object.entries(allowed)) {
    const child = node[key]
    if (child === undefined) {
      if (spec.required) collector.at(`${path}/${key}`, 'is required')
      continue
    }
    if (key === 'children') {
      validateSceneNodes(collector, `${path}/children`, child)
      continue
    }
    checkField(collector, `${path}/${key}`, spec, child)
  }
  for (const key of Object.keys(node)) {
    if (key !== 'type' && !(key in allowed)) {
      collector.at(`${path}/${key}`, 'must not have additional properties')
    }
  }
}

function validateNodePatch(collector: Collector, path: string, value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    collector.at(path, 'must be object')
    return
  }
  const patch = value as Record<string, unknown>
  for (const [key, child] of Object.entries(patch)) {
    const spec = NODE_PATCH_FIELDS[key]
    if (!spec) {
      collector.at(`${path}/${key}`, 'must not have additional properties')
      continue
    }
    checkField(collector, `${path}/${key}`, spec, child)
  }
}

/** Partial preferences patch: known keys with the matching primitive type.
 * Out-of-range values are left to the store's clamping sanitizer. */
function checkPreferencesPatch(collector: Collector, path: string, value: unknown): void {
  const patch = value as Record<string, unknown>
  for (const [key, entry] of Object.entries(patch)) {
    const expected = PREFERENCE_PATCH_PROPERTIES[key]
    if (!expected) {
      collector.at(`${path}/${key}`, 'must not have additional properties')
      continue
    }
    if (expected.type === 'boolean') {
      if (typeof entry !== 'boolean') collector.at(`${path}/${key}`, 'must be boolean')
    } else if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      collector.at(`${path}/${key}`, 'must be a finite number')
    }
  }
}

/**
 * Schema-validates a script payload without `eval` (CSP-safe in the
 * renderer); returns the commands plus the collectable errors for the
 * validate-and-retry feedback loop. Error messages carry JSON-pointer-style
 * paths like `/commands/3/op`.
 */
export function validateScriptPayload(value: unknown): { commands: ScriptCommand[]; errors: string[] } {
  const collector = new Collector()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    collector.at('', 'payload must be an object with a "commands" array')
    return { commands: [], errors: collector.errors }
  }
  const payload = value as Record<string, unknown>
  if (!Array.isArray(payload.commands)) {
    collector.at('/commands', 'must be array with at least one command')
    return { commands: [], errors: collector.errors }
  }
  if (payload.commands.length === 0) {
    collector.at('/commands', 'must not be empty')
  }
  for (const key of Object.keys(payload)) {
    if (key !== 'commands') collector.at(`/${key}`, 'must not have additional properties')
  }
  payload.commands.forEach((entry, index) => {
    const path = `/commands/${index}`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      collector.at(path, 'must be object')
      return
    }
    const command = entry as Record<string, unknown>
    const op = command.op
    if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) {
      collector.at(`${path}/op`, `must be one of ${OPS.map((name) => JSON.stringify(name)).join(', ')}`)
      return
    }
    const fields = OP_FIELDS[op as (typeof OPS)[number]]
    for (const [key, spec] of Object.entries(fields)) {
      const child = command[key]
      if (child === undefined) {
        if (spec.required) collector.at(`${path}/${key}`, 'is required')
        continue
      }
      checkField(collector, `${path}/${key}`, spec, child)
    }
    for (const key of Object.keys(command)) {
      if (key !== 'op' && !(key in fields)) {
        collector.at(`${path}/${key}`, 'must not have additional properties')
      }
    }
    if (op === 'addLayer' && command.kind === 'audio' && command.resourceId === undefined) {
      collector.at(`${path}/resourceId`, 'is required when kind is "audio"')
    }
    if (op === 'insertFromLibrary' && command.assetId === undefined && command.name === undefined) {
      collector.at(`${path}/assetId`, 'is required (or provide "name")')
    }
  })
  if (collector.errors.length > 0) return { commands: [], errors: collector.errors }
  return { commands: payload.commands as ScriptCommand[], errors: [] }
}

let documentValidate: ValidateFunction | undefined

/**
 * Schema-validates a whole document payload (the generation contract).
 * Uses ajv lazily: only the CLI and external tooling call this — the
 * renderer validates documents through `migrateDocument`, and an eager ajv
 * compile would violate the renderer CSP.
 */
export function validateDocumentPayload(value: unknown): { valid: boolean; errors: string[] } {
  documentValidate ??= new Ajv({ allErrors: true }).compile(DOCUMENT_SCHEMA)
  const valid = documentValidate(value)
  const errors = (documentValidate.errors ?? []).map((error) => {
    const path = error.instancePath === '' ? 'payload' : error.instancePath
    return `${path}: ${error.message ?? 'is invalid'}`
  })
  return { valid, errors }
}
