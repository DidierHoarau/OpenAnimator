# OpenAnimator

OpenAnimator is an open-source, vector-based animation tool built as an Electron desktop application in TypeScript.

## Status

The application now provides a working authoring core: layers with keyframes, a frame timeline, classic tweening with easing, basic vector drawing and selection tools, onion skinning and playback — all rendered as SVG.

## Tech stack

- [Electron](https://www.electronjs.org/) with [electron-vite](https://electron-vite.org/) (main / preload / renderer)
- TypeScript with strict mode, split into node-side and web-side type checking
- Vanilla TypeScript renderer rendering vector shapes as SVG — no UI framework
- [Vitest](https://vitest.dev/) for unit tests (the document model lives in `src/shared/` and is fully testable without Electron)
- [electron-builder](https://www.electron.build/) for Linux packaging (AppImage, deb, rpm, Flatpak, tar.gz)

## Authoring features

- **Document model**: stage size, frame rate, background color, and a list of layers (`layers[0]` is the topmost). Documents serialize to plain JSON.
- **Layers**: visibility and lock toggles, add/remove layers, per-layer keyframes.
- **Keyframes**: content keyframes and blank keyframes, insert/remove at the playhead, insert frame to extend holds.
- **Classic tweening**: a tween on a keyframe interpolates matching shapes (matched by id) toward the next keyframe — position, size, rotation, opacity and fill color — with named easing curves (linear, ease-in, ease-out, ease-in-out) plus a cubic-bezier easing solver.
- **Drawing tools**: rectangle and ellipse creation by drag (click for a default-size shape), selection with rotation-aware hit testing, move, nudge (arrow keys) and delete.
- **Properties panel**: a right-side panel with sections; the Shape section edits the selected shape of the active keyframe — position, size, rotation, opacity, fill color (swatch or hex) and outline (color + width).
- **Timeline panel**: frame ruler, layer rows, keyframe markers, tween spans, playhead, playback controls, fps input.
- **Playback**: play/pause/stop, optional looping, frame-stepping at the document fps.
- **Onion skinning**: ghosted neighboring frames while paused.
- **Projects**: save and open `.oanim` project files (plain JSON documents, also reads `.json`), with an explicit Save/Save As/Open, Ctrl+S / Ctrl+Shift+S / Ctrl+O shortcuts and debounced autosave to the current file.
- **Startup dialog**: shown on launch to start a new project, open a file, or reopen one of the recent projects (stored in the Electron `userData` folder).

## Project layout

```
├── .github/workflows/     # CI workflows (PR check, main build/release)
├── build/                 # Packaging resources (application icon)
├── scripts/               # CI helper scripts (semantic version check)
├── src/
│   ├── main/              # Electron main process (window, IPC, project files)
│   ├── preload/           # Preload scripts (contextBridge API)
│   ├── shared/            # Pure TypeScript document model + unit tests
│   │   ├── api.ts         # IPC contract between main and renderer
│   │   ├── model.ts       # Document / layer / keyframe / shape types
│   │   ├── document.ts    # Document operations and per-frame evaluation
│   │   ├── tween.ts       # Shape interpolation between keyframes
│   │   ├── easing.ts      # Named eases and cubic-bezier solver
│   │   ├── color.ts       # Hex color parsing and interpolation
│   │   ├── geometry.ts    # Vector math helpers
│   │   ├── hitTesting.ts  # Rotation-aware shape hit testing
│   │   ├── recentProjects.ts # Recent-projects list logic
│   │   └── starterDocument.ts
│   └── renderer/          # Editor UI
│       ├── index.html
│       └── src/
│           ├── editor.ts  # Editor state (frame, selection, tools, playback)
│           ├── stage.ts   # SVG stage: rendering, drawing, selection
│           ├── properties.ts # Right properties panel
│           ├── projects.ts   # Save / open / startup dialog orchestration
│           ├── timeline.ts# Timeline panel and playback controls
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
| `npm test`              | Run unit tests with Vitest                               |
| `npm run dist:linux`    | Package Linux installers (AppImage, deb, rpm, Flatpak, tar.gz) |
| `npm run check-version` | Check that the version is greater than the base branch   |

## Keyboard shortcuts

| Keys                | Action                                  |
| ------------------- | --------------------------------------- |
| `V` / `R` / `O`     | Select / Rectangle / Ellipse tool       |
| `Ctrl+S`            | Save the current project                |
| `Ctrl+Shift+S`      | Save the project to a new file          |
| `Ctrl+O`            | Open a project file                     |
| `Space`             | Play / pause                            |
| `Escape`            | Stop and return to frame 1              |
| `F5` / `F6` / `F7`  | Insert frame / keyframe / blank keyframe|
| `Delete`            | Delete the selected shape               |
| Arrow keys          | Nudge the selection (Shift = 10 px)     |

## Versioning and releases

The application follows [semantic versioning](https://semver.org/) with the version tracked in `package.json`.

- **Pull requests** (`pr-check.yml`): install, verify that `package.json` version is strictly greater than the version on the base branch, typecheck, build and test. Every PR must bump the version.
- **Merges to main** (`main-build.yml`): typecheck, test, build, then package Linux artifacts (AppImage, deb, rpm, Flatpak, tar.gz) and publish a GitHub release tagged `v<version>` with generated release notes. If the tag already exists, the release step is skipped.

## License

Copyright (c) Didier Hoarau. All rights reserved.
