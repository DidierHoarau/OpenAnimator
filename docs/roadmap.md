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
| v0.22.0 | Performance — rAF-coalesced stage rendering with keyed incremental patching, structural-sharing undo snapshots, idle-debounced autosave with an incremental recovery packer, and a deterministic 500-node regression benchmark (seek 28→24 ms, drag 44.5→37 ms/move, playback ≈30 fps, 24-frame export ≈1.5 s on the reference machine) |
| v0.23.0 | Editor UX — full application menu over the existing editor commands, keyboard-shortcut cheat sheet and docs page from one shortcut table (plus the F7 timeline leak fix), scene-object clipboard beside the keyframe clipboard, grid snapping with align/distribute, a Preferences dialog replacing hardcoded defaults, and feedback polish (labeled undo, persistent errors, About dialog) |
| v0.24.0 | Vector depth — direct-selection anchor editing (`A`) with the `setPathAnchors` scripting op and multi-subpath support, stroke styles (linecap/linejoin/dash) through model, renderer, UI and SVG round-trip, per-stop gradient alpha, path fill/stroke tweening, the eyedropper with a recent-colors row, and GIMP (`.gpl`) palette import/export |
| v0.25.0 | Motion & Text Depth — path shape morphing between keyframes, per-property tween easing channels (`transform`/`opacity`/`fill`), kerning-true font subsets with italic embedding and a ligature toggle, and frame-locked continuous audio scrub (plus a path-morphing E2E golden path) |
| v0.26.0 | Interchange & Automation — Lottie gradients (with stop alpha), `ty:6` audio layers (embedded in Lottie JSON, `audio/` files in dotLottie), baked smooth paths and text strokes; SVG gradient import (kept in the native gradient model, rasterize fallback for the rest); export presets with last-used persistence, GIF palette/dithering/loop and MP4/WebM quality tiers; CLI multi-format rendering; scripted `export`/file-import/view ops and the UI-gesture script recorder; a gradient→Lottie E2E golden path |
| v0.27.0 | Fixes — the timeline ruler seeks on click (frames are selectable on long timelines) and the layer explorer auto-expands to reveal created objects |
| v0.28.0 | Tests — regression coverage pinning the reported 2–36 span from bug 20026.10.13: every displayed frame 2–36 is selectable from the ruler (no behavior change) |

## What's next

- **Per-character animation (charRange) and per-channel camera keys.** Both
  were stretch items of the v0.25.0 cycle and stay on the list: a `charRange`
  on text nodes for per-character reveal/stagger, and camera keyframes that
  can carry per-property easing channels like object tweens do.
- **Code signing and silent auto-update.** Windows and macOS builds ship
  unsigned; the in-app updater only checks for releases and links to them.
  Signing the installers unlocks silent in-place updates (README, *Platform
  notes*).
- **Lottie subset growth.** v0.26.0 added gradients (with stop alpha),
  audio layers, baked smooth paths and text strokes. Unsupported content in
  Lottie/dotLottie exports still degrades to dashed placeholders with
  per-export diagnostics; the supported subset grows as demand shows up.
- **Scripting follows the UI.** Every new editor capability ships with a
  scripted equivalent through the same pipeline — v0.24.0 added
  `setPathAnchors` for anchor editing (v0.23.0 added `duplicateNodes`,
  `align`, `distribute` and `setPreferences`) — and since v0.26.0 the script
  recorder turns UI gestures into the same command JSON, so the invariant
  stays verifiable as LLM-driven animation keeps full coverage of the tool.
- **E2E golden paths as features land.** The Playwright suite pins the
  golden paths (drawing/tweening, save/reopen, exports, scripting, startup,
  cancellation, close protection, node clipboard, shortcut help, anchor
  editing, the eyedropper, path morphing and the SVG-gradient→Lottie
  import/export path) plus the 500-node performance budget; new major
  features should add their own golden path.

Suggestions are welcome — open an issue (see
[Contributing](contributing.md)) and describe the workflow you need.
