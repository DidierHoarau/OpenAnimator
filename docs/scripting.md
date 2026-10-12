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

The full, always-current field-by-field table lives in
**[docs/scripting-reference.md](scripting-reference.md)** — generated from
the same `COMMANDS_SCHEMA` that validates payloads, so it cannot drift from
the implementation. The command families:

- **Document & timeline** — `addLayer`, `renameLayer`, `removeLayer`,
  `setDuration`, `setFps`, `setPalette`, `seek`, `insertFrames`,
  `removeFrames`, `setHoldStep`, `setCell`, `moveCell`.
- **Nodes & keyframes** — `addNode`, `updateNode`, `deleteNode`,
  `setKeyframe`, `removeNodeKeyframe`, `moveKeyframe`, `copyKeyframes`,
  `moveNodeToFrame`.
- **Selection, layout & preferences** — `duplicateNodes`, `align`,
  `distribute`, `setPreferences`.
- **Grouping & symbols** — `group`, `ungroup`, `breakApart`,
  `createSymbol`, `placeAsset`, `editSymbol`, `endSymbolEdit`,
  `renameAsset`, `duplicateAsset`, `deleteAsset`.
- **Camera & audio** — `setCameraKeyframe`, `removeCameraKeyframe`,
  `setAudio`.
- **Tweening** — `setTween`.

All commands accept optional `layerId` where a layer context is needed; when
omitted the executor resolves it from the node or falls back to the current
layer. Frames are 0-based.

### Grouping, symbols and the global library

`group` groups nodes into one group node; `ungroup` dissolves a group back
into its children; `breakApart` replaces a symbol instance with an editable
group (decoupled from the asset). `createSymbol` saves the selection as a
symbol asset and leaves an instance behind; `placeAsset` drops more
instances on the current layer, optionally at `{x, y}`.

`editSymbol` enters symbol edit mode (the stage shows the asset's contents,
undo works inside); `endSymbolEdit` with `commit: true` writes the changes
back into every instance, `commit: false` discards them. `renameAsset`,
`duplicateAsset` and `deleteAsset` manage document assets; deleting an asset
whose instances remain on stage warns and leaves placeholders.

`saveToLibrary` copies a symbol asset into the global **My Library** and
`insertFromLibrary` places one back (matched by `assetId` or exact `name`),
copying its resources into the document. Both commands need the app's
library bridge: the script console passes `window.api` automatically; a
headless executor without a library reports a clear error per command and
keeps running.

### Timeline frames

`insertFrames` / `removeFrames` insert or remove hold frames at a `frame`
(default: the playhead), shifting later keyframes, cells and audio clips on
every layer — the timeline's insert/remove-frame buttons as commands.
`moveCell` retimes a drawing cell and `moveNodeToFrame` shifts a node's
whole keyframe track so it starts at `targetFrame` (the retiming gestures).

### Selection, layout and preferences

`duplicateNodes` copies the current selection at +10/+10 with its keyframe
tracks intact — the Edit-menu Duplicate (`Ctrl+D`) as a command, one undo
entry. `align` snaps the selection to the union of their bounds (`mode`:
`left`, `centerH`, `right`, `top`, `middle`, `bottom`; at least two selected
objects) and `distribute` spaces three or more objects evenly along `h` or
`v` with the outermost two fixed — the Edit → Align submenu as commands.

```json
{"commands": [
  {"op": "align", "mode": "top"},
  {"op": "distribute", "axis": "h"},
  {"op": "duplicateNodes"}
]}
```

`setPreferences` merges a partial, sanitized patch into the application
settings — the same store the Preferences dialog (`Ctrl+,`) edits:

```json
{"commands": [
  {"op": "setPreferences", "preferences": {"gridSize": 32, "autosaveIdleMs": 5000}}
]}
```

Like the library bridge, `setPreferences` needs the app's preference store:
the script console passes it automatically; a headless executor without one
reports a clear warning per command and keeps running.

### Node kinds

`primitive` (with `primitive: 'rect' | 'ellipse'` and `fill`), `path`
(SVG path data in `d`), `text` (needs `text`, `fontFamily`, `fontSize`,
`fontWeight`, `fill`, `align`; optional typography: `letterSpacing`,
`lineHeight`, `verticalAlign` (`top`|`middle`|`bottom`), `stroke` +
`strokeWidth` for a text outline, `fontFallback` — up to 8 extra families
tried in order), `image` (needs `resourceId` and natural sizes), `group`
(with `children`), `symbol` (with `assetId`).

Base fields (`id`, `center`, `width`, `height`, `rotation`, `opacity`,
`name`) are optional in scripts: omitted fields are defaulted (center =
stage center, size 100x100, opaque) and reported as warnings so the model
sees exactly what was chosen. Explicit values are preferred.

The `patch` of `updateNode` accepts the whitelisted node fields (`name`,
`center`, `width`, `height`, `rotation`, `opacity`, `fill`, `stroke`,
`strokeWidth`, `d`, and the text fields — including `letterSpacing`,
`lineHeight`, `verticalAlign` and `fontFallback`; text patches that change
the layout re-measure the node's box so the placed size stays correct);
unknown fields are rejected by the schema, never silently ignored.

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

### Camera and audio layers

A **camera layer** (one per document) drives the framing of every render:
`center` is the point `(x, y)` of the document kept in the middle of the
stage, `zoom` scales around it (1 = 100%, clamped to 0.05..64) and
`rotation` rotates the view (degrees). Poses are keyframed; like object
keyframes, a keyframe holds until the next one unless a tween (with easing
and an optional smooth center path) interpolates toward it. Camera poses
are baked into renders and exports for both the app and the CLI.

```json
{"commands": [
  {"op": "setCameraKeyframe", "frame": 0, "zoom": 1, "center": {"x": 480, "y": 270}},
  {"op": "setCameraKeyframe", "frame": 48, "zoom": 2.5, "center": {"x": 720, "y": 200}},
  {"op": "setTween", "frame": 0, "easing": "ease-in-out", "path": "smooth"}
]}
```

An **audio layer** carries one clip: `resourceId` names an audio resource
already imported into the session (import it in the app first — scripts
cannot read files), `startFrame` is where the clip begins, `volume` is
0..1 and mute is the layer's visibility (`muted: true`). Audio plays during
playback (with a `Scrub audio` toggle in the timeline) and is mixed into
WebM/MP4 exports; PNG sequences and GIF are silent.

```json
{"commands": [
  {"op": "addLayer", "kind": "audio", "resourceId": "res-12", "name": "Theme", "startFrame": 24},
  {"op": "setAudio", "layerId": "lay7", "volume": 0.6}
]}
```

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

Five complete payloads ship in `src/shared/scripting/examples.ts` and are
loadable in the script console (the full JSON of each is embedded in
[docs/scripting-reference.md](scripting-reference.md)):

- **Bouncing ball** — a layer, an ellipse, poses at frames 0/11/23 via
  `updateNode`, tweens with `ease-in` (fall) and `ease-out` (rise).
- **Title card fade-in** — a text node at `opacity: 0` tweened linearly to
  `opacity: 1`.
- **Retimed slide** — a custom bezier tween with `path: 'smooth'`, a middle
  pose retimed with `moveKeyframe`, and `setHoldStep: 2` playback on twos.
- **Walk cycle** — a stick figure built from an ellipse body and four limb
  paths; the limb joints sit at the path origins, so the poses only patch
  `rotation` per frame — a classic flip-book cycle with no tweens.
- **Lip-sync text** — a face whose mouth is a `path` node; the `d` and box
  height swap between closed/mid/open shapes on an audition cadence, ready
  to be retimed against an audio track (with a caption text node).

## Headless CLI

`npm run cli -- <command>` (or `npx openanimator` after install):

```
render <project.oanim|document.json> --out out.gif
    [--format png-sequence|gif|webm|mp4|lottie|dotlottie|svg-animation|spritesheet]
    [--scale 0.25..4] [--fps 1..60] [--from N] [--to N] [--transparent]
validate <payload.json> [--kind commands|document]
schema [--kind commands|document] [--out file]
```

- `render` evaluates frames through the same shared SVG path as the in-app
  exporter, rasterizes with resvg, and encodes with the shared GIF /
  PNG-sequence encoders. Embedded font subsets travel with the project:
  they are written to a temporary directory and handed to resvg as font
  files, so text renders with the embedded typography (see
  [docs/font-embedding.md](font-embedding.md)). `webm`/`mp4` require
  `ffmpeg` on PATH (WebCodecs is browser-only) and mix the document's
  audible audio layers into the output with the same timing as the app;
  transparent WebM encodes VP9 alpha (`yuva420p`) and MP4 is always
  opaque. `png-sequence` writes a ZIP of per-frame PNGs, which — like GIF
  and the spritesheet — is silent.
- The format defaults from the `--out` extension (`.zip` → PNG sequence,
  `.gif`, `.webm`, `.mp4`, `.json` → Lottie, `.lottie` → dotLottie,
  `.svg` → animated SVG); `--format spritesheet` must be given explicitly
  since `.zip` already maps to the PNG sequence. `lottie`, `dotlottie`
  and `svg-animation` are built natively — no rasterization, no ffmpeg,
  text as outlines and never an embedded font — and `spritesheet` packs
  the rendered frames into an `atlas.png` + `atlas.json` ZIP. See
  [docs/export-formats.md](export-formats.md) for the full feature matrix
  and the per-format degradation diagnostics.
- `validate` prints schema errors and exits 1 on an invalid payload — the
  machine surface for CI checks and LLM tooling.
- `schema` prints the JSON Schema itself (draft-07) — `--kind commands`
  (default) or `--kind document` — either to stdout or to `--out file`.
  Point your LLM tooling or editor at the output for autocomplete and
  validation; the published copies (`commands-v1.json`, `document-v8.json`)
  are generated by the docs site from the same source.

## Safety

Scripts only touch the open document through the editor's public mutation
methods — no filesystem, network or Electron access, no `eval`. The CLI
reads the file you pass it and writes the file you name. Anything a script
can do can be undone step by step (`Ctrl+Z`).
