# Getting started

OpenAnimator is a vector-based animation tool: draw shapes, paths and text on
keyframes, tween between poses, paint frame-by-frame raster layers, and
export everything as GIF, video, Lottie, animated SVG or PNG sequences. The
whole stage is rendered as SVG through one shared pipeline, so what you see
is what every exporter writes.

This page is the five-minute tour. For the full picture see
[Features](features.md); to drive the editor from a script head to
[Scripting](scripting.md).

## Install and run

Requirements: Node.js 24 and npm.

```bash
git clone https://github.com/DidierHoarau/OpenAnimator
cd OpenAnimator
npm install
npm run dev        # start the app with hot reload
```

Prebuilt installers for Linux, Windows and macOS are attached to every
[release](https://github.com/DidierHoarau/OpenAnimator/releases).

On launch the startup dialog offers a **New project**, **Open…** for an
existing `.oanim` file, and your recent projects. On a first run the starter
demo is loaded so there is something on the stage to play with.

## Your first animation

1. **New project.** Pick *New project* in the startup dialog: one empty
   object layer, 960×540, 24 fps.
2. **Draw.** Press `R` (rectangle) and drag on the stage. The shape lands on
   the current layer at the playhead and is auto-selected; `V` switches back
   to the select tool.
3. **Add a pose.** On the timeline, click the layer row's `+ Frame` control
   until the timeline is long enough, seek to a later frame by clicking that
   frame's cell on the layer's track, then click **+ Keyframe** in the right
   properties panel — the pose is copied forward as a hold.
4. **Move it.** With the shape still selected, drag it on the stage at that
   later frame: the drag is auto-keyed, so the rectangle now has two poses.
5. **Tween.** Seek back to the first keyframe, and click **Tween** in the
   properties panel. A tween span appears on the timeline; pick an easing
   curve (or draw your own in the curve editor).
6. **Play.** Press `Space` to play the loop.
7. **Export.** Toolbar → **Export…** chooses format (GIF, MP4/WebM video,
   Lottie, animated SVG, PNG sequence, spritesheet), resolution scale, fps
   and frame range. See [Export formats](export-formats.md) for the matrix.
8. **Save.** `Ctrl+S` writes the `.oanim` project — a ZIP container with the
   document JSON plus every referenced resource; autosave only maintains a
   crash-recovery snapshot, the file itself changes on explicit saves.

## Other first steps

- **Text**: `T` places a text node; the Text properties section has family,
  size, weight, spacing and an outline. Fonts are embedded as glyph subsets
  on save so a shared `.oanim` renders identically anywhere (see
  [Font embedding](font-embedding.md)).
- **Frame-by-frame drawing**: add a drawing layer and paint with the brush
  (`B`) and eraser (`E`) — each stroke becomes a cell on the timeline's
  filmstrip.
- **Symbols and the library**: select artwork and press `F8` to turn it into
  a reusable symbol; instances stay linked until *Break Apart*.
- **Scripting**: toolbar → **Script…** runs JSON command payloads through
  the exact same editor pipeline as UI gestures — draw the walk cycle in
  [the gallery](gallery.md) from five poses of JSON.
- **Headless**: `npm run cli -- render docs/samples/bouncing-ball.oanim --out ball.gif`
  renders a project from the command line, and
  `npm run cli -- schema --out commands-v1.json` exports the command schema
  for tooling.

## Essential keyboard shortcuts

| Keys                | Action                                  |
| ------------------- | --------------------------------------- |
| `V` / `R` / `O`     | Select / Rectangle / Ellipse tool       |
| `L` / `P` / `T`     | Line / Pen / Text tool                  |
| `N` / `B` / `E`     | Vector brush / Brush / Eraser tool      |
| `Space`             | Play / pause                            |
| `F5` / `F6` / `F7`  | Insert frame / keyframe (or duplicate cell) / blank keyframe (or cell) |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo                       |
| `Ctrl+G` / `Ctrl+Shift+G` | Group / ungroup                   |
| `F8`                | Save the selection as a symbol          |
| `Ctrl+S` / `Ctrl+Shift+S` / `Ctrl+O` | Save / Save As / Open     |
| `Ctrl+I`            | Import an image                         |
| `Ctrl+0` / `+` / `-`| Reset / in / out stage zoom             |

The [README](README.md) lists the complete set.
