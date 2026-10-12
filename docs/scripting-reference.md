# Scripting command reference

> Generated from `COMMANDS_SCHEMA` and the field metadata in `src/shared/scripting/commands.ts` — do not edit by hand.
> Run `npm run docs:build` after changing the schema.

A script is a JSON object `{ "commands": [ ... ] }`. Commands run in order through the
same editor pipeline as UI gestures (one undo entry per command) and each command is the
`op` plus the fields below. Unknown ops, missing required fields and extra fields are
rejected before anything runs.

Machine-readable schema: `commands-v1.json` (export it with `npm run cli -- schema --kind commands`).

## Commands at a glance

- [`addLayer`](#addlayer) — Add a layer (`object`, `drawing`, `camera` or `audio`) and select it.
- [`renameLayer`](#renamelayer) — Rename an existing layer.
- [`removeLayer`](#removelayer) — Delete a layer and everything on it.
- [`addNode`](#addnode) — Add a scene node (primitive, path, text, image, group or symbol) to a layer, optionally at a frame.
- [`updateNode`](#updatenode) — Patch node properties (position, size, rotation, opacity, colors, text, ...); at a frame on a keyed node this sets a keyframe.
- [`deleteNode`](#deletenode) — Delete a node from its layer.
- [`setKeyframe`](#setkeyframe) — Insert or update a keyframe: applies a patch at a frame and/or creates an empty keyframe.
- [`removeNodeKeyframe`](#removenodekeyframe) — Remove the keyframe of a node at a frame.
- [`setTween`](#settween) — Set the interpolation (easing / motion path) of a node or camera keyframe.
- [`moveKeyframe`](#movekeyframe) — Move the keyframe at `fromFrame` to `toFrame`.
- [`copyKeyframes`](#copykeyframes) — Copy the keyframe range `fromFrame`..`toFrame` so it starts at `targetFrame`.
- [`setHoldStep`](#setholdstep) — Quantize hand-drawn strokes to every N-th frame (turn N-1 frames into holds).
- [`setCell`](#setcell) — Set the drawing cell of a drawing layer at a frame (exposures).
- [`setDuration`](#setduration) — Change the document duration in frames.
- [`setFps`](#setfps) — Change the document frame rate.
- [`setPalette`](#setpalette) — Replace the color palette (1–48 `#rgb`/`#rrggbb` colors).
- [`seek`](#seek) — Move the playhead to a frame.
- [`setCameraKeyframe`](#setcamerakeyframe) — Set a camera keyframe (pan/zoom/rotate) at a frame.
- [`removeCameraKeyframe`](#removecamerakeyframe) — Remove the camera keyframe at a frame.
- [`setAudio`](#setaudio) — Adjust an audio layer: start frame, volume, mute.
- [`group`](#group) — Group nodes into a group node (one undo entry).
- [`ungroup`](#ungroup) — Dissolve a group node, lifting its children back into the layer.
- [`breakApart`](#breakapart) — Break a symbol instance back into plain nodes (drifts from the symbol).
- [`createSymbol`](#createsymbol) — Create a symbol asset from nodes and replace them with an instance.
- [`placeAsset`](#placeasset) — Place an instance of a symbol asset on a layer, optionally at a position.
- [`editSymbol`](#editsymbol) — Enter symbol edit mode for an asset (the stage shows the symbol contents).
- [`endSymbolEdit`](#endsymboledit) — Leave symbol edit mode, committing or discarding the changes.
- [`renameAsset`](#renameasset) — Rename a symbol asset.
- [`duplicateAsset`](#duplicateasset) — Duplicate a symbol asset (instances of the copy are independent).
- [`deleteAsset`](#deleteasset) — Delete a symbol asset; existing instances become placeholders.
- [`saveToLibrary`](#savetolibrary) — Save a symbol asset to the global My Library.
- [`insertFromLibrary`](#insertfromlibrary) — Insert an asset from the global My Library (`assetId` or exact `name`) onto a layer.
- [`insertFrames`](#insertframes) — Insert `count` hold frames at a frame, shifting later content.
- [`removeFrames`](#removeframes) — Remove `count` frames at a frame, pulling later content back.
- [`moveCell`](#movecell) — Move the drawing cell at `fromFrame` to `toFrame`.
- [`moveNodeToFrame`](#movenodetoframe) — Retime a node: move its whole keyframe track so it starts at `targetFrame`.
- [`duplicateNodes`](#duplicatenodes) — Duplicate the currently selected nodes at +10/+10 (one undo entry).
- [`align`](#align) — Align the selected objects to their union bounds (`left`, `centerH`, `right`, `top`, `middle`, `bottom`; needs at least two objects).
- [`distribute`](#distribute) — Space the selected objects evenly along `h` or `v` (outermost two fixed; needs at least three objects).
- [`setPreferences`](#setpreferences) — Merge a partial preferences patch (sanitized and persisted) into the application settings.

## Conventions

- `layerId`: target layer; the executor falls back to the current layer and warns.
- `frame`: 0-based frame; defaults to the playhead and the executor warns.
- `at`: stage position `{x,y}` for placed assets.
- `nodeIds`: non-empty list of node ids on the target layer.
- `patch`: partial node update: only known fields, unknown ones are rejected.
- Created or chosen ids are reported back as warnings so a model can chain later commands.
- Colors accept `#rgb`/`#rrggbb` or a gradient object; see `paint` in the schema for the exact shape.

## Command details

### addLayer

Add a layer (`object`, `drawing`, `camera` or `audio`) and select it.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `kind` | string | no | one of `object`, `drawing`, `camera`, `audio` |
| `name` | string | no | — |
| `resourceId` | string | no | — |
| `startFrame` | integer | no | min 0 |

### renameLayer

Rename an existing layer.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `layerId` | string | yes | — |
| `name` | string | yes | — |

### removeLayer

Delete a layer and everything on it.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `layerId` | string | yes | — |

### addNode

Add a scene node (primitive, path, text, image, group or symbol) to a layer, optionally at a frame.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `node` | object | yes | — |
| `layerId` | string | no | — |
| `frame` | integer | no | min 0 |

### updateNode

Patch node properties (position, size, rotation, opacity, colors, text, ...); at a frame on a keyed node this sets a keyframe.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `nodeId` | string | yes | — |
| `layerId` | string | no | — |
| `frame` | integer | no | min 0 |
| `patch` | object | yes | — |

### deleteNode

Delete a node from its layer.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `nodeId` | string | yes | — |
| `layerId` | string | no | — |

### setKeyframe

Insert or update a keyframe: applies a patch at a frame and/or creates an empty keyframe.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `nodeId` | string | yes | — |
| `layerId` | string | no | — |
| `frame` | integer | no | min 0 |
| `patch` | object | no | — |

### removeNodeKeyframe

Remove the keyframe of a node at a frame.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `nodeId` | string | yes | — |
| `layerId` | string | no | — |
| `frame` | integer | no | min 0 |

### setTween

Set the interpolation (easing / motion path) of a node or camera keyframe.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `layerId` | string | no | — |
| `frame` | integer | no | min 0 |
| `easing` | string | no | one of `linear`, `ease-in`, `ease-out`, `ease-in-out`; may be `null`; string or cubic-bezier object `{x1,y1,x2,y2}` |
| `path` | string | no | one of `linear`, `smooth` |

### moveKeyframe

Move the keyframe at `fromFrame` to `toFrame`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `nodeId` | string | yes | — |
| `layerId` | string | no | — |
| `fromFrame` | integer | yes | min 0 |
| `toFrame` | integer | yes | min 0 |

### copyKeyframes

Copy the keyframe range `fromFrame`..`toFrame` so it starts at `targetFrame`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `nodeId` | string | yes | — |
| `layerId` | string | no | — |
| `fromFrame` | integer | yes | min 0 |
| `toFrame` | integer | no | min 0 |
| `targetFrame` | integer | yes | min 0 |

### setHoldStep

Quantize hand-drawn strokes to every N-th frame (turn N-1 frames into holds).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `step` | integer | yes | min 1; max 16 |

### setCell

Set the drawing cell of a drawing layer at a frame (exposures).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `layerId` | string | no | — |
| `frame` | integer | no | min 0 |
| `resourceId` | string | yes | — |

### setDuration

Change the document duration in frames.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `frames` | integer | yes | min 1 |

### setFps

Change the document frame rate.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `fps` | number | yes | greater than 0 |

### setPalette

Replace the color palette (1–48 `#rgb`/`#rrggbb` colors).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `colors` | array | yes | `#rgb`/`#rrggbb` strings; at most 48 items |

### seek

Move the playhead to a frame.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `frame` | integer | yes | min 0 |

### setCameraKeyframe

Set a camera keyframe (pan/zoom/rotate) at a frame.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `frame` | integer | yes | min 0 |
| `center` | object | no | — |
| `zoom` | number | no | greater than 0 |
| `rotation` | number | no | — |
| `tween` | boolean | no | — |

### removeCameraKeyframe

Remove the camera keyframe at a frame.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `frame` | integer | yes | min 0 |

### setAudio

Adjust an audio layer: start frame, volume, mute.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `layerId` | string | yes | — |
| `startFrame` | integer | no | min 0 |
| `volume` | number | no | min 0; max 1 |
| `muted` | boolean | no | — |

### group

Group nodes into a group node (one undo entry).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `nodeIds` | array | yes | strings; at least 1 item |
| `layerId` | string | no | — |
| `frame` | integer | no | min 0 |

### ungroup

Dissolve a group node, lifting its children back into the layer.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `nodeIds` | array | yes | strings; at least 1 item |
| `layerId` | string | no | — |
| `frame` | integer | no | min 0 |

### breakApart

Break a symbol instance back into plain nodes (drifts from the symbol).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `nodeId` | string | yes | — |
| `layerId` | string | no | — |
| `frame` | integer | no | min 0 |

### createSymbol

Create a symbol asset from nodes and replace them with an instance.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `nodeIds` | array | yes | strings; at least 1 item |
| `layerId` | string | no | — |
| `frame` | integer | no | min 0 |
| `name` | string | no | — |

### placeAsset

Place an instance of a symbol asset on a layer, optionally at a position.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `assetId` | string | yes | — |
| `layerId` | string | no | — |
| `frame` | integer | no | min 0 |
| `at` | object | no | — |

### editSymbol

Enter symbol edit mode for an asset (the stage shows the symbol contents).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `assetId` | string | yes | — |

### endSymbolEdit

Leave symbol edit mode, committing or discarding the changes.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `commit` | boolean | yes | — |

### renameAsset

Rename a symbol asset.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `assetId` | string | yes | — |
| `name` | string | yes | — |

### duplicateAsset

Duplicate a symbol asset (instances of the copy are independent).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `assetId` | string | yes | — |

### deleteAsset

Delete a symbol asset; existing instances become placeholders.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `assetId` | string | yes | — |

### saveToLibrary

Save a symbol asset to the global My Library.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `assetId` | string | yes | — |

### insertFromLibrary

Insert an asset from the global My Library (`assetId` or exact `name`) onto a layer.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `assetId` | string | no | — |
| `name` | string | no | — |
| `layerId` | string | no | — |
| `frame` | integer | no | min 0 |
| `at` | object | no | — |

### insertFrames

Insert `count` hold frames at a frame, shifting later content.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `layerId` | string | no | — |
| `frame` | integer | no | min 0 |
| `count` | integer | no | min 1; max 999 |

### removeFrames

Remove `count` frames at a frame, pulling later content back.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `layerId` | string | no | — |
| `frame` | integer | no | min 0 |
| `count` | integer | no | min 1; max 999 |

### moveCell

Move the drawing cell at `fromFrame` to `toFrame`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `layerId` | string | no | — |
| `fromFrame` | integer | yes | min 0 |
| `toFrame` | integer | yes | min 0 |

### moveNodeToFrame

Retime a node: move its whole keyframe track so it starts at `targetFrame`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `nodeId` | string | yes | — |
| `layerId` | string | no | — |
| `targetFrame` | integer | yes | min 0 |

### duplicateNodes

Duplicate the currently selected nodes at +10/+10 (one undo entry).

_No fields._

### align

Align the selected objects to their union bounds (`left`, `centerH`, `right`, `top`, `middle`, `bottom`; needs at least two objects).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `mode` | string | yes | one of `left`, `centerH`, `right`, `top`, `middle`, `bottom` |

### distribute

Space the selected objects evenly along `h` or `v` (outermost two fixed; needs at least three objects).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `axis` | string | yes | one of `h`, `v` |

### setPreferences

Merge a partial preferences patch (sanitized and persisted) into the application settings.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `preferences` | object | yes | — |

## Examples

Every example below is a complete payload that runs against a fresh 960x540 document.
The script console ships the same list in its example picker.

### Bouncing ball

A red ball falls from the top of the stage and bounces off the floor.

```json
{
  "commands": [
    {
      "op": "addLayer",
      "kind": "object",
      "name": "Ball"
    },
    {
      "op": "addNode",
      "frame": 0,
      "node": {
        "type": "primitive",
        "id": "ball",
        "primitive": "ellipse",
        "name": "Ball",
        "width": 90,
        "height": 90,
        "center": {
          "x": 480,
          "y": 100
        },
        "rotation": 0,
        "opacity": 1,
        "fill": "#ff5252"
      }
    },
    {
      "op": "setTween",
      "frame": 0,
      "easing": "ease-in"
    },
    {
      "op": "updateNode",
      "nodeId": "ball",
      "frame": 11,
      "patch": {
        "center": {
          "x": 480,
          "y": 450
        }
      }
    },
    {
      "op": "setTween",
      "frame": 11,
      "easing": "ease-out"
    },
    {
      "op": "updateNode",
      "nodeId": "ball",
      "frame": 23,
      "patch": {
        "center": {
          "x": 480,
          "y": 100
        }
      }
    },
    {
      "op": "setDuration",
      "frames": 24
    }
  ]
}
```

### Title card fade-in

A centered title fades in from transparent over one second.

```json
{
  "commands": [
    {
      "op": "addLayer",
      "kind": "object",
      "name": "Title"
    },
    {
      "op": "addNode",
      "frame": 0,
      "node": {
        "type": "text",
        "id": "title",
        "text": "OPENANIMATOR",
        "fontFamily": "Noto Sans",
        "fontSize": 72,
        "fontWeight": 700,
        "align": "center",
        "fill": "#ffffff",
        "width": 720,
        "height": 90,
        "center": {
          "x": 480,
          "y": 270
        },
        "rotation": 0,
        "opacity": 0
      }
    },
    {
      "op": "setTween",
      "frame": 0,
      "easing": "linear"
    },
    {
      "op": "updateNode",
      "nodeId": "title",
      "frame": 23,
      "patch": {
        "opacity": 1
      }
    },
    {
      "op": "setDuration",
      "frames": 24
    }
  ]
}
```

### Retimed slide (moved keyframe + hold step)

A square slides across with a smooth arc; the middle pose is retimed and playback runs on twos.

```json
{
  "commands": [
    {
      "op": "addLayer",
      "kind": "object",
      "name": "Square"
    },
    {
      "op": "addNode",
      "frame": 0,
      "node": {
        "type": "primitive",
        "id": "square",
        "primitive": "rect",
        "name": "Square",
        "width": 80,
        "height": 80,
        "center": {
          "x": 120,
          "y": 270
        },
        "rotation": 0,
        "opacity": 1,
        "fill": "#38bdf8"
      }
    },
    {
      "op": "setTween",
      "frame": 0,
      "easing": {
        "x1": 0.42,
        "y1": 0,
        "x2": 0.58,
        "y2": 1
      },
      "path": "smooth"
    },
    {
      "op": "updateNode",
      "nodeId": "square",
      "frame": 11,
      "patch": {
        "center": {
          "x": 480,
          "y": 150
        }
      }
    },
    {
      "op": "updateNode",
      "nodeId": "square",
      "frame": 23,
      "patch": {
        "center": {
          "x": 840,
          "y": 270
        }
      }
    },
    {
      "op": "moveKeyframe",
      "nodeId": "square",
      "fromFrame": 11,
      "toFrame": 9
    },
    {
      "op": "setHoldStep",
      "step": 2
    },
    {
      "op": "setDuration",
      "frames": 24
    }
  ]
}
```

### Walk cycle

A stick figure walks in place: five flip-book limb/body poses over 24 frames, no tween.

```json
{
  "commands": [
    {
      "op": "addLayer",
      "kind": "object",
      "name": "Walk"
    },
    {
      "op": "addNode",
      "frame": 0,
      "node": {
        "type": "primitive",
        "id": "body",
        "primitive": "ellipse",
        "name": "Body",
        "width": 70,
        "height": 130,
        "center": {
          "x": 480,
          "y": 290
        },
        "rotation": 0,
        "opacity": 1,
        "fill": "#fde68a",
        "stroke": "#f59e0b",
        "strokeWidth": 4
      }
    },
    {
      "op": "addNode",
      "frame": 0,
      "node": {
        "type": "path",
        "id": "leg-left",
        "name": "Leg L",
        "d": "M 0 0 L 0 90",
        "width": 20,
        "height": 90,
        "center": {
          "x": 466,
          "y": 350
        },
        "rotation": 0,
        "opacity": 1,
        "stroke": "#94a3b8",
        "strokeWidth": 10
      }
    },
    {
      "op": "addNode",
      "frame": 0,
      "node": {
        "type": "path",
        "id": "leg-right",
        "name": "Leg R",
        "d": "M 0 0 L 0 90",
        "width": 20,
        "height": 90,
        "center": {
          "x": 494,
          "y": 350
        },
        "rotation": 0,
        "opacity": 1,
        "stroke": "#94a3b8",
        "strokeWidth": 10
      }
    },
    {
      "op": "addNode",
      "frame": 0,
      "node": {
        "type": "path",
        "id": "arm-left",
        "name": "Arm L",
        "d": "M 0 0 L 0 60",
        "width": 20,
        "height": 60,
        "center": {
          "x": 452,
          "y": 240
        },
        "rotation": 0,
        "opacity": 1,
        "stroke": "#94a3b8",
        "strokeWidth": 8
      }
    },
    {
      "op": "addNode",
      "frame": 0,
      "node": {
        "type": "path",
        "id": "arm-right",
        "name": "Arm R",
        "d": "M 0 0 L 0 60",
        "width": 20,
        "height": 60,
        "center": {
          "x": 508,
          "y": 240
        },
        "rotation": 0,
        "opacity": 1,
        "stroke": "#94a3b8",
        "strokeWidth": 8
      }
    },
    {
      "op": "updateNode",
      "nodeId": "leg-left",
      "frame": 6,
      "patch": {
        "rotation": 0
      }
    },
    {
      "op": "updateNode",
      "nodeId": "leg-right",
      "frame": 6,
      "patch": {
        "rotation": 0
      }
    },
    {
      "op": "updateNode",
      "nodeId": "arm-left",
      "frame": 6,
      "patch": {
        "rotation": 0
      }
    },
    {
      "op": "updateNode",
      "nodeId": "arm-right",
      "frame": 6,
      "patch": {
        "rotation": 0
      }
    },
    {
      "op": "updateNode",
      "nodeId": "body",
      "frame": 6,
      "patch": {
        "center": {
          "x": 480,
          "y": 278
        }
      }
    },
    {
      "op": "updateNode",
      "nodeId": "leg-left",
      "frame": 12,
      "patch": {
        "rotation": -25
      }
    },
    {
      "op": "updateNode",
      "nodeId": "leg-right",
      "frame": 12,
      "patch": {
        "rotation": 25
      }
    },
    {
      "op": "updateNode",
      "nodeId": "arm-left",
      "frame": 12,
      "patch": {
        "rotation": 20
      }
    },
    {
      "op": "updateNode",
      "nodeId": "arm-right",
      "frame": 12,
      "patch": {
        "rotation": -20
      }
    },
    {
      "op": "updateNode",
      "nodeId": "body",
      "frame": 12,
      "patch": {
        "center": {
          "x": 480,
          "y": 290
        }
      }
    },
    {
      "op": "updateNode",
      "nodeId": "leg-left",
      "frame": 18,
      "patch": {
        "rotation": 0
      }
    },
    {
      "op": "updateNode",
      "nodeId": "leg-right",
      "frame": 18,
      "patch": {
        "rotation": 0
      }
    },
    {
      "op": "updateNode",
      "nodeId": "arm-left",
      "frame": 18,
      "patch": {
        "rotation": 0
      }
    },
    {
      "op": "updateNode",
      "nodeId": "arm-right",
      "frame": 18,
      "patch": {
        "rotation": 0
      }
    },
    {
      "op": "updateNode",
      "nodeId": "body",
      "frame": 18,
      "patch": {
        "center": {
          "x": 480,
          "y": 278
        }
      }
    },
    {
      "op": "updateNode",
      "nodeId": "leg-left",
      "frame": 23,
      "patch": {
        "rotation": 25
      }
    },
    {
      "op": "updateNode",
      "nodeId": "leg-right",
      "frame": 23,
      "patch": {
        "rotation": -25
      }
    },
    {
      "op": "updateNode",
      "nodeId": "arm-left",
      "frame": 23,
      "patch": {
        "rotation": -20
      }
    },
    {
      "op": "updateNode",
      "nodeId": "arm-right",
      "frame": 23,
      "patch": {
        "rotation": 20
      }
    },
    {
      "op": "updateNode",
      "nodeId": "body",
      "frame": 23,
      "patch": {
        "center": {
          "x": 480,
          "y": 290
        }
      }
    },
    {
      "op": "setDuration",
      "frames": 24
    }
  ]
}
```

### Lip-sync-ready talking face

A face whose mouth cycles closed/mid/open every 1–2 frames over 12 frames, plus a caption.

```json
{
  "commands": [
    {
      "op": "addLayer",
      "kind": "object",
      "name": "Face"
    },
    {
      "op": "addNode",
      "frame": 0,
      "node": {
        "type": "primitive",
        "id": "face",
        "primitive": "ellipse",
        "name": "Face",
        "width": 240,
        "height": 280,
        "center": {
          "x": 480,
          "y": 260
        },
        "rotation": 0,
        "opacity": 1,
        "fill": "#fcd9a8",
        "stroke": "#c98a3d",
        "strokeWidth": 4
      }
    },
    {
      "op": "addNode",
      "frame": 0,
      "node": {
        "type": "path",
        "id": "mouth",
        "name": "Mouth",
        "d": "M -30 0 Q 0 6 30 0 Q 0 -6 -30 0 Z",
        "width": 60,
        "height": 6,
        "center": {
          "x": 480,
          "y": 330
        },
        "rotation": 0,
        "opacity": 1,
        "fill": "#7c2d12"
      }
    },
    {
      "op": "updateNode",
      "nodeId": "mouth",
      "frame": 2,
      "patch": {
        "d": "M -30 0 Q 0 24 30 0 Q 0 -12 -30 0 Z",
        "height": 18
      }
    },
    {
      "op": "updateNode",
      "nodeId": "mouth",
      "frame": 4,
      "patch": {
        "d": "M -30 0 Q 0 44 30 0 Q 0 -20 -30 0 Z",
        "height": 32
      }
    },
    {
      "op": "updateNode",
      "nodeId": "mouth",
      "frame": 5,
      "patch": {
        "d": "M -30 0 Q 0 24 30 0 Q 0 -12 -30 0 Z",
        "height": 18
      }
    },
    {
      "op": "updateNode",
      "nodeId": "mouth",
      "frame": 7,
      "patch": {
        "d": "M -30 0 Q 0 6 30 0 Q 0 -6 -30 0 Z",
        "height": 6
      }
    },
    {
      "op": "updateNode",
      "nodeId": "mouth",
      "frame": 9,
      "patch": {
        "d": "M -30 0 Q 0 24 30 0 Q 0 -12 -30 0 Z",
        "height": 18
      }
    },
    {
      "op": "updateNode",
      "nodeId": "mouth",
      "frame": 10,
      "patch": {
        "d": "M -30 0 Q 0 44 30 0 Q 0 -20 -30 0 Z",
        "height": 32
      }
    },
    {
      "op": "updateNode",
      "nodeId": "mouth",
      "frame": 11,
      "patch": {
        "d": "M -30 0 Q 0 6 30 0 Q 0 -6 -30 0 Z",
        "height": 6
      }
    },
    {
      "op": "addNode",
      "frame": 0,
      "node": {
        "type": "text",
        "id": "caption",
        "name": "Caption",
        "text": "Hello!",
        "fontFamily": "Noto Sans",
        "fontSize": 48,
        "fontWeight": 700,
        "align": "center",
        "fill": "#f8fafc",
        "width": 200,
        "height": 60,
        "center": {
          "x": 480,
          "y": 470
        },
        "rotation": 0,
        "opacity": 1
      }
    },
    {
      "op": "setDuration",
      "frames": 12
    }
  ]
}
```

