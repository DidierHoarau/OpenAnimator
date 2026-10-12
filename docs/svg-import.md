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
| `title`, `desc`, `metadata` | Ignored (children must be none). |

Anything else (`text`, `use`, `image`, `defs`, `linearGradient`, `filter`,
`clipPath`, `mask`, `style` blocks, …) makes the import fall back to
rasterization.

### Attributes

| Attribute | Notes |
| --- | --- |
| Geometry attributes | Per element (`x`, `y`, `width`, …); unitless numbers or `px` only. |
| `transform` | `translate`, `scale`, `rotate(a [cx cy])`, `matrix` — baked into the geometry. `skewX`/`skewY` are unsupported. |
| `fill`, `stroke` | `none`, `#rgb`, `#rrggbb` only (expanded to lowercase `#rrggbb`). Named colors, `rgb()`, `currentColor`, `url(#…)` paints are unsupported. |
| `stroke-width` | Unitless/px, scaled by the accumulated transform. |
| `opacity` | `0..1`, multiplied down the tree. |
| `style` | Only `fill`, `stroke`, `stroke-width`, `opacity` declarations; CSS wins over presentation attributes. Any other declaration fails the import. |
| `id`, `version`, `baseProfile`, `overflow`, `enable-background` | Ignored metadata. |
| `data-*`, namespaced names (`xml:space`, `xlink:*`, …) | Ignored metadata. |

Every other un-namespaced attribute fails the import — that is deliberate:
attributes like `fill-rule`, `stroke-linecap` or `class` change how the artwork
renders and cannot be silently dropped.

### Units and colors

- Lengths must be unitless or `px` (`10`, `10.5`, `.5`, `1e2`, `10px`). `mm`,
  `pt`, `%`, `em` are unsupported.
- Colors are only the hex forms above; `#abc` shorthand is expanded.

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
- `no supported drawable shapes were found`;
- `the file is not valid UTF-8 text`.

## Implementation notes

The converter (`src/shared/svgImport.ts`) is pure — a handwritten XML parser
plus the subset transformer — so the whole pipeline is unit-tested without a
DOM. The renderer integration (`src/renderer/src/imageImport.ts`) only decides
between the vector path and the raster fallback.
