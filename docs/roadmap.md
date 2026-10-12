# Roadmap

OpenAnimator grew through seven roadmap groups, released as minor versions.
The seventh and closing group — automation and quality — shipped as v0.20.0;
this page records what landed and what is being considered next.

## Shipped

| Release | Milestone |
| --- | --- |
| v0.9.0 | Images and the versioned ZIP `.oanim` project format |
| v0.10.0 | Asset library and symbol instances |
| v0.11.0 | Frame-by-frame drawing layers and paint tools |
| v0.12.0 | Reliability, UI foundations, scene tooling, the export pipeline and the first scripting API |
| v0.14.0 | Keyframe editing, motion paths, hold step and onion options (Timeline & Motion UX) |
| v0.15.0 | Gradients, vector brush, SVG import and color palettes |
| v0.16.0 | Text and font system — system fonts, subset embedding, typography |
| v0.17.0 | Camera and audio layers with sound in WebM/MP4 exports |
| v0.18.0 | Lottie, animated SVG, alpha WebM and spritesheet exports |
| v0.19.0 | Windows/macOS builds, update notifications, `.oanim` file associations, crash recovery |
| v0.19.1 | Release-job fixes |
| v0.20.0 | Automation & quality — scripting expansion (groups, symbols, library bridge, frame/cell ops), Playwright-Electron E2E suite in PR CI, the docs site with the auto-generated scripting reference and sample gallery, community files |
| v0.21.0 | Stability — cancellable exports with staged writes and a GIF encode worker, unsaved-changes close protection, crash recovery for never-saved documents, in-app modals replacing native dialogs, export diagnostics surfacing, two new E2E golden paths |

## What's next

- **Code signing and silent auto-update.** Windows and macOS builds ship
  unsigned; the in-app updater only checks for releases and links to them.
  Signing the installers unlocks silent in-place updates (README, *Platform
  notes*).
- **Lottie subset growth.** Unsupported content in Lottie/dotLottie exports
  degrades to dashed placeholders with per-export diagnostics; the supported
  subset grows as demand shows up.
- **Scripting follows the UI.** Every new editor capability ships with a
  scripted equivalent through the same pipeline, so LLM-driven animation
  keeps full coverage of the tool.
- **E2E golden paths as features land.** The Playwright suite pins the
  current five paths; new major features should add their own golden path.

Suggestions are welcome — open an issue (see
[Contributing](contributing.md)) and describe the workflow you need.
