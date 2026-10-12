# Contributing

Thanks for looking at OpenAnimator! This guide covers everything CI will
check on your pull request so there are no surprises.

## Development setup

Requirements: Node.js 24 and npm.

```bash
npm install        # installs dependencies (and the Electron binary for E2E)
npm run dev        # start the app with hot reload
```

## Architecture in one screen

```
src/
├── main/       Electron main process: windows, IPC, project file IO,
│               resource store, library/palette persistence, updates
├── preload/    contextBridge API (the typed IPC surface in src/shared/api.ts)
├── shared/     Pure TypeScript: document model, evaluation, render tree,
│               exporters, scripting schema — no Electron imports, ever
├── renderer/   The editor UI: vanilla TypeScript, stage as SVG, timeline,
│               panels, tools
└── cli/        Headless render/validate/schema commands over the shared code
scripts/        CI helpers (version check) and generators (docs site, samples)
e2e/            Playwright-Electron golden-path tests of the built app
```

The one rule that keeps the codebase testable: **`src/shared/` is pure
TypeScript**. It must not import Electron, the DOM or Node built-ins that
only exist in one process — the unit tests (Vitest, node environment) run it
without any Electron present. If a feature needs documents logic, it lives
in `src/shared/` and is unit-tested there; the Electron layers stay thin.

Scripts are another client of the same rule: every scripted command runs the
same editor pipeline as the equivalent UI gesture — never add a second code
path that could desync (see [docs/scripting.md](docs/scripting.md)).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the app with hot reload |
| `npm run build` | Build main / preload / renderer into `out/` (required before E2E) |
| `npm run typecheck` | Typecheck node-side and web-side projects |
| `npm run lint` | ESLint over the repository |
| `npm test` | Unit tests (Vitest) |
| `npm run test:coverage` | Unit tests with the CI coverage thresholds (75% lines/functions/statements/branches over `src/shared/**`) |
| `npm run test:e2e` | Playwright-Electron golden paths against the built app (see below) |
| `npm run samples:build` | Regenerate `docs/samples/*.oanim` + GIF previews (deterministic) |
| `npm run docs:build` | Regenerate `docs/scripting-reference.md` and build the docs site into `site/` |
| `npm run cli -- …` | CLI: `render`, `validate`, `schema` (see `npm run cli -- help`) |
| `npm run check-version` | CI helper: the version must be greater than the base branch's |

### Running the E2E suite

The suite drives the real Electron app, so build first. On a machine with a
display:

```bash
npm run build
npm run test:e2e
```

On headless Linux (CI uses the same command):

```bash
xvfb-run -a npm run test:e2e
```

Notes:

- Playwright's Electron launch does **not** download a browser, but `npm ci`
  must keep the Electron binary (`ELECTRON_SKIP_BINARY_DOWNLOAD` unset).
- The suite runs one worker at a time — every instance shares the app's
  user-data directory and holds the single-instance lock.
- Failures write screenshots and traces to `.tmp/e2e/`; CI uploads that
  directory as an artifact.

### Changing the scripting API or the docs

- Scripting commands: edit `src/shared/scripting/commands.ts` (the
  `COMMANDS_SCHEMA` + `OP_FIELDS` metadata) and the executor in
  `src/renderer/src/scripting/execute.ts`, then add unit tests for both.
  The reference page is generated — run `npm run docs:build` and commit the
  regenerated `docs/scripting-reference.md` (a unit test fails when it is
  stale).
- Docs pages live in `docs/*.md` and are rendered to the GitHub Pages site
  by `scripts/build-docs.ts`; `README.md` and `CONTRIBUTING.md` become the
  Home and Contributing pages.

## Pull requests

Every PR must pass the same gates `pr-check.yml` runs:

1. **Version bump** — the version in `package.json` must be strictly greater
   than the base branch's (`npm run check-version`). Features bump the minor
   (`0.20.0` → `0.21.0`), fixes the patch.
2. **Typecheck** — `npm run typecheck`.
3. **Lint** — `npm run lint`.
4. **Unit tests with coverage** — `npm run test:coverage` (keep `src/shared`
   covered; new logic needs tests in the same PR).
5. **Build** — `npm run build`, and `npm run docs:build` (the docs build is
   part of CI so a broken generator cannot land).
6. **E2E** — the `e2e` job runs the golden-path suite on `xvfb`. If you
   change a golden path's UI, update the suite in the same PR.

In addition:

- Branch names follow the pattern `feature/<date>-<topic>` (or `fix/…`).
- Commit messages use the history's style: `feat: …`, `fix: …` — one
  focused change per commit; PRs are squash-merged.
- Keep the changes focused: a bug fix does not need surrounding cleanup, and
  new features should come with the smallest set of tests that pin the
  behavior.
- Never commit generated build output (`out/`, `site/`, coverage) — the
  `.gitignore` covers all of it. `docs/samples/` and
  `docs/scripting-reference.md` are the two committed generated artifacts,
  regenerated via their npm scripts.

## Good first issues

Issues labeled **good first issue** are scoped to be doable without deep
project knowledge — documentation, small UI fixes, new scripted examples,
workflow polish. **help wanted** marks bigger items where contributions are
welcome; if an issue is unclear, ask in the issue before investing time. A
good first PR is often a new scripting example (`SCRIPT_EXAMPLES` in
`src/shared/scripting/examples.ts` — its payload runs as a unit test, the
docs reference and the gallery all pick it up) or an addition to the docs.

## Reporting bugs and requesting features

Use the issue templates: they ask for the reproduction, the environment and
the exact build. For rendering bugs, attach the `.oanim` (a renamed ZIP of
`document.json` plus resources) whenever possible — it is the fastest path
to a fix.

## Code of conduct

Be kind and constructive. Technical disagreement is welcome; personal
attacks are not.
