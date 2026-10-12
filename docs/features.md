# Features

A condensed map of what OpenAnimator can do. Each area links to the deeper
reference where one exists; the [README](README.md) has the exhaustive list.

## Documents and projects

- Stage size, frame rate, background color, a document color palette, and an
  authored timeline length (the **hold step** plays the document on 2s/3s
  without touching the data).
- Layers come in four kinds: **object layers** (keyframed vector scene
  nodes), **drawing layers** (frame-by-frame raster cells), one optional
  **camera layer** (keyframed pan/zoom/rotation baked into every render) and
  **audio layers** (one clip each, waveform on the timeline).
- Projects save as versioned ZIP `.oanim` containers: `document.json` plus
  content-addressed resources (`resources/<sha256>.<ext>`), written
  atomically. Documents migrate transparently from `schemaVersion` 1–7.
  Autosave writes a separate recovery snapshot and offers it back after a
  crash — including for never-saved (untitled) documents, which recover
  straight into a **Save As…**. A failed snapshot shows a persistent
  status-bar warning instead of silently retrying.
- **Unsaved-changes protection** — closing the window with a dirty document
  asks **Save / Discard / Cancel** in an in-app prompt (Save covers untitled
  documents via Save As…). All confirmations and alerts are in-app dialogs
  with keyboard focus handling — no native popups interrupt the flow.

## Authoring

- **Drawing tools** — rectangle and ellipse by drag, line, a pen tool for
  path anchors and bezier handles, a vector brush (`N`) smoothing freehand
  strokes into editable paths, and a text tool.
- **Anchor editing** — committed paths stay fully editable with the
  direct-selection tool (`A`): drag anchors and bezier handles, double-click
  an anchor to switch corner↔smooth or a segment to insert one, `Delete` to
  remove, and close an open contour by dragging its endpoint onto the other
  (or the properties button). Compound paths edit subpath by subpath, and
  the equivalent `setPathAnchors` scripting op edits them headlessly.
- **Stroke styles** — linecap, linejoin, dash pattern and dash offset are
  node fields with properties-panel controls, honored by the renderer and
  SVG export, round-tripped by SVG import, and carried through classic
  tweens.
- **Eyedropper and recent colors** — the `I` tool (or `Alt`+click from any
  tool) picks the color under the pointer from the rendered stage into the
  selection's fill/stroke (or the brush); picks and palette clicks land in a
  session **Recent** row beside the palette strips.
- **Keyframes** — content and blank keyframes, insert/remove at the
  playhead, drag markers to retime (multi-select shifts with `Shift`), copy
  and paste poses with their relative timing, `Move to` frame.
- **Classic tweening** — a tween on a keyframe interpolates matching nodes
  (position, size, rotation, opacity, plus fill/stroke paints for
  primitives and paths) toward the next keyframe, with named easings, a
  cubic-bezier curve editor and an optional **smooth motion path**.
- **Frame-by-frame drawing layers** — brush and eraser cells with
  pressure-aware width, onion skinning, per-layer buffer resolution, and
  cell retiming (`frames 3–7`, move, duplicate, clear).
- **Groups and symbols** — `Ctrl+G`/`Ctrl+Shift+G` group and ungroup with
  exact round-trip; `F8` saves the selection as a reusable symbol asset with
  isolated editing and instance-count-aware management.
- **Menus and shortcut help** — a full application menu
  (File/Edit/Insert/Layer/View/Help) over the same editor commands the
  toolbar and timeline call, an `F1` cheat sheet and a generated
  [shortcuts page](shortcuts.md) — all rendered from one shortcut table, so
  they cannot drift apart.
- **Node clipboard, align and distribute** — `Ctrl+C`/`Ctrl+V`/`Ctrl+X`/
  `Ctrl+D` copy, paste, cut and duplicate the selected scene objects with
  their keyframe tracks (paste offset +10/+10, one undo step each); the
  timeline keeps its own keyframe clipboard on the same keys and the
  last-clicked surface decides (see the [shortcuts page](shortcuts.md)).
  Align (six modes) needs ≥2 selected objects, distribute (h/v) ≥3.
- **Grid and snapping** — `Ctrl+'` toggles the grid overlay and snap-to-grid
  together; move drags and rectangle/ellipse/line creation land on the grid,
  with the step size set in Preferences.
- **Preferences** — a dialog (`Ctrl+,`) for the stage size/frame rate used by
  the *next* new document, autosave on/off and its idle window, undo depth,
  brush defaults and grid size — persisted in `preferences.json` in the
  user-data folder. The status bar names the undone action, and persistent
  errors stay visible with copyable details until dismissed.
- **About dialog** — app, Electron and Chrome versions with links to the
  repository and the documentation.
- **Asset library** — document assets plus a persistent global *My Library*
  with searchable thumbnails, drag-to-stage placement, rename, duplicate,
  delete and save-to-library.
- **Text and fonts** — full typography (weight, alignment, letter spacing,
  line height, vertical placement, fallback families), a system-font picker,
  text outlines, `Convert to Outlines`, and license-gated glyph-subset
  **embedding** so shared files render identically — see
  [Font embedding](font-embedding.md).
- **Images and SVG import** — PNG/JPG/WebP (GIF takes its first frame) with
  replace-source; SVGs inside a documented subset import as **editable
  vectors**, everything else rasterizes at 2× with the reason reported — see
  [SVG import](svg-import.md).
- **Camera and audio** — pan/zoom (0.05×–64×)/rotate framing with the same
  easing controls as object tweens; WAV/MP3/OGG clips with waveforms, volume
  and mute, mixed into video exports.
- **Palettes** — a document palette saved in the project plus a global
  palette persisted in the user-data folder, shared by every color control;
  the global palette imports and exports **GIMP (`.gpl`) palette files**
  (imports merge with the existing colors).
- **Editing comfort** — undo/redo (drag-coalesced single steps, depth
  configurable in Preferences), multi-select and rubber-band selection, zoom
  10%–800% with pan, panel layout persistence, onion skinning, and playback
  with looping.

## Export and automation

- **Eight export formats** from the in-app dialog or the headless CLI —
  PNG sequence, GIF, WebM (VP9, alpha when available), MP4, Lottie,
  dotLottie, animated SVG and spritesheet — with per-format scale, fps,
  frame range and transparency rules. The full matrix lives in
  [Export formats](export-formats.md).
- **Cancellable exports with viewable diagnostics** — Cancel (or ×/Escape)
  stops a running export within a frame and never leaves a partial file
  behind; when a successful export carries diagnostics (e.g. missing-font
  placeholders) the dialog lists them before closing.
- **Scripting API** — JSON command payloads validate against a published
  schema and run through the same pipeline as UI gestures (one undo entry
  per command, auto-keying included). Use the in-app **Script…** console, or
  the CLI `validate` / `render` / `schema` commands. Start with
  [Scripting](scripting.md) and the generated
  [command reference](scripting-reference.md).
- **Deterministic samples** — the gallery projects are generated by
  `npm run samples:build` from the same document builder the app uses, and
  the scripting reference is regenerated by `npm run docs:build` straight
  from the command schema, so documentation cannot drift from the code.
