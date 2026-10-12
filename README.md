# OpenAnimator

OpenAnimator is an open-source, vector-based animation tool built as an Electron desktop application in TypeScript.

## Status

The application now provides a working authoring core: layers with keyframes, frame-by-frame drawing layers painted with brush and eraser tools, a frame timeline with cell filmstrips, classic tweening with easing, a polymorphic scene graph (primitives, images, groups and symbols) with grouping, a reusable asset library with document and persistent global collections, symbol instances with isolated editing, raster image import, SVG import as editable vectors, vector drawing and selection tools with full anchor editing on committed paths, a vector brush, an eyedropper, linear/radial gradient paints (per-stop alpha), a document and global color palette with GIMP (`.gpl`) import/export, a text and font system (system-font picker, typography controls and license-gated glyph-subset embedding), a keyframable camera layer, audio layers (waveform timeline, synced playback and mixed audio in video exports), onion skinning and playback — all rendered as SVG. A full application menu, an in-app shortcut cheat sheet (`F1`), a scene-object clipboard with align/distribute and grid snapping, and a Preferences dialog round out the editor UX. Projects are saved as versioned ZIP `.oanim` containers that can carry binary resources.

## Documentation

The user guide lives at **<https://didierhoarau.github.io/OpenAnimator/>**:

- [Getting started](https://didierhoarau.github.io/OpenAnimator/getting-started.html) — install, a first animation, essential shortcuts.
- [Features](https://didierhoarau.github.io/OpenAnimator/features.html) — the condensed feature map with links to the deep dives.
- [Scripting](https://didierhoarau.github.io/OpenAnimator/scripting.html) and the [command reference](https://didierhoarau.github.io/OpenAnimator/reference.html) — the JSON command API; the reference is generated from `COMMANDS_SCHEMA`, so it cannot drift from the implementation.
- [Keyboard shortcuts](https://didierhoarau.github.io/OpenAnimator/shortcuts.html) — the complete table, generated from the same shortcut source the application menu, the `F1` cheat sheet and this page use.
- [Gallery](https://didierhoarau.github.io/OpenAnimator/gallery.html) — sample `.oanim` projects you can open, script and remix.

The site is rebuilt from `docs/` by the **Docs** workflow on every push to `main` that touches the docs; run `npm run docs:build` locally to regenerate the reference and the shortcuts page and preview the site from `site/`.

## Tech stack

- [Electron](https://www.electronjs.org/) with [electron-vite](https://electron-vite.org/) (main / preload / renderer)
- TypeScript with strict mode, split into node-side and web-side type checking
- Vanilla TypeScript renderer rendering scene nodes as SVG — no UI framework
- [ESLint](https://eslint.org/) with typescript-eslint for linting
- [Vitest](https://vitest.dev/) for unit tests with v8 coverage (the document model lives in `src/shared/` and is fully testable without Electron)
- [electron-builder](https://www.electron.build/) for packaging: Linux (AppImage, deb, rpm, Flatpak, tar.gz), Windows (NSIS installer + portable) and macOS (dmg)

## Authoring features

- **Document model**: stage size, frame rate, background color, a color palette, and a list of layers (`layers[0]` is the topmost). Layers come in four kinds: object layers (keyframed scene nodes), drawing layers (frame-by-frame raster cells), an optional **camera layer** (keyframed pan/zoom/rotation applied to every render) and **audio layers** (one clip each, positioned on the timeline). The scene is a tree of polymorphic nodes — primitives (`rect`, `ellipse`), editable vector paths, styled text, placed images, groups and symbol instances — all sharing one transform vocabulary (position, size, rotation, opacity). Documents serialize to the `schemaVersion: 8` JSON inside the project container; legacy `schemaVersion: 1`–`7` documents are migrated transparently on open and restamped to v8 (older files get empty defaults for the palette, the embedded-font list and the camera/audio collections, plus the typography fields of their text nodes left absent = the historical rendering).
- **Paint**: every fill and stroke is either a flat color or a **linear/radial gradient** (`Paint`). Gradients carry 2–8 ordered stops (each optionally with its own alpha — rendered as `stop-opacity` and interpolated stop by stop), are stored in the document JSON, render as inline SVG `<defs>` (content-hashed, deduplicated per frame) with bounding-box units, and interpolate in classic tweens when both keyframes use a matching gradient — any mismatch snaps like other identity fields. Strokes carry optional **stroke styles** (`stroke-linecap`, `stroke-linejoin`, `stroke-dasharray`, `stroke-dashoffset`) honored by the renderer and the SVG export and parsed back by SVG import; older documents migrate untouched.
- **Text & fonts**: text nodes carry full typography — family, size, weight (100–900), alignment, **letter spacing**, **line height**, **vertical placement** (top/middle/bottom), a **text outline** (paint + width, drawn in addition to the fill) and an ordered **fallback family list**. The family field suggests the **system fonts** installed on the machine (enumerated in the main process via fontconfig, readable through the preload API); rendering follows the family then falls back through the user list to the bundled-safe `'Noto Sans', sans-serif`. On save (and before export) the used fonts are **embedded as glyph subsets** — opentype.js re-serializes only the referenced glyphs, the subset is stored as a content-addressed `resources/<sha256>.ttf` resource and recorded in `document.fonts` with a deterministic synthetic family (`oa-embed-<weight>-<hash>`) and its license label, so a shared `.oanim` renders identically on machines without the fonts installed (stage via registered `FontFace`, in-app export via `@font-face` over data: URLs, CLI via resvg `fontFiles`). Embedding is gated by a **license allowlist** (20 bundled OFL/Apache families, overridable and deniable through `<userData>/font-embedding.json`; see `docs/font-embedding.md`), subsets grow by union across saves, unreferenced entries are pruned and failures never block saving. `Convert to Outlines` turns text into editable vector paths using the node's own font, baking spacing, line height and vertical placement into the geometry.
- **Image import**: `Ctrl+I`, the toolbar button, or dropping image files from the OS onto the stage places the image on the current object layer — centered on the stage or at the drop point — at natural size capped to the stage, auto-selected. PNG/JPG/WebP keep their original bytes, GIFs become a PNG of their first frame. **SVG import**: SVGs covering a documented subset (shapes, paths, polygons, polylines, lines, groups, transforms, presentation attributes and CSS styles — see `docs/svg-import.md`) are imported as **editable vectors** — a group of primitives and paths with transforms baked in, auto-selected, all in one undo step — and repeated identical leaf shapes collapse into symbol assets. Files outside the subset (text, images, filters, gradients, masks, arcs…) are rasterized at 2× instead, with the reason shown in the status bar. Images render as `<image>` elements, tween on transform + opacity and hit-test by bounding box in v1.
- **Layers**: visibility and lock toggles, add/remove layers of both kinds, per-layer keyframes.
- **Frame-by-frame drawing layers**: paint raster cells directly on the stage with the Brush (`B`) and Eraser (`E`) tools — pointer-pressure-aware width, jitter-smoothed quadratic strokes, adjustable color, size (`[` / `]`) and opacity, and a live overlay that mirrors the in-progress stroke. Each stroke commits as one PNG resource in the content-addressed store (auto-deduped) and one undo step; drawing on a frame without a cell creates one automatically. Cells hold until the next cell; `F6` duplicates the previous cell, `F7` inserts a blank one, `Clear`/`Remove Cell` blank or drop the cell at the playhead, and the timeline shows a per-layer filmstrip of cell thumbnails with a per-layer buffer-resolution setting (1–4× stage size).
- **Keyframes**: content keyframes and blank keyframes, insert/remove at the playhead, insert frame to extend holds. Keyframe markers drag between frames (shift-click selects several; a drag moves them all in one undo step, merging into existing keyframes) and copy/paste with `Ctrl+C`/`Ctrl+V`, keeping each pose's relative timing and its tween.
- **Classic tweening**: a tween on a keyframe interpolates matching nodes (matched by id) toward the next keyframe — position, size, rotation and opacity for every node kind, plus fill and outline (flat colors or gradients) for primitives and paths — with named easing curves (linear, ease-in, ease-out, ease-in-out), a cubic-bezier easing solver and a draggable curve editor in the properties panel. A tween can also follow a **smooth motion path** — the center swings along a curve through the node's neighbouring poses instead of straight lines — and the whole document can play on n's through the non-destructive **hold step**. Identity fields (image resource, group children, symbol asset) never interpolate; mismatched kinds snap.
- **Drawing tools**: rectangle and ellipse creation by drag (click for a default-size shape), a line tool (drag the endpoints; a plain click drops a default horizontal line), a pen tool (click for corner anchors, drag for curve handles, click the first anchor to close, `Enter` or double-click to commit, `Escape` to cancel) and a text tool that places a measured, auto-selected text node — plus selection with rotation-aware hit testing, move, nudge (arrow keys) and delete. Committed paths stay fully editable with the direct-selection tool (`A`): drag anchors and bezier handles, double-click an anchor for corner↔smooth or a segment to insert one, `Delete` removes the selected anchor, and dragging an open endpoint onto the other closes the contour — compound paths edit subpath by subpath.
- **Vector brush**: the `N` tool draws freehand strokes on the stage — pointer samples are smoothed into a quadratic-curve path and committed on release as one editable vector path node (stroked in the brush color, size and opacity, no fill), auto-selected, in a single undo step; a click without a drag draws a dot, and `Escape` or switching tools abandons an in-progress stroke.
- **Groups**: `Ctrl+G` folds the selection of the active keyframe into one group (children re-expressed in group-local coordinates, z-order preserved) and `Ctrl+Shift+G` dissolves groups back into the layer space with an exact round-trip. Group transforms compose onto the children on ungroup; grouping and ungrouping are each a single undo step.
- **Asset library & symbols**: `F8` (or `Save as Symbol…`) saves the selection as a reusable symbol asset and replaces it on stage with one instance; every instance references the asset, so `Edit Symbol` opens the artwork in an isolated scratch editor and commits the change back to all instances in one undo step, and `Break Apart` decouples an instance into an editable group. The left **Library panel** shows the document's assets and the persistent global **My Library** (stored in the Electron user-data folder) as searchable 72 px thumbnails with a context menu (place at center, rename, duplicate, delete with instance-count warning, save to My Library) and a pointer-based drag onto the stage that places an instance at the drop point; global assets are imported on use (resources are content-addressed, so re-use is cheap). Imported images are registered as image assets automatically. Symbol graphs may nest up to 16 levels; cycles and over-deep graphs never hang the renderer — unresolvable instances render as dashed placeholders and the problem is reported on load.
- **Undo/redo**: snapshot history whose depth is configurable in Preferences (default 100 entries); a continuous drag or a color-swatch drag is a single undo step. `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` with statusbar feedback that names the action (`Undo: Move nodes`), toolbar Undo/Redo buttons that enable with the history, and the application menu's Undo/Redo routing to the editor (a focused text field keeps its native undo while it has focus). History resets when a new or opened document replaces the current one.
- **Stage zoom & pan**: wheel zooms to the cursor (10%–800%), middle-drag, Space-hold-drag and the Hand tool (`H`) pan, `Ctrl+0` resets to the 1:1 fit, `+`/`-` zoom around the view center. Creation thresholds, default sizes and selection overlays stay correct and crisp at every zoom.
- **Multi-select**: the selection is a set — shift-click adds or toggles, rubber-band on empty stage area with the Select tool selects (shift unions). Move, nudge and delete apply to the whole selection; the properties panel edits the primary (last-selected) node.
- **Properties panel**: a right-side panel of collapsible sections whose expanded/collapsed state is remembered across restarts. Sections adapt to the editor state — the node sections only appear while a matching node is selected:
  - **Layer**: keyframe operations on the selected object — insert/remove keyframe, classic tween toggle with an easing picker (named presets plus a draggable cubic-bezier curve editor) and a motion-path select (`Linear`/`Smooth`). Controls enable and disable according to the current layer, playhead and tween state. A `Move to` frame input shifts the selected objects so their first keyframes land on that frame, keeping their timing.
  - **Shape**: edits the selected primitive — position, size, rotation, opacity, fill and outline — each paint edited either as a flat color (swatch or hex) or a linear/radial gradient (angle, or center + radius, with 2–8 color stops, each with an optional alpha), plus the outline width and its `Style`/`Dash` rows (cap, join, dash pattern, dash offset).
  - **Path**: the same transform inputs for a selected path, outline toggle with paint editor, width and style, fill toggle with paint editor, and the anchor count (`3 anchors`, `12 anchors · 2 subpaths`) with an `Edit anchors: A` hint and a `Close subpath` button.
  - **Text**: the same transform inputs for a selected text node — text content, font family (with suggestions from the installed system fonts), size, weight (100–900), alignment, letter spacing, line height, vertical placement, fallback families, the fill paint editor, a text outline (paint editor + width) and `Convert to Outlines`.
  - **Image**: the same transform inputs for a selected image, the read-only source file name, a `Native size` reset and `Replace source…` (re-points the image at another file while keeping the placed size).
  - **Group**: the same transform inputs for a selected group, plus `Ungroup` and `Save as Symbol… (F8)`.
  - **Symbol**: the same transform inputs for a selected symbol instance, the read-only asset name, `Edit Symbol` (isolated editing) and `Break Apart` (decouple into an editable group).
  - **Draw**: shown for drawing layers — brush color (swatch + hex, with the palette strips), size and opacity, the onion-skin toggle and the cell operations (`◀ Prev`, `Duplicate`, `Clear`, `Next ▶`) for the cell at the playhead.
  - **Cell**: shown for drawing layers — the frame range the cell at the playhead occupies (`frames 3–7`, or `frames 3–end` when the last cell holds to the end) with `Start`, `End` and `Move to` frame inputs. Retiming a cell that is followed by another drags the next cell along to keep the hold contiguous; shortening the last cell splits off a transparent cell after the new end; every edit is a single undo step.
  - **Palette**: the document palette (saved in the project file) and the global palette (persisted in the Electron user-data folder and shared by all projects) as clickable swatch rows — clicking a swatch applies it to the selected object or sets the brush color (the active swatch is highlighted), right-clicking removes it, and `+ Swatch` / `+ Global` capture the current color (up to 48 per palette). Every color control in the panel carries the combined strips; a session **Recent** row (the last 12 applied colors) sits beside them, and the global row adds **Import…**/**Export…** for GIMP `.gpl` palette files. The eyedropper (`I`, or `Alt`+click from any tool) picks a rendered stage pixel into the selected object or the brush.
- **Color palettes**: the document palette travels inside the `.oanim` container (schemaVersion 6) so a project opens with its house colors on any machine; the global palette lives in a `palette.json` in the Electron user-data folder, written atomically, and is surfaced to the renderer through the preload API. GIMP `.gpl` imports merge the file's colors into the global palette (duplicates dropped) and exports write the standard `GIMP Palette` header with `rr gg bb` rows.
- **Timeline panel**: frame ruler, expandable layer rows with per-row visibility/lock toggles and a kind badge, one object row per node (groups included) carrying its frame-span bar, keyframe markers and tween spans, a per-frame cell filmstrip for drawing layers, and the playhead. Objects move by dragging their span bar, keyframe markers by dragging between frames and cells by dragging their filmstrip thumbnail onto a target frame; right-clicking an object or drawing-layer row offers a numeric `Move to frame` plus keyframe actions (insert/remove/copy/paste). A `Hold` select plays the document on n's and the onion-skin options (ghost counts, tint colors, outline mode) live in the same header row.
- **Panel layout**: the library, properties and timeline panes resize by dragging their splitters, which span the full boundary of the panel, and hiding the library from the toolbar collapses its column instead of leaving empty space.
- **Playback**: play/pause/stop, optional looping, frame-stepping at the document fps.
- **Onion skinning**: ghosted neighboring frames while paused — configurable before/after ghost counts, optional before/after tint colors and an outline-only mode; forward/back ghosts step by the hold step so they show the frames playback will actually visit.
- **Camera**: one keyframed camera layer per document pans, zooms (0.05×–64×) and rotates the framing; the stage shows a camera-framing overlay while the camera layer is selected, and the pose is baked into every in-app and CLI render. Camera keyframe markers live on the timeline row (drag to retime, right-click to key/tween) and the Camera properties section edits the pose at the playhead with the same easing/smooth-path controls as object tweens.
- **Audio**: import WAV/MP3/OGG (toolbar, or drop the file onto the stage) into content-addressed resources; the timeline shows each audio layer as a draggable clip with a decoded **waveform**, start frame, volume (%) and mute (layer visibility) controls in the Audio properties section. Playback schedules the clips against the timeline — with an optional `Scrub audio` blip while moving the playhead — and the Export dialog mixes the same plan into WebM/MP4 (PNG sequence and GIF are silent). See `src/shared/audio.ts`.
- **Export**: the toolbar's Export dialog writes eight formats for a chosen resolution scale, fps and frame range — raster outputs (PNG sequence as ZIP, animated GIF, spritesheet as a PNG atlas ZIP), WebM/MP4 video, and the **natively built vector exports** (Lottie bodymovin JSON, dotLottie ZIP, animated CSS-keyframes SVG). PNG/GIF/spritesheet and the vector formats keep transparency; WebM adds **VP9 alpha** when the environment's encoder supports it (otherwise the video is opaque, reported in the status bar) and MP4 is always opaque. WebM/MP4 include the mixed audio tracks (silent when no audio codec is available, also reported), all other formats are silent. Lottie/dotLottie and animated-SVG exports run without rasterization and never embed fonts — text ships as outlines, and unsupported content degrades to dashed placeholders with per-export diagnostics (the full feature matrix lives in `docs/export-formats.md`). The same frame evaluation runs headless through the CLI (`npm run cli -- render …`; video needs `ffmpeg` on PATH), so camera framing and audio timing are identical between the app and the command line.
- **Projects**: save and open `.oanim` project files with an explicit Save/Save As/Open, Ctrl+S / Ctrl+Shift+S / Ctrl+O shortcuts. The project file itself only ever changes through an explicit save; the debounced autosave writes a **recovery snapshot** under the Electron user-data folder instead, and reopening a project whose snapshot is newer than the last save offers a recovery dialog (see *Platform notes*). Since v0.9.0 the container is a **ZIP archive**: `document.json` plus the referenced binary resources under `resources/<sha256>.<ext>` (stored uncompressed), written atomically (temp file + rename). The loader sniffs the magic bytes: ZIP containers take the archive path; legacy plain-JSON documents (v1 shapes and pre-0.9.0 v2 JSON) still open through the migration/validation path. Resources are content-addressed by SHA-256, so identical content dedupes automatically; a missing or corrupt resource renders a dashed placeholder box while the document still opens, and unknown node types are reported as errors (pre-1.0, no forward-compat shims). `Purge Unused` in the toolbar removes resources no object references from the session store — nothing is garbage-collected silently.
- **Startup dialog**: shown on launch to start a new project, open a file, or reopen one of the recent projects (stored in the Electron `userData` folder).
- **Application menu**: a full **File / Edit / Insert / Layer / View / Help** menu (plus the platform window menu) whose entries call the exact same editor commands as the toolbar and timeline (New `Ctrl+N`, Open `Ctrl+O`, Save `Ctrl+S` / Save As `Ctrl+Shift+S`, Import Image `Ctrl+I`, Import Audio, Export `Ctrl+E`, Purge Unused, Undo/Redo, Cut/Copy/Paste/Duplicate, Select All, Align and Distribute, Preferences `Ctrl+,`, keyframe/frame/blank-cell inserts `F5`–`F7`, tween `Ctrl+T`, group `Ctrl+G`/`Ctrl+Shift+G`, symbol `F8`, layer creation, zoom and view toggles, grid `Ctrl+'`, onion skin, panels, fullscreen). The same table drives the `F1` cheat sheet and the generated [shortcuts page](https://didierhoarau.github.io/OpenAnimator/shortcuts.html), so the three can never drift apart.
- **Scene-object clipboard, align and distribute**: `Ctrl+C` / `Ctrl+V` copy and paste the selected scene objects (with their keyframe tracks, offset +10/+10); while the timeline was the last-clicked surface the same keys operate the timeline's keyframe clipboard. `Ctrl+X` cuts and `Ctrl+D` duplicates the selection, each a single undo step. Align (left/center/right/top/middle/bottom) needs two or more selected objects, distribute (horizontal/vertical) three or more; both live in the Edit menu.
- **Grid and snapping**: `Ctrl+'` toggles the grid overlay together with snap-to-grid — move drags and rectangle/ellipse/line creation land on the grid (freehand input stays free). The step size comes from Preferences.
- **Preferences**: Edit → **Preferences…** (`Ctrl+,`) edits the stage size and frame rate used by the **next new document** (the current one is never resized implicitly), autosave on/off and its idle window, the undo depth, the brush defaults and the grid size — persisted in `preferences.json` in the Electron user-data folder. Brush/undo/autosave/grid values apply live; panel sizes remain where they were.
- **Help, About and status feedback**: `F1` opens the in-app keyboard cheat sheet; **Help → About** shows the app, Electron and Chrome versions with links to the repository and the docs. Status-bar messages name the undone/redone action and persistent problems (e.g. a failed autosave) stay visible until dismissed, with a **Copy details** button.

## Project layout

```
├── .github/workflows/     # CI workflows (PR check, main build/release)
├── build/                 # Packaging resources (application icon)
├── scripts/               # CI helper scripts (semantic version check)
├── src/
│   ├── main/              # Electron main process (window, IPC, project files)
│   │   ├── projectContainer.ts # ZIP .oanim v2 codec (pack/parse, magic sniffing)
│   │   ├── resources.ts   # Content-addressed session resource store (SHA-256)
│   │   ├── library.ts     # Persistent global "My Library" store and IPC handlers
│   │   ├── palette.ts     # Persistent global color palette store and IPC handlers
│   │   ├── fonts.ts       # System font enumeration (fontconfig) + embedding policy store
│   │   ├── recovery.ts    # Autosave recovery snapshots + IPC handlers
│   │   ├── updates.ts     # Update checks (electron-updater / GitHub Releases API)
│   │   ├── openFiles.ts   # `.oanim` launch-argument extraction
│   │   ├── menu.ts        # Application menu built from the single shortcut table
│   │   ├── preferences.ts # Preferences store (`preferences.json`) + IPC handlers
│   │   └── projects.ts    # Project file IO, resource/image IPC handlers
│   ├── preload/           # Preload scripts (contextBridge API)
│   ├── shared/            # Pure TypeScript document model + unit tests
│   │   ├── api.ts         # IPC contract between main and renderer
│   │   ├── model.ts       # Document / layer / keyframe / scene-node / asset types
│   │   ├── assets.ts      # Pure asset helpers (create/duplicate/instance ops)
│   │   ├── symbols.ts     # Symbol resolution (cycle/depth guarded) + graph validation
│   │   ├── groups.ts      # Group/ungroup pure functions (group-local coords)
│   │   ├── migrate.ts     # Legacy → current schema migration and validation
│   │   ├── resources.ts   # Resource refcount walk over the document
│   │   ├── fontPolicy.ts  # Embedding allowlist/deny policy + CSS family lists
│   │   ├── fontSubset.ts  # Per-family glyph usage walk and opentype.js subsetting
│   │   ├── imagePlacement.ts # Import placement math (stage-capped fit)
│   │   ├── paint.ts       # Flat-color / gradient paint model (validate, interpolate, hash)
│   │   ├── svgImport.ts   # SVG → editable vector import (subset parser, transforms baked in)
│   │   ├── document.ts    # Document operations and per-frame evaluation
│   │   ├── tween.ts       # Node interpolation between keyframes
│   │   ├── easing.ts      # Named eases and cubic-bezier solver
│   │   ├── audio.ts       # Audio mix plan (audible clips, timing) and waveform downsampling
│   │   ├── color.ts       # Hex color parsing and interpolation
│   │   ├── gpl.ts         # GIMP palette (.gpl) parser and serializer
│   │   ├── geometry.ts    # Vector math helpers
│   │   ├── hitTesting.ts  # Rotation-aware node hit testing and bounds
│   │   ├── pathEdit.ts    # Anchor/subpath editing math and path placement recentering
│   │   ├── render.ts      # evaluateDocumentAtFrame → renderer-agnostic tree
│   │   ├── renderSvg.ts   # Shared SVG fragment builder for the render tree
│   │   ├── viewTransform.ts # Stage zoom/pan math (view state, not document)
│   │   ├── recentProjects.ts # Recent-projects list logic
│   │   ├── recovery.ts    # Recovery snapshot rules (offer when newer than the file)
│   │   ├── updates.ts     # Release version parsing and comparison (pure)
│   │   ├── textOutline.ts # Text→outline math shared by Convert-to-Outlines and the vector exporters
│   │   ├── shortcuts.ts   # The single shortcut table driving menu, keyboard, cheat sheet and docs
│   │   ├── preferences.ts # Preferences model: defaults, clamps, partial merges
│   │   ├── snapping.ts    # Grid-snapping math for move and create drags
│   │   ├── align.ts       # Align/distribute math for node selections
│   │   ├── lottieExport.ts # Lottie (bodymovin) / dotLottie builder with placeholder degradation
│   │   ├── exportSvgAnimation.ts # Animated-SVG (CSS keyframes) builder
│   │   ├── spritesheet.ts # Spritesheet grid math, atlas blitting, JSON-hash metadata
│   │   └── starterDocument.ts
│   └── renderer/          # Editor UI
│       ├── index.html
│       └── src/
│           ├── editor.ts  # Editor state (frame, selection, tools, playback)
│           ├── commands.ts # Single command router: menu items and key bindings dispatch here
│           ├── activeSurface.ts # Which surface (stage/timeline) the clipboard acts on
│           ├── shortcutHelp.ts # F1 cheat sheet rendered from the shortcut table
│           ├── preferences.ts  # Renderer preference store (live values + IPC sync)
│           ├── preferencesDialog.ts # Preferences dialog
│           ├── aboutDialog.ts  # About dialog (versions, repository, docs links)
│           ├── stage.ts   # SVG stage: rendering, drawing, selection, anchor editing
│           ├── drawing.ts # Stroke smoothing + DrawingSession (overlay-then-commit)
│           ├── cellPreload.ts # Playback preloader for drawing-cell images
│           ├── resourceCache.ts # Blob/object-URL cache with decode validation
│           ├── imageImport.ts   # Image import (dialog, drag-drop, SVG vectors) and replace-source
│           ├── audioImport.ts   # Audio import (dialog, drag-drop, magic sniffing)
│           ├── audio.ts   # Audio playback: AudioContext clip scheduler, scrub, waveform peaks
│           ├── fontEmbedding.ts # Subset reconciliation on save + FontFace registration
│           ├── textOutlines.ts  # Convert-to-outlines through the node's (or bundled) font
│           ├── gradientEditor.ts # Paint editor widget (solid/linear/radial + stop list)
│           ├── swatches.ts # Palette swatch-strip widget
│           ├── eyedropper.ts # Stage-pixel color sampling through the export rasterizer
│           ├── library.ts # Left panel: document + global asset library, drag to stage
│           ├── properties.ts # Right panel: layer / shape / path / text / image / group / symbol / camera / audio / draw / cell / palette sections
│           ├── sectionState.ts # Panel-section collapse state persistence
│           ├── panelLayout.ts  # Panel sizes, splitters and persistence
│           ├── projects.ts   # Save / open / startup dialog / recovery orchestration
│           ├── updateBanner.ts # Update-available banner
│           ├── timeline.ts # Timeline panel (ruler, rows, playhead, drag-to-move)
│           ├── main.ts    # Bootstrap, toolbar, shortcuts, autosave
│           └── style.css
├── electron.vite.config.ts
├── electron-builder.yml
└── vitest.config.ts
```

## Getting started

Requirements: Node.js 24 and npm.

```bash
npm install
npm run dev        # start the app with hot reload
```

## Scripts

| Script                  | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `npm run dev`           | Start the application in development with hot reload     |
| `npm run build`         | Build main, preload and renderer bundles into `out/`     |
| `npm run typecheck`     | Typecheck node-side and web-side TypeScript              |
| `npm run lint`          | Lint the source with ESLint                              |
| `npm test`              | Run unit tests with Vitest                               |
| `npm run test:coverage` | Run unit tests with v8 coverage thresholds               |
| `npm run test:e2e`      | Playwright-Electron golden paths against `out/` (build first; prefix `xvfb-run -a` on headless Linux) |
| `npm run cli -- …`      | Headless CLI: `render`, `validate`, `schema` (see `npm run cli -- help`) |
| `npm run samples:build` | Regenerate the committed gallery samples (`docs/samples/*.oanim` + GIF previews) |
| `npm run docs:build`    | Regenerate `docs/scripting-reference.md` and `docs/shortcuts.md`, then build the docs site into `site/` |
| `npm run dist:linux`    | Package Linux installers (AppImage, deb, rpm, Flatpak, tar.gz) |
| `npm run dist:win`      | Package Windows installers (NSIS + portable exe)         |
| `npm run dist:mac`      | Package macOS disk images (dmg, x64 + arm64)             |
| `npm run check-version` | Check that the version is greater than the base branch   |

## Keyboard shortcuts

| Keys                | Action                                  |
| ------------------- | --------------------------------------- |
| `V` / `R` / `O`     | Select / Rectangle / Ellipse tool       |
| `L` / `P` / `T`     | Line / Pen / Text tool                  |
| `N`                 | Vector brush tool (object layers)       |
| `B` / `E`           | Brush / Eraser tool (drawing layers)    |
| `[` / `]`           | Decrease / increase the brush size      |
| `H`                 | Hand tool (pan the stage view)          |
| `A` / `I`           | Direct-selection / Eyedropper tool (`Alt`+click picks from any tool) |
| `Ctrl+Z`            | Undo                                    |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo                              |
| `Ctrl+G`            | Group the selected objects              |
| `Ctrl+Shift+G`      | Ungroup the selected groups             |
| `F8`                | Save the selection as a reusable symbol |
| `Ctrl+0`            | Reset the stage view to the 1:1 fit     |
| `+` / `-`           | Zoom the stage in / out                 |
| Mouse wheel         | Zoom the stage to the cursor            |
| Middle-drag / hold `Space` and drag | Pan the stage view       |
| `Ctrl+S`            | Save the current project                |
| `Ctrl+Shift+S`      | Save the project to a new file          |
| `Ctrl+O`            | Open a project file                     |
| `Ctrl+N`            | Start a new document                    |
| `Ctrl+I`            | Import an image onto the stage          |
| `Ctrl+E`            | Export the animation                    |
| `Ctrl+C` / `Ctrl+V` | Copy / paste keyframes (timeline) or scene objects (stage) — the last-clicked surface decides |
| `Ctrl+X` / `Ctrl+D` | Cut / duplicate the selected scene objects |
| `Ctrl+A`            | Select every object on the layer        |
| `Space`             | Play / pause                            |
| `Enter`             | Commit an open pen path                 |
| `Escape`            | Cancel the pen path or vector stroke, drop the anchor selection, otherwise stop and return to frame 1 |
| `F5` / `F6` / `F7`  | Insert frame / keyframe or duplicate cell / blank keyframe or cell |
| `Ctrl+T`            | Toggle the tween at the playhead        |
| `Ctrl+'`            | Toggle the grid and snapping            |
| `Ctrl+,`            | Open Preferences                        |
| `F1`                | Keyboard-shortcut cheat sheet           |
| Shift-click         | Add to or toggle the selection          |
| Rubber-band on empty stage | Select objects (Shift unions)    |
| `Delete`            | Delete the selected objects (with the direct tool, the selected path anchor) |
| Arrow keys          | Nudge the selection (Shift = 10 px)     |

## Versioning and releases

The application follows [semantic versioning](https://semver.org/) with the version tracked in `package.json`.

- **Pull requests** (`pr-check.yml`): install, verify that `package.json` version is strictly greater than the version on the base branch, typecheck, lint, build and test with coverage thresholds. A second job runs the Playwright **E2E golden paths** on the built app under `xvfb`, and the docs-site build is exercised so a broken generator cannot land. Every PR must bump the version.
- **Merges to main** (`main-build.yml`): a **validate** job runs typecheck, lint, tests with coverage and the build; three packaging jobs then run on native runners — Linux (AppImage, deb, rpm, Flatpak, tar.gz), Windows (NSIS installer + portable exe) and macOS (dmg for x64 and arm64) — and a single GitHub release tagged `v<version>` is published with every artifact plus the `latest*.yml` update metadata files consumed by the in-app updater. If the tag already exists, the packaging and release steps are skipped.
- **Documentation** (`docs.yml`): pushes to `main` that touch `docs/`, `README.md`, `CONTRIBUTING.md`, `scripts/` or the scripting/CLI sources rebuild and deploy the documentation site to GitHub Pages.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, every npm script, the architecture rules (in particular: `src/shared/` stays pure TypeScript) and the pull-request gates CI enforces. Issues labeled `good first issue` are scoped for a first contribution.

## Platform notes

- **Unsigned downloads**: Windows and macOS builds ship unsigned for now (code signing is a tracked follow-up, which will also enable silent auto-update). Windows shows a SmartScreen warning ("More info → Run anyway"); on macOS, right-click the app → Open, or run `xattr -dr com.apple.quarantine /Applications/OpenAnimator.app`. Every release body repeats this notice.
- **`.oanim` file association**: registered by the Windows NSIS installer, the macOS app bundle and the Linux deb/rpm/Flatpak desktop entries (MIME type `application/x-oanim`), so double-clicking a project opens it and dropping one onto the dock/taskbar icon forwards it to the running window. AppImage, tar.gz and the portable exe cannot register associations — open the file through the app instead.
- **Update-available notification**: packaged builds check for a newer release once at startup (silent on failure) and show a dismissible banner linking to the release page. Nothing is downloaded or executed automatically; deb/rpm/Flatpak/tar.gz installs use a read-only GitHub Releases check since electron-updater can only update AppImage in place. Silent auto-update follows with code signing.
- **Save model and crash recovery**: the project file changes only through an explicit Save/Save As; the debounced autosave writes a recovery snapshot under the Electron user-data folder (`recovery/`). When a project is reopened and its snapshot is newer than the last manual save, a dialog offers to **Recover** (load the autosaved state), **Discard** (delete the snapshot) or keep it for later. Snapshots of never-saved documents do not exist — autosave needs a known file path.

## License

Copyright (c) Didier Hoarau. All rights reserved.
