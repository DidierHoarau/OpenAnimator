import { COMMANDS_SCHEMA, OP_FIELDS, OPS } from './commands'
import type { FieldSpec, Op } from './commands'
import { SCRIPT_EXAMPLES } from './examples'

/**
 * Generates `docs/scripting-reference.md` from the same data that validates
 * and executes commands: the op list (`OPS`), the field table (`OP_FIELDS`,
 * mirrored from `COMMANDS_SCHEMA`) and the runnable examples. Only the
 * one-line human summaries below are hand-written; fields, types, bounds and
 * enums are machine-derived, so the published reference cannot drift from the
 * schema (a unit test compares the committed file with this generator).
 */

/** One-line summary per op. Typed as a full record so adding an op without a
 * description fails `npm run typecheck`. */
const OP_SUMMARIES: Record<Op, string> = {
  addLayer: 'Add a layer (`object`, `drawing`, `camera` or `audio`) and select it; an explicit `layerId` is applied when it is still free (script replay).',
  renameLayer: 'Rename an existing layer.',
  removeLayer: 'Delete a layer and everything on it.',
  addNode: 'Add a scene node (primitive, path, text, image, group or symbol) to a layer, optionally at a frame.',
  updateNode: 'Patch node properties (position, size, rotation, opacity, colors, text, ...); at a frame on a keyed node this sets a keyframe.',
  deleteNode: 'Delete a node from its layer.',
  setKeyframe: 'Insert or update a keyframe: applies a patch at a frame and/or creates an empty keyframe.',
  removeNodeKeyframe: 'Remove the keyframe of a node at a frame.',
  setTween: 'Set the interpolation (easing / motion path) of a node or camera keyframe.',
  moveKeyframe: 'Move the keyframe at `fromFrame` to `toFrame`.',
  copyKeyframes: 'Copy the keyframe range `fromFrame`..`toFrame` so it starts at `targetFrame`.',
  setHoldStep: 'Quantize hand-drawn strokes to every N-th frame (turn N-1 frames into holds).',
  setCell: 'Set the drawing cell of a drawing layer at a frame (exposures).',
  setDuration: 'Change the document duration in frames.',
  setFps: 'Change the document frame rate.',
  setPalette: 'Replace the color palette (1–48 `#rgb`/`#rrggbb` colors).',
  seek: 'Move the playhead to a frame.',
  setCameraKeyframe: 'Set a camera keyframe (pan/zoom/rotate) at a frame.',
  removeCameraKeyframe: 'Remove the camera keyframe at a frame.',
  setAudio: 'Adjust an audio layer: start frame, volume, mute.',
  group: 'Group nodes into a group node (one undo entry).',
  ungroup: 'Dissolve a group node, lifting its children back into the layer.',
  breakApart: 'Break a symbol instance back into plain nodes (drifts from the symbol).',
  createSymbol: 'Create a symbol asset from nodes and replace them with an instance.',
  placeAsset: 'Place an instance of a symbol asset on a layer, optionally at a position.',
  editSymbol: 'Enter symbol edit mode for an asset (the stage shows the symbol contents).',
  endSymbolEdit: 'Leave symbol edit mode, committing or discarding the changes.',
  renameAsset: 'Rename a symbol asset.',
  duplicateAsset: 'Duplicate a symbol asset (instances of the copy are independent).',
  deleteAsset: 'Delete a symbol asset; existing instances become placeholders.',
  saveToLibrary: 'Save a symbol asset to the global My Library.',
  insertFromLibrary: 'Insert an asset from the global My Library (`assetId` or exact `name`) onto a layer.',
  insertFrames: 'Insert `count` hold frames at a frame, shifting later content.',
  removeFrames: 'Remove `count` frames at a frame, pulling later content back.',
  moveCell: 'Move the drawing cell at `fromFrame` to `toFrame`.',
  moveNodeToFrame: 'Retime a node: move its whole keyframe track so it starts at `targetFrame`.',
  duplicateNodes: 'Duplicate the currently selected nodes at +10/+10 (one undo entry).',
  align: 'Align the selected objects to their union bounds (`left`, `centerH`, `right`, `top`, `middle`, `bottom`; needs at least two objects).',
  distribute: 'Space the selected objects evenly along `h` or `v` (outermost two fixed; needs at least three objects).',
  setPreferences: 'Merge a partial preferences patch (sanitized and persisted) into the application settings.',
  setPathAnchors: 'Replace the full anchor/subpath geometry of a path node (one undo entry; covers add, move, remove and corner/smooth toggles).',
  export: 'Export the document to a file in the given format.',
  importImage: 'Import an image file and add it as a node on a layer.',
  importAudio: 'Import an audio file and add it as an audio layer.',
  setOnionSkin: 'Toggle onion skinning and set the number of ghost frames shown before/after the playhead.',
  setBrush: 'Set the brush color, size and stroke opacity.',
  setGlobalPalette: 'Replace the global (cross-document) color palette (1–48 `#rgb`/`#rrggbb` colors).',
  addGlobalPaletteColor: 'Append one color to the global palette (rejected when it is already there or full).'
}

const FIELD_TYPES: Record<FieldSpec['type'], string> = {
  string: 'string',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  object: 'object',
  array: 'array'
}

function fieldConstraints(spec: FieldSpec): string[] {
  const notes: string[] = []
  if (spec.enum && spec.enum.length > 0) {
    notes.push(`one of ${spec.enum.map((value) => `\`${value}\``).join(', ')}`)
  }
  if (spec.nullable) notes.push('may be `null`')
  if (spec.bezier) notes.push('string or cubic-bezier object `{x1,y1,x2,y2}`')
  if (spec.paint) notes.push('color, gradient object or `none`')
  if (spec.tweenEasings) {
    notes.push('per-channel overrides `{transform,opacity,fill}`: named easing, cubic-bezier object or `null` to clear')
  }
  if (spec.hexColors) notes.push('`#rgb`/`#rrggbb` strings')
  if (spec.stringItems) notes.push('strings')
  if (spec.type === 'array') {
    if (spec.minItems !== undefined) notes.push(`at least ${spec.minItems} item${spec.minItems === 1 ? '' : 's'}`)
    if (spec.maxItems !== undefined) notes.push(`at most ${spec.maxItems} items`)
  }
  if (spec.min !== undefined) notes.push(`min ${spec.min}`)
  if (spec.exclusiveMin !== undefined) notes.push(`greater than ${spec.exclusiveMin}`)
  if (spec.max !== undefined) notes.push(`max ${spec.max}`)
  return notes
}

function renderFields(fields: Record<string, FieldSpec>): string {
  const names = Object.keys(fields)
  if (names.length === 0) return '_No fields._\n'
  const lines = ['| Field | Type | Required | Notes |', '| --- | --- | --- | --- |']
  for (const name of names) {
    const spec = fields[name]
    const notes = fieldConstraints(spec)
    lines.push(
      `| \`${name}\` | ${FIELD_TYPES[spec.type]} | ${spec.required ? 'yes' : 'no'} | ${
        notes.length > 0 ? notes.join('; ') : '—'
      } |`
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * Field kinds common to every command; kept here so the reference can
 * describe conventions once instead of in every op table.
 */
const SHARED_FIELD_NOTES = [
  ['`layerId`', 'target layer; the executor falls back to the current layer and warns.'],
  ['`frame`', '0-based frame; defaults to the playhead and the executor warns.'],
  ['`at`', 'stage position `{x,y}` for placed assets.'],
  ['`nodeIds`', 'non-empty list of node ids on the target layer.'],
  ['`patch`', 'partial node update: only known fields, unknown ones are rejected; optional fields may be `null` to clear them.']
] as const

/** Renders the complete scripting reference as deterministic Markdown. */
export function renderScriptingReference(): string {
  const schema = COMMANDS_SCHEMA as unknown as {
    definitions: { command: { properties: { op: { enum: readonly string[] } } } }
  }
  const schemaOps = schema.definitions.command.properties.op.enum
  if (schemaOps.length !== OPS.length) {
    throw new Error(
      `OPS and COMMANDS_SCHEMA are out of sync (${OPS.length} vs ${schemaOps.length} ops)`
    )
  }
  for (let i = 0; i < OPS.length; i++) {
    if (schemaOps[i] !== OPS[i]) {
      throw new Error(`Op ${i} differs: schema has "${schemaOps[i]}", OPS has "${OPS[i]}"`)
    }
  }

  let out = '# Scripting command reference\n\n'
  out +=
    '> Generated from `COMMANDS_SCHEMA` and the field metadata in `src/shared/scripting/commands.ts` — do not edit by hand.\n' +
    '> Run `npm run docs:build` after changing the schema.\n\n'
  out +=
    'A script is a JSON object `{ "commands": [ ... ] }`. Commands run in order through the\n' +
    'same editor pipeline as UI gestures (one undo entry per command) and each command is the\n' +
    '`op` plus the fields below. Unknown ops, missing required fields and extra fields are\n' +
    'rejected before anything runs.\n\n'
  out += `Machine-readable schema: \`commands-v1.json\` (export it with \`npm run cli -- schema --kind commands\`).\n\n`

  out += '## Commands at a glance\n\n'
  for (const op of OPS) {
    out += `- [\`${op}\`](#${op.toLowerCase()}) — ${OP_SUMMARIES[op]}\n`
  }
  out += '\n'

  out += '## Conventions\n\n'
  for (const [field, note] of SHARED_FIELD_NOTES) {
    out += `- ${field}: ${note}\n`
  }
  out +=
    '- Created or chosen ids are reported back as warnings so a model can chain later commands.\n' +
    '- Colors accept `#rgb`/`#rrggbb` or a gradient object; see `paint` in the schema for the exact shape.\n\n'

  out += '## Command details\n\n'
  for (const op of OPS) {
    out += `### ${op}\n\n${OP_SUMMARIES[op]}\n\n`
    out += renderFields(OP_FIELDS[op])
    out += '\n'
  }

  out += '## Examples\n\n'
  out += 'Every example below is a complete payload that runs against a fresh 960x540 document.\n'
  out += 'The script console ships the same list in its example picker.\n\n'
  for (const example of SCRIPT_EXAMPLES) {
    out += `### ${example.name}\n\n${example.description}\n\n`
    out +=
      '```json\n' +
      JSON.stringify({ commands: example.commands }, null, 2) +
      '\n```\n\n'
  }

  return out
}
