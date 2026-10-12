# Scripting OpenAnimator

OpenAnimator exposes a JSON command API for driving the editor
programmatically — the intended client is an LLM agent or an automation
script. Scripts run through the exact same pipeline as UI gestures: the same
validation, the same undo entries, the same auto-keyframe behavior. There is
no second code path that could desync from the application.

## The command payload

A payload is `{"commands": [...]}`. Commands are applied in order; each one
is atomic (one undo entry) and reports a per-command outcome:

- **applied** — the command mutated the document.
- **warning** — a best-effort outcome, e.g. a clamped `seek` or a defaulted
  node field. The command may still count as applied.
- **error** — the command did nothing; later commands still run.

Every issue carries the command `index` and a message, designed to be fed
straight back to a model for a validate-and-retry loop.

## Running a payload

- **In the app:** toolbar → **Script…**. Paste or generate the payload,
  *Validate* to see schema errors, *Run* to execute. Both validation errors
  and execution issues are shown inline.
- **Headless:** `npm run cli -- validate payload.json` checks the schema
  (exit 1 with ajv messages on failure). See [CLI](#headless-cli) below.

## Command reference

All commands accept optional `layerId` where a layer context is needed; when
omitted the executor resolves it from the node or falls back to the current
layer. Frames are 0-based.

| Command | Fields | Behavior |
| --- | --- | --- |
| `addLayer` | `kind?` (`object`\|`drawing`), `name?` | Appends a layer at the bottom and selects it. |
| `renameLayer` | `layerId`, `name` | Renames a layer. |
| `removeLayer` | `layerId` | Removes a layer. |
| `addNode` | `node`, `layerId?`, `frame?` | Adds a scene node with auto-key at the frame. |
| `updateNode` | `nodeId`, `layerId?`, `frame?`, `patch` | Auto-keys a pose at the frame, then applies the patch. This is how you animate: one `updateNode` per pose. |
| `deleteNode` | `nodeId`, `layerId?` | Removes the node from the layer. |
| `setKeyframe` | `nodeId`, `layerId?`, `frame?`, `patch?` | Ensures the node has its own pose at the frame, optionally patching it. Warns if a pose already exists there. |
| `removeNodeKeyframe` | `nodeId`, `layerId?`, `frame?` | Removes the node's own pose at the frame. |
| `setTween` | `layerId?`, `frame?`, `easing`, `path?` | Turns a classic tween on the keyframe at `frame` on/off (`easing: null` removes it). Easings: `linear`, `ease-in`, `ease-out`, `ease-in-out`, or a custom cubic bezier `{x1, y1, x2, y2}` (x ∈ 0..1). `path: 'smooth'` swings the tweened center along a curve through the neighbouring poses; `'linear'` (default) keeps it straight. |
| `moveKeyframe` | `nodeId`, `layerId?`, `fromFrame`, `toFrame` | Moves the node's own pose from one frame to another (the timeline drag). Keyframes emptied by the move are dropped; the destination keeps its tween. |
| `copyKeyframes` | `nodeId`, `layerId?`, `fromFrame`, `toFrame?`, `targetFrame` | Copies the node's poses in `[fromFrame, toFrame]` (default: `fromFrame` only) to `targetFrame + offset`, merging into existing keyframes; a copied tween is restored only where none exists. |
| `setHoldStep` | `step` (1–16) | Sets the non-destructive hold step: playback, onion skinning and export evaluate every frame at `frame - frame % step` ("animation on n's"). `1` turns it off. |
| `setCell` | `layerId?`, `frame?`, `resourceId` | Places a raster cell on a drawing layer. |
| `setDuration` | `frames` | Sets the authored timeline length. |
| `setFps` | `fps` | Sets frames per second. |
| `setPalette` | `colors` | Replaces the document palette with up to 48 hex colors (`#rgb`/`#rrggbb`); entries are normalized, deduplicated and invalid ones dropped (warned). |
| `seek` | `frame` | Moves the playhead (warnings when clamped). |

### Node kinds

`primitive` (with `primitive: 'rect' | 'ellipse'` and `fill`), `path`
(SVG path data in `d`), `text` (needs `text`, `fontFamily`, `fontSize`,
`fontWeight`, `fill`, `align`), `image` (needs `resourceId` and natural
sizes), `group` (with `children`), `symbol` (with `assetId`).

Base fields (`id`, `center`, `width`, `height`, `rotation`, `opacity`,
`name`) are optional in scripts: omitted fields are defaulted (center =
stage center, size 100x100, opaque) and reported as warnings so the model
sees exactly what was chosen. Explicit values are preferred.

The `patch` of `updateNode` accepts the whitelisted node fields (`name`,
`center`, `width`, `height`, `rotation`, `opacity`, `fill`, `stroke`,
`strokeWidth`, `d`, and the text fields); unknown fields are rejected by the
schema, never silently ignored.

### Paint values (fill / stroke)

Every `fill` and `stroke` is a **paint**: either a flat color string
(`#rrggbb`, `#rgb`, `none`) or a gradient object with 2–8 stops:

```json
{"op": "updateNode", "nodeId": "n1", "patch": {
  "fill": {"type": "linear", "angle": 90,
           "stops": [{"offset": 0, "color": "#f59e0b"},
                     {"offset": 1, "color": "#7c2d12"}]}}}
```

- **linear** — `type`, `angle` (degrees, 0 = left→right, positive clockwise),
  `stops`.
- **radial** — `type`, `cx`, `cy`, `r` (fractions of the node's bounding box,
  so the paint survives resizes), `stops`.
- A stop is `{"offset": 0..1, "color": "#rrggbb"}`. Offsets need not be
  sorted (the renderer sorts them); colors must be hex.

Gradients interpolate when tweening between two poses that use the same
gradient type and stop count; any mismatch snaps at the last frame (same
behavior as unparseable solid colors). Unknown gradient fields are rejected
by both the JSON Schema and the renderer validator.

## Validate-and-retry loop

1. **Generate** a payload against the schema
   (`src/shared/scripting/commands.ts` — `COMMANDS_SCHEMA`, JSON Schema
   draft-07; the document contract lives in `documentSchema.ts`).
2. **Validate** — `validateScriptPayload(payload)` returns
   `{ commands, errors }`; ajv errors carry JSON pointers (`/commands/3/op`).
3. **Execute** — `executeScriptCommands(editor, commands)` (renderer) returns
   `{ applied, issues }`.
4. **Repair** — feed `errors` and `issues` back with the payload; the
   messages name the command index and the reason.

The same loop works without a running editor via the CLI `validate` command.

## Examples

Three complete payloads ship in `src/shared/scripting/examples.ts` and are
loadable in the script console:

- **Bouncing ball** — a layer, an ellipse, poses at frames 0/11/23 via
  `updateNode`, tweens with `ease-in` (fall) and `ease-out` (rise).
- **Title card fade-in** — a text node at `opacity: 0` tweened linearly to
  `opacity: 1`.
- **Retimed slide** — a custom bezier tween with `path: 'smooth'`, a middle
  pose retimed with `moveKeyframe`, and `setHoldStep: 2` playback on twos.

## Headless CLI

`npm run cli -- <command>` (or `npx openanimator` after install):

```
render <project.oanim|document.json> --out out.gif
    [--format png-sequence|gif|webm|mp4] [--scale 0.25..4] [--fps 1..60]
    [--from N] [--to N] [--transparent]
validate <payload.json> [--kind commands|document]
```

- `render` evaluates frames through the same shared SVG path as the in-app
  exporter, rasterizes with resvg, and encodes with the shared GIF /
  PNG-sequence encoders. `webm`/`mp4` require `ffmpeg` on PATH (WebCodecs is
  browser-only). `png-sequence` writes a ZIP of per-frame PNGs.
- `validate` prints schema errors and exits 1 on an invalid payload — the
  machine surface for CI checks and LLM tooling.

## Safety

Scripts only touch the open document through the editor's public mutation
methods — no filesystem, network or Electron access, no `eval`. The CLI
reads the file you pass it and writes the file you name. Anything a script
can do can be undone step by step (`Ctrl+Z`).
