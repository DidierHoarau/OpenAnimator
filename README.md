# OpenAnimator

OpenAnimator is an open-source, vector-based animation tool built as an Electron desktop application in TypeScript.

## Status

This repository contains the project scaffold: an Electron + TypeScript application shell, a shared vector-scene library (shapes, keyframes, easing), a minimal SVG stage rendering an animated demo scene, and the CI/CD pipelines.

## Tech stack

- [Electron](https://www.electronjs.org/) with a [electron-vite](https://electron-vite.org/) build setup (main / preload / renderer)
- TypeScript with strict mode, split into node-side and web-side type checking
- Vanilla TypeScript renderer rendering vector shapes as SVG — no UI framework is committed yet
- [Vitest](https://vitest.dev/) for unit tests (pure logic lives in `src/shared/` so it is testable without Electron)
- [electron-builder](https://www.electron.build/) for Linux packaging (AppImage, deb, tar.gz)

## Project layout

```
├── .github/workflows/     # CI workflows (PR check, main build/release)
├── build/                 # Packaging resources (application icon)
├── scripts/               # CI helper scripts (semantic version check)
├── src/
│   ├── main/              # Electron main process
│   ├── preload/           # Preload scripts (contextBridge API)
│   ├── shared/            # Pure TypeScript shared by all processes + unit tests
│   │   ├── api.ts         # IPC contract between main and renderer
│   │   ├── geometry.ts    # Vector math helpers
│   │   ├── scene.ts       # Vector scene model (shapes, keyframes)
│   │   └── animation.ts   # Keyframe evaluation over the scene timeline
│   └── renderer/          # Renderer UI (SVG stage)
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
| `npm run dist:linux`    | Package Linux installers (AppImage, deb, tar.gz)         |
| `npm run check-version` | Check that the version is greater than the base branch   |

## Versioning and releases

The application follows [semantic versioning](https://semver.org/) with the version tracked in `package.json`.

- **Pull requests** (`pr-check.yml`): install, verify that `package.json` version is strictly greater than the version on the base branch, typecheck, build and test. Every PR must bump the version.
- **Merges to main** (`main-build.yml`): typecheck, test, build, then package Linux artifacts (AppImage, deb, tar.gz) and publish a GitHub release tagged `v<version>` with generated release notes. If the tag already exists, the release step is skipped.

## License

Copyright (c) Didier Hoarau. All rights reserved.
