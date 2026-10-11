# OpenAnimator

OpenAnimator is an open-source, vector-based animation tool built as an Electron desktop application in TypeScript.

## Status

The application now provides a working authoring core: layers with keyframes, a frame timeline, classic tweening with easing, a polymorphic scene graph (primitives, images, groups and symbols) with grouping, a reusable asset library with document and persistent global collections, symbol instances with isolated editing, raster image import, basic vector drawing and selection tools, onion skinning and playback — all rendered as SVG. Projects are saved as versioned ZIP `.oanim` containers that can carry binary resources.

## Tech stack

- [Electron](https://www.electronjs.org/) with [electron-vite](https://electron-vite.org/) (main / preload / renderer)
- TypeScript with strict mode, split into node-side and web-side type checking
- Vanilla TypeScript renderer rendering scene nodes as SVG — no UI framework
- [ESLint](https://eslint.org/) with typescript-eslint for linting
- [Vitest](https://vitest.dev/) for unit tests with v8 coverage (the document model lives in `src/shared/` and is fully testable without Electron)
- [electron-builder](https://www.electron.build/) for Linux packaging (AppImage, deb, rpm, Flatpak, tar.gz)

## Authoring features

- **Document model**: stage size, frame rate, background color, and a list of layers (`layers[0]` is the topmost). The scene is a tree of polymorphic nodes — primitives (`rect`, `ellipse`), placed images, groups and symbol instances — all sharing one transform vocabulary (position, size, rotation, opacity). Documents serialize to the `schemaVersion: 2` JSON inside the project container; legacy `schemaVersion: 1` shape-based plain-JSON files are migrated transparently on open.
- **Image import**: `Ctrl+I`, the toolbar button, or dropping image files from the OS onto the stage places the image on the current object layer — centered on the stage or at the drop point — at natural size capped to the stage, auto-selected. PNG/JPG/WebP keep their original bytes, GIFs become a PNG of their first frame and static SVGs are rasterized at 2×. Images render as `<image>` elements, tween on transform + opacity and hit-test by bounding box in v1.
- **Layers**: visibility and lock toggles, add/remove layers, per-layer keyframes.
- **Keyframes**: content keyframes and blank keyframes, insert/remove at the playhead, insert frame to extend holds.
- **Classic tweening**: a tween on a keyframe interpolates matching nodes (matched by id) toward the next keyframe — position, size, rotation and opacity for every node kind, plus fill and outline for primitives — with named easing curves (linear, ease-in, ease-out, ease-in-out) plus a cubic-bezier easing solver. Identity fields (image resource, group children, symbol asset) never interpolate; mismatched kinds snap.
- **Drawing tools**: rectangle and ellipse creation by drag (click for a default-size shape), selection with rotation-aware hit testing, move, nudge (arrow keys) and delete.
- **Groups**: `Ctrl+G` folds the selection of the active keyframe into one group (children re-expressed in group-local coordinates, z-order preserved) and `Ctrl+Shift+G` dissolves groups back into the layer space with an exact round-trip. Group transforms compose onto the children on ungroup; grouping and ungrouping are each a single undo step.
- **Asset library & symbols**: `F8` (or `Save as Symbol…`) saves the selection as a reusable symbol asset and replaces it on stage with one instance; every instance references the asset, so `Edit Symbol` opens the artwork in an isolated scratch editor and commits the change back to all instances in one undo step, and `Break Apart` decouples an instance into an editable group. The left **Library panel** shows the document's assets and the persistent global **My Library** (stored in the Electron user-data folder) as searchable 72 px thumbnails with a context menu (place at center, rename, duplicate, delete with instance-count warning, save to My Library) and a pointer-based drag onto the stage that places an instance at the drop point; global assets are imported on use (resources are content-addressed, so re-use is cheap). Imported images are registered as image assets automatically. Symbol graphs may nest up to 16 levels; cycles and over-deep graphs never hang the renderer — unresolvable instances render as dashed placeholders and the problem is reported on load.
- **Undo/redo**: snapshot history capped at 100 entries; a continuous drag or a color-swatch drag is a single undo step. `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` with statusbar feedback; history resets when a new or opened document replaces the current one.
- **Stage zoom & pan**: wheel zooms to the cursor (10%–800%), middle-drag, Space-hold-drag and the Hand tool (`H`) pan, `Ctrl+0` resets to the 1:1 fit, `+`/`-` zoom around the view center. Creation thresholds, default sizes and selection overlays stay correct and crisp at every zoom.
- **Multi-select**: the selection is a set — shift-click adds or toggles, rubber-band on empty stage area with the Select tool selects (shift unions). Move, nudge and delete apply to the whole selection; the properties panel edits the primary (last-selected) node.
- **Properties panel**: a right-side panel of collapsible sections whose expanded/collapsed state is remembered across restarts. Sections adapt to the editor state — the node sections only appear while a matching node is selected:
  - **Layer**: keyframe operations on the selected object — insert/remove keyframe, classic tween toggle with easing. Controls enable and disable according to the current layer, playhead and tween state.
  - **Shape**: edits the selected primitive — position, size, rotation, opacity, fill color (swatch or hex) and outline (color + width).
  - **Image**: the same transform inputs for a selected image, the read-only source file name, a `Native size` reset and `Replace source…` (re-points the image at another file while keeping the placed size).
  - **Group**: the same transform inputs for a selected group, plus `Ungroup` and `Save as Symbol… (F8)`.
  - **Symbol**: the same transform inputs for a selected symbol instance, the read-only asset name, `Edit Symbol` (isolated editing) and `Break Apart` (decouple into an editable group).
- **Timeline panel**: frame ruler, expandable layer rows with per-row visibility/lock toggles, one object row per node (groups included) carrying its frame-span bar, keyframe markers and tween spans, and the playhead.
- **Playback**: play/pause/stop, optional looping, frame-stepping at the document fps.
- **Onion skinning**: ghosted neighboring frames while paused.
- **Projects**: save and open `.oanim` project files with an explicit Save/Save As/Open, Ctrl+S / Ctrl+Shift+S / Ctrl+O shortcuts and debounced autosave to the current file. Since v0.9.0 the container is a **ZIP archive**: `document.json` plus the referenced binary resources under `resources/<sha256>.<ext>` (stored uncompressed), written atomically (temp file + rename). The loader sniffs the magic bytes: ZIP containers take the archive path; legacy plain-JSON documents (v1 shapes and pre-0.9.0 v2 JSON) still open through the migration/validation path. Resources are content-addressed by SHA-256, so identical content dedupes automatically; a missing or corrupt resource renders a dashed placeholder box while the document still opens, and unknown node types are reported as errors (pre-1.0, no forward-compat shims). `Purge Unused` in the toolbar removes resources no object references from the session store — nothing is garbage-collected silently.
- **Startup dialog**: shown on launch to start a new project, open a file, or reopen one of the recent projects (stored in the Electron `userData` folder).

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
│   │   └── projects.ts    # Project file IO, resource/image IPC handlers
│   ├── preload/           # Preload scripts (contextBridge API)
│   ├── shared/            # Pure TypeScript document model + unit tests
│   │   ├── api.ts         # IPC contract between main and renderer
│   │   ├── model.ts       # Document / layer / keyframe / scene-node / asset types
│   │   ├── assets.ts      # Pure asset helpers (create/duplicate/instance ops)
│   │   ├── symbols.ts     # Symbol resolution (cycle/depth guarded) + graph validation
│   │   ├── groups.ts      # Group/ungroup pure functions (group-local coords)
│   │   ├── migrate.ts     # v1 → v2 document migration and validation
│   │   ├── resources.ts   # Resource refcount walk over the document
│   │   ├── imagePlacement.ts # Import placement math (stage-capped fit)
│   │   ├── document.ts    # Document operations and per-frame evaluation
│   │   ├── tween.ts       # Node interpolation between keyframes
│   │   ├── easing.ts      # Named eases and cubic-bezier solver
│   │   ├── color.ts       # Hex color parsing and interpolation
│   │   ├── geometry.ts    # Vector math helpers
│   │   ├── hitTesting.ts  # Rotation-aware node hit testing and bounds
│   │   ├── render.ts      # evaluateDocumentAtFrame → renderer-agnostic tree
│   │   ├── renderSvg.ts   # Shared SVG fragment builder for the render tree
│   │   ├── viewTransform.ts # Stage zoom/pan math (view state, not document)
│   │   ├── recentProjects.ts # Recent-projects list logic
│   │   └── starterDocument.ts
│   └── renderer/          # Editor UI
│       ├── index.html
│       └── src/
│           ├── editor.ts  # Editor state (frame, selection, tools, playback)
│           ├── stage.ts   # SVG stage: rendering, drawing, selection
│           ├── resourceCache.ts # Blob/object-URL cache with decode validation
│           ├── imageImport.ts   # Image import (dialog, drag-drop) and replace-source
│           ├── library.ts # Left panel: document + global asset library, drag to stage
│           ├── properties.ts # Right panel: layer / shape / image / group / symbol sections
│           ├── sectionState.ts # Panel-section collapse state persistence
│           ├── projects.ts   # Save / open / startup dialog orchestration
│           ├── timeline.ts # Timeline panel (ruler, rows, playhead)
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
| `npm run dist:linux`    | Package Linux installers (AppImage, deb, rpm, Flatpak, tar.gz) |
| `npm run check-version` | Check that the version is greater than the base branch   |

## Keyboard shortcuts

| Keys                | Action                                  |
| ------------------- | --------------------------------------- |
| `V` / `R` / `O`     | Select / Rectangle / Ellipse tool       |
| `H`                 | Hand tool (pan the stage view)          |
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
| `Ctrl+I`            | Import an image onto the stage          |
| `Space`             | Play / pause                            |
| `Escape`            | Stop and return to frame 1              |
| `F5` / `F6` / `F7`  | Insert frame / keyframe / blank keyframe|
| Shift-click         | Add to or toggle the selection          |
| Rubber-band on empty stage | Select objects (Shift unions)    |
| `Delete`            | Delete the selected objects             |
| Arrow keys          | Nudge the selection (Shift = 10 px)     |

## Versioning and releases

The application follows [semantic versioning](https://semver.org/) with the version tracked in `package.json`.

- **Pull requests** (`pr-check.yml`): install, verify that `package.json` version is strictly greater than the version on the base branch, typecheck, lint, build and test with coverage thresholds. Every PR must bump the version.
- **Merges to main** (`main-build.yml`): typecheck, lint, test with coverage, build, then package Linux artifacts (AppImage, deb, rpm, Flatpak, tar.gz) and publish a GitHub release tagged `v<version>` with generated release notes. If the tag already exists, the release step is skipped.

## License

Copyright (c) Didier Hoarau. All rights reserved.
