import Ajv, { type ValidateFunction } from 'ajv'

import { DOCUMENT_SCHEMA, EASING_VALUES, easingSchema, sceneNodeSchema } from './documentSchema'

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
  | { op: 'addLayer'; kind?: 'object' | 'drawing'; name?: string }
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
  | { op: 'seek'; frame: number }

/** One validation or application outcome, designed to be fed back to a model. */
export interface ScriptIssue {
  index: number
  message: string
  severity: 'error' | 'warning'
}

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
    easing: easingSchema(),
    /** setTween's easing also accepts null, which turns the tween off. */
    tweenEasing: { anyOf: [{ $ref: '#/definitions/easing' }, { type: 'null' }] },
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
        fill: { type: 'string' },
        stroke: { type: 'string' },
        strokeWidth: { type: 'number', minimum: 0 },
        d: { type: 'string' },
        text: { type: 'string' },
        fontFamily: { type: 'string' },
        fontSize: { type: 'number', exclusiveMinimum: 0 },
        fontWeight: { type: 'number', minimum: 1, maximum: 1000 },
        align: { enum: ['left', 'center', 'right'] }
      }
    },
    frameNumber: { type: 'integer', minimum: 0 },
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
            'seek'
          ]
        },
        kind: { enum: ['object', 'drawing'] },
        name: { type: 'string' },
        layerId: { type: 'string' },
        nodeId: { type: 'string' },
        node: { $ref: '#/definitions/sceneNode' },
        patch: { $ref: '#/definitions/nodePatch' },
        frame: { $ref: '#/definitions/frameNumber' },
        fromFrame: { $ref: '#/definitions/frameNumber' },
        toFrame: { $ref: '#/definitions/frameNumber' },
        targetFrame: { $ref: '#/definitions/frameNumber' },
        step: { type: 'integer', minimum: 1, maximum: 16 },
        path: { enum: ['linear', 'smooth'] },
        resourceId: { type: 'string' },
        frames: { type: 'integer', minimum: 1 },
        fps: { type: 'number', exclusiveMinimum: 0 },
        easing: { $ref: '#/definitions/tweenEasing' }
      },
      allOf: [
        {
          if: { properties: { op: { const: 'addLayer' } }, required: ['op'] },
          then: { additionalProperties: false, properties: { op: {}, kind: {}, name: {} } }
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
          if: { properties: { op: { const: 'seek' } }, required: ['op'] },
          then: { required: ['frame'], additionalProperties: false, properties: { op: {}, frame: {} } }
        }
      ]
    }
  }
} as const

/** Field shape table mirrored from `COMMANDS_SCHEMA.definitions.command`. */
interface FieldSpec {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object'
  required?: boolean
  min?: number
  max?: number
  exclusiveMin?: number
  enum?: readonly string[]
  nullable?: boolean
  /** String field that may also be a closed cubic bezier object. */
  bezier?: boolean
}

const OPS = [
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
  'seek'
] as const

const OP_FIELDS: Record<(typeof OPS)[number], Record<string, FieldSpec>> = {
  addLayer: {
    kind: { type: 'string', enum: ['object', 'drawing'] },
    name: { type: 'string' }
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
  seek: { frame: { type: 'integer', min: 0, required: true } }
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

/** Per-kind extra fields; the values are required when the kind matches. */
const NODE_KIND_FIELDS: Record<string, Record<string, FieldSpec>> = {
  primitive: {
    primitive: { type: 'string', enum: ['rect', 'ellipse'], required: true },
    fill: { type: 'string', required: true },
    stroke: { type: 'string' },
    strokeWidth: { type: 'number', min: 0 }
  },
  path: { d: { type: 'string', required: true }, fill: { type: 'string' }, stroke: { type: 'string' }, strokeWidth: { type: 'number', min: 0 } },
  text: {
    text: { type: 'string', required: true },
    fontFamily: { type: 'string', required: true },
    fontSize: { type: 'number', exclusiveMin: 0, required: true },
    fontWeight: { type: 'number', min: 1, max: 1000, required: true },
    fill: { type: 'string', required: true },
    align: { type: 'string', enum: ['left', 'center', 'right'], required: true }
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
  fill: { type: 'string' },
  stroke: { type: 'string' },
  strokeWidth: { type: 'number', min: 0 },
  d: { type: 'string' },
  text: { type: 'string' },
  fontFamily: { type: 'string' },
  fontSize: { type: 'number', exclusiveMin: 0 },
  fontWeight: { type: 'number', min: 1, max: 1000 },
  align: { type: 'string', enum: ['left', 'center', 'right'] }
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
    if (path.endsWith('/center')) checkVec2(collector, path, value)
    else if (path.endsWith('/node')) validateSceneNode(collector, path, value)
    else if (path.endsWith('/patch')) validateNodePatch(collector, path, value)
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
