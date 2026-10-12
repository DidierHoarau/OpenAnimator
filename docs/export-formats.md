# Export formats

OpenAnimator exports the current document to eight output formats from two
surfaces: the in-app **Export dialog** (toolbar) and the **headless CLI**
(`npm run cli -- render …`, see [scripting.md](scripting.md)). Both paths
evaluate frames through the same shared code, so camera framing, embedded
fonts and audio timing are identical between the app and the command line.

## Format matrix

| Format | Output artifact | `--scale` | `--transparent` | Audio | Encoder |
| --- | --- | --- | --- | --- | --- |
| `png-sequence` | ZIP of `frame_%04d.png` | yes | yes | silent | resvg (CLI) / canvas (app) + pngjs + zip |
| `gif` | animated GIF89a | yes | yes (1-bit) | silent | shared GIF encoder |
| `webm` | VP9 WebM video | yes | yes — VP9 alpha when available, else opaque + notice | yes (mixed) | WebCodecs (app) / ffmpeg (CLI) |
| `mp4` | H.264 MP4 video | yes | never (always opaque) | yes (mixed) | WebCodecs (app) / ffmpeg (CLI) |
| `lottie` | bodymovin JSON (v5.7.4) | ignored (pinned 1) | inherently transparent | silent | native vector builder (no rasterization) |
| `dotlottie` | dotLottie ZIP | ignored (pinned 1) | inherently transparent | silent | native vector builder |
| `svg-animation` | self-contained animated SVG (CSS keyframes) | display size only | yes | silent | native vector builder |
| `spritesheet` | ZIP: `atlas.png` + `atlas.json` | yes | yes | silent | resvg (CLI) / canvas (app) + atlas packer |

Options common to every format: `--fps` 1–60 (default: document fps),
`--from` / `--to` (0-based inclusive range, default the full document) and
`--transparent`. `sanitizeExportOptions` clamps all of these: transparency is
dropped for MP4 (no alpha codec in the container) and the Lottie formats pin
`scale` to 1 (their resolution is inherent to the consuming player). The CLI
derives the format from the `--out` extension when `--format` is omitted
(`.zip` → PNG sequence, `.gif`, `.webm`, `.mp4`, `.json` → Lottie,
`.lottie` → dotLottie, `.svg` → animated SVG); the spritesheet has no unique
extension and requires `--format spritesheet`.

The PNG-sequence, GIF and spritesheet exporters were unchanged by the vector
work: they rasterize each frame through the shared SVG path and keep alpha on
empty areas. GIF encoding now runs in a worker thread so the dialog stays
responsive; the output bytes are identical to the inline encoder.

## Cancelling an export

The export dialog's **Cancel** button (or ×, or Escape) sets the runner's
cancel signal, and the runner stops within one frame. A canceled export never
creates the destination file: the archive formats (PNG sequence, spritesheet)
stream into a `*.tmp` staging file that is removed on abort, and the one-shot
formats are only written after the last cancel check. The status bar reports
*Export canceled*. The same discipline applies to failures — a broken export
leaves no partial destination behind, and the form stays open for a retry.

## Lottie (`lottie`) and dotLottie (`dotlottie`)

Built natively from the evaluated document — no rasterization, no ffmpeg —
so they work identically in the app and the CLI. The JSON targets bodymovin
`v: "5.7.4"` (verified against lottie-web in CI, see *Render gate* below).

| Document content | Lottie output |
| --- | --- |
| Primitives (rect/ellipse) | `rc`/`el` shape items, stroke items before fill items |
| Paths | `sh` bezier shape items (`pathDataToSubpathAnchors` conversion); a `d` that changes across keyframes morphs between poses when the anchor structure matches (subpath and anchor counts, closed flags) and holds the outline where it differs |
| Groups | nested `gr` items, children reversed to match Lottie's paint order |
| Images | embedded data-URL image assets (`e: 1`), deduplicated per resource |
| Drawing layers | one full-stage image asset per cell (natural size = document size × the layer's resolution scale), held until the next cell |
| Text | outlines via the same font resolution as the app (embedded subset, then bundled Noto Sans); fonts are **never** embedded (licensing) |
| Camera layer | wraps the content in a `precomp_main` precomp layer whose position/rotation/zoom are keyframed |
| Tweens | keyframed bezier channels: the named eases and custom beziers are exact, including per-property easing channels (`transform`/`opacity`/`fill`); `holdStep` playback and hold keyframes are baked as hold keys sampled through the evaluator |
| Audio layers | dropped — the export is silent |

Degradations (each reported as an export diagnostic, never a crash):

- `A 'smooth' tween path is exported as linear interpolation in the Lottie file.`
- `The path data of "…" cannot morph between keyframes (the anchor structure differs); the Lottie file holds the outline over those segments.`
- `The path data of "…" changes shape across keyframes; the Lottie file keeps the first outline.`
- `A gradient paint is exported as its first stop color in the Lottie file.`
- `A text stroke is dropped when text is exported as outlines in the Lottie file.`
- `Text "…" changes across keyframes; the Lottie file outlines the first pose.`
- `No font could be loaded for "…"; a placeholder box replaces "…" in the Lottie file.`
- `Image resource "…" could not be resolved; a placeholder is exported.`
- `Audio is not included in Lottie exports; the exported animation is silent.`

Placeholders are the same dashed boxes the SVG renderer draws for missing
content. Lottie files carry no background: the composition is transparent by
construction (players paint their own backdrop).

**dotLottie** packs the same animation as a ZIP: `manifest.json`
(`version: "1.0"`, `generator: "OpenAnimator <app version>"`, one animation
entry `openanimator`, `loop: true`) plus `animations/animation.json`.

**Render gate**: the CI test suite renders golden Lottie documents with
lottie-web (SVG renderer, `happy-dom`) and asserts the resulting transform
matrices and fills — camera decomposition, easings and hold keys are checked
against a real player, not just the JSON structure.

## Animated SVG (`svg-animation`)

One self-contained SVG file whose elements are emitted once with geometry and
paints frozen at their first appearance; every change over time becomes a CSS
`@keyframes` rule. Path data is the one geometry that animates outside CSS
(see below). Documents with no animation emit no `<style>` block at all, so
static exports stay pixel-identical to the inline markup.

- Each animated element gets an `#oa-i-N{animation:oa-k-N <count/fps>s linear
  infinite}` rule plus a `@keyframes` block, with
  `transform-box:view-box;transform-origin:0 0` added when the transform is
  animated.
- A keyframe is emitted at every frame where the pose changes — eased and
  linear tweens are therefore baked per frame and exact — while held values
  (hold keyframes, the document hold step) collapse into one keyframe. A
  final `100%` keyframe holds the last values.
- The static `transform` attribute carries the first pose as a fallback for
  players without CSS animation support.
- Animatable properties: `transform`, `opacity`, `fill`, `stroke`,
  `stroke-width` and `visibility` (image runs — a drawing cell or image
  change toggles visibility instead of re-emitting the element).
- Path data is the one geometry that animates: a `<path>` whose `d` changes
  across the export carries a per-frame SMIL `<animate attributeName="d">`
  child whose values are interpolated linearly when every sampled frame
  shares one command signature (the morph-compatible case, canonical
  strings) and frame-stepped (`calcMode="discrete"`, the exact evaluator
  strings) otherwise.
- Text ships as outlines (same provider as Lottie); the camera layer becomes
  one wrapper `<g>` with an animated transform. `--scale` only sets the
  root's `width`/`height` attributes — the `viewBox` keeps document
  coordinates.

Degradations (diagnostics, never a crash):

- `A gradient paint in "…" changes over time; the animated SVG keeps its first appearance.`
- `The paint order of "…" changes across frames; the animated SVG keeps the first order.`
- `"…" changes its object type across frames; the animated SVG keeps the first appearance.`
- `Text "…" changes across frames; the animated SVG keeps the first outline.`
- `A text stroke is dropped when text is exported as outlines in the animated SVG.`
- `No font could be loaded for "…"; a placeholder box replaces "…" in the animated SVG.`
- `The resource of "…" is missing; a placeholder box is shown in the animated SVG.`
- `Audio is not included in animated SVG exports; the exported animation is silent.`

## Alpha WebM

WebM is the alpha-capable video format; MP4 is always opaque.

- **In the app** the encoder probes WebCodecs for VP9 with
  `alpha: 'keep'` at the export's pixel size. When the probe succeeds the
  canvas source encodes with alpha; otherwise the export falls back to opaque
  and the status bar reports *without transparency (no VP9 alpha encoder in
  this environment)*.
- **In the CLI** transparency maps to ffmpeg's `-pix_fmt yuva420p` with
  `-auto-alt-ref 0` (libvpx requires the alt-ref feature off for alpha).
  Audio from the document's audible layers is mixed into WebM/MP4 through
  the same `AudioMixEntry` plan the app uses; every other format is silent.

## Spritesheet

`spritesheet` renders the requested frame range and packs the frames
row-wise into a near-square atlas (starting from the minimal pixel-square and
growing wider, capped at 7680 px per side; frames that cannot fit produce a
descriptive error). The output is a ZIP with:

- `atlas.png` — the RGBA atlas (alpha on empty areas),
- `atlas.json` — TexturePacker JSON-Hash metadata (frames named
  `frame_%04d` like the PNG sequence) plus an `openanimator` block with
  `fps`, `fromFrame`, `toFrame` and `frameCount`, so any player can
  reconstruct the timing.

## Diagnostics

The vector formats never fail on unsupported content: each degradation turns
into a dashed placeholder and/or a diagnostic string. The app appends the
diagnostic count to its success message and — when a successful export
carries any — keeps the export dialog open in a done state with a collapsible
list of every diagnostic, until **Close**. The CLI prints every diagnostic
line under the `Wrote …` summary. All diagnostics listed above are covered
by unit tests, and the golden fixtures under
`src/shared/fixtures/export/` pin the full output of both vector formats.
