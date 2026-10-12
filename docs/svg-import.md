# Importing SVG as editable vectors

Dropping (or importing) an `.svg` file first tries to convert it into fully
editable vector content: primitive nodes, path nodes and symbol assets, all
selectable, transformable, tweenable and undoable like anything drawn in the
app.

The converter is a **strict, documented subset**. It never imports partial or
approximated artwork: if any element or attribute cannot be represented
faithfully, the whole import fails with a reason and the app falls back to
**rasterizing** the file into a PNG image at 2× (the pre-existing SVG image
path), showing a status-bar note like
`SVG imported as a raster image: unsupported element <filter>`. A clean
fallback beats silently wrong vectors.

## Supported subset

### Elements

| Element | Handling |
| --- | --- |
| `svg` (root) | Viewport: `width`/`height` and `viewBox` (default `xMidYMid meet`; `none` also supported). |
| `g` | Grouping: inherited paint state and `transform` compose down. |
| `rect` | Axis-aligned after transform → rectangle primitive; rounded corners (`rx`/`ry`) or a rotated/sheared transform → path node. |
| `circle` | → ellipse primitive (path when rotated/sheared). |
| `ellipse` | → ellipse primitive (path when rotated/sheared). |
| `line` | → path node. |
| `polyline`, `polygon` | → path node (`polygon` closes). |
| `path` | `M`, `L`, `H`, `V`, `C`, `S`, `Q`, `T`, `Z` (both cases, relative forms included). |
| `linearGradient`, `radialGradient`, `stop` | Paint definitions: collected by id anywhere in the tree (`defs` or not) and resolved from `fill`/`stroke` `url(#id)` references; never drawn directly. |
| `defs` | Definition container: its content never draws (shapes inside are only reachable through `<use>`, which is unsupported); gradients inside are still collected. |
| `title`, `desc`, `metadata` | Ignored (children must be none). |

Anything else (`text`, `use`, `image`, `filter`, `clipPath`, `mask`, `style`
blocks, …) makes the import fall back to rasterization.

### Attributes

| Attribute | Notes |
| --- | --- |
| Geometry attributes | Per element (`x`, `y`, `width`, …); unitless numbers or `px` only. |
| `transform` | `translate`, `scale`, `rotate(a [cx cy])`, `matrix` — baked into the geometry. `skewX`/`skewY` are unsupported. |
| `fill`, `stroke` | `none`, `#rgb`, `#rrggbb` (expanded to lowercase `#rrggbb`), or a `url(#id)` reference to a supported gradient (see below). Named colors, `rgb()`, `currentColor` are unsupported. |
| `stroke-width` | Unitless/px, scaled by the accumulated transform. |
| `stroke-linecap`, `stroke-linejoin` | `butt`/`round`/`square` and `miter`/`round`/`bevel` (case-insensitive; any other value fails the import). |
| `stroke-dasharray` | `none` (≡ solid) or up to 16 unitless/px values, space- or comma-separated; scaled by the accumulated transform. An all-zero pattern imports as a solid stroke (SVG spec). |
| `stroke-dashoffset` | Unitless/px, may be negative, scaled by the accumulated transform. |
| `opacity` | `0..1`, multiplied down the tree. |
| `style` | Only `fill`, `stroke`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `stroke-dasharray`, `stroke-dashoffset`, `opacity` declarations; CSS wins over presentation attributes. Any other declaration fails the import. |
| `id`, `version`, `baseProfile`, `overflow`, `enable-background` | Ignored metadata. |
| `data-*`, namespaced names (`xml:space`, `xlink:*`, …) | Ignored metadata. |

Every other un-namespaced attribute fails the import — that is deliberate:
attributes like `fill-rule`, `stroke-miterlimit` or `class` change how the
artwork renders and cannot be silently dropped. The stroke style attributes
above round-trip: exported SVGs from the app re-import with the same
linecap/linejoin/dash settings.

### Units and colors

- Lengths must be unitless or `px` (`10`, `10.5`, `.5`, `1e2`, `10px`). `mm`,
  `pt`, `%`, `em` are unsupported.
- Colors are only the hex forms above; `#abc` shorthand is expanded.

### Gradients

`<linearGradient>`/`<radialGradient>` definitions are collected by id
wherever they appear — inside `<defs>` or as direct children — and resolved
from `fill`/`stroke` `url(#id)` references, in presentation attributes or
`style`, inherited through groups. Only the part of SVG's gradient model the
native gradient paints reproduce faithfully is accepted:

| Aspect | Accepted | Falls back to rasterization |
| --- | --- | --- |
| Units | `gradientUnits` absent or `objectBoundingBox` | `userSpaceOnUse` |
| Stops | 2–8 stops; `offset` numbers or percentages in 0..1; `stop-color` hex; `stop-opacity` in 0..1 (carried only when ≠ 1) | fewer than 2 or more than 8 stops; `stop-color="none"` or named colors |
| Linear axis | any direction, as long as the axis is unit-length and centered on the box along it (0.02 tolerance): `(0,0)→(1,0)` (default, 0°), `(50%,0)→(50%,100%)` (90°), canonical diagonals like `(14.64%,14.64%)→(85.36%,85.36%)` (45°) | off-center or shortened axes such as `(0,0)→(1,1)` or `(0,0)→(0.9,0)` |
| Radial | `cx`/`cy`/`r` as bounding-box fractions (defaults 0.5/0.5/0.5; radius > 0); a focal point (`fx`/`fy`) within 0.01 of the center | a plainly off-center focal point; a non-positive radius |
| References | exactly one definition per id; `fill="url(#g)"`, `url( #g )` and quoted forms | missing or duplicate ids; `href`/`xlink:href` inheritance; `gradientTransform`; `spreadMethod` other than `pad` |

Accepted gradients round-trip: a shape filled with a native gradient paint
re-imports to the same paint, and duplicate gradient-filled shapes collapse
into symbol assets like any other repeated shape.

## Transform flattening

SVG wraps artwork in viewport and group transforms; the importer bakes them
into the geometry instead of keeping wrapper state:

- the root viewport matrix (`viewBox` + `width`/`height` +
  `preserveAspectRatio`) composes with every `transform` down the tree
  (left-to-right, like SVG);
- a translated/scaled rect or ellipse stays a **primitive** (scale folds into
  `width`/`height`, translation into `center`);
- anything rotated, sheared or otherwise non-axis-aligned becomes a **path
  node** with the matrix applied to every command (stroke widths scale by the
  geometric mean of the matrix);
- degenerate shapes (zero width/height, zero radius, empty `d`, single
  `polyline` point, zero-length `line`) are dropped, and an SVG with nothing
  left to draw fails the import.

## Duplicate shapes become symbol assets (A6)

Repeated identical leaf shapes — same geometry and appearance, ignoring
position/rotation/opacity/name — are collapsed into **one document symbol
asset** each (`Imported symbol 1`, `2`, …), and every occurrence becomes a
symbol instance carrying its own transform. Editing the asset updates every
instance; this keeps imports of repeated UI elements small and keeps the
library meaningful. Non-duplicated shapes stay plain nodes, and groups stay
groups.

The whole import (group + symbol assets) lands on the current layer as **one
undo step** and is placed like an imported image: at natural size centered on
the drop point, capped to the stage.

## Failure reasons

The status bar reports why a file was rasterized instead, e.g.:

- `malformed XML: …` — unparsable markup, mismatched tags, duplicate
  attributes;
- `unsupported element <filter>` / `unsupported attribute "fill-rule" on <path>`;
- `path data uses unsupported or malformed commands (arcs cannot be converted)`;
- `unsupported transform "skewX(10)"`;
- `unsupported color "rgb(255, 0, 0)" (supported: none, #rgb, #rrggbb)`;
- `unsupported linear gradient "g" (only centered full-span axes can be represented natively)`;
- `radial gradient "g" has a focal point, which is not supported`;
- `unsupported gradientUnits "userSpaceOnUse" on <linearGradient> (only objectBoundingBox is supported)`;
- `no supported drawable shapes were found`;
- `the file is not valid UTF-8 text`.

## Implementation notes

The converter (`src/shared/svgImport.ts`) is pure — a handwritten XML parser
plus the subset transformer — so the whole pipeline is unit-tested without a
DOM. Gradient definitions are collected in a first pass (by id, anywhere in
the tree) and resolved lazily per paint, at most once per import. The
renderer integration (`src/renderer/src/imageImport.ts`) only decides between
the vector path and the raster fallback.
