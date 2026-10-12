# Keyboard shortcuts

> Generated from `src/shared/shortcuts.ts` by `scripts/build-docs.ts` — do not edit by hand.
> Run `npm run docs:build` after changing the shortcut table.

On macOS every `Ctrl` below is `Cmd`.

## File

| Shortcut | Action |
| --- | --- |
| `Ctrl+N` | New Document |
| `Ctrl+O` | Open Project… |
| `Ctrl+S` | Save Project |
| `Ctrl+Shift+S` | Save Project As… |
| `Ctrl+I` | Import Image… |
| — | Import Audio… |
| `Ctrl+E` | Export… |
| — | Purge Unused Resources |

## Edit

| Shortcut | Action |
| --- | --- |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z / Ctrl+Y` | Redo |
| `Ctrl+X` | Cut |
| `Ctrl+C` | Copy |
| `Ctrl+V` | Paste |
| `Ctrl+D` | Duplicate |
| `Delete / Backspace` | Delete Selection |
| `Ctrl+A` | Select All Nodes |
| `Ctrl+,` | Preferences… |
| — | Align Left |
| — | Align Horizontal Centers |
| — | Align Right |
| — | Align Top |
| — | Align Vertical Centers |
| — | Align Bottom |
| — | Distribute Horizontally |
| — | Distribute Vertically |

## Insert

| Shortcut | Action |
| --- | --- |
| `F5` | Insert Frame |
| `F6` | Insert Keyframe |
| `F7` | Insert Blank Cell |
| `Ctrl+T` | Toggle Tween |
| `Ctrl+G` | Group Selection |
| `Ctrl+Shift+G` | Ungroup Selection |
| `F8` | Save Selection as Symbol |

## Layer

| Shortcut | Action |
| --- | --- |
| — | Add Object Layer |
| — | Add Drawing Layer |
| — | Add Camera Layer |

## View

| Shortcut | Action |
| --- | --- |
| `Ctrl+= / +` | Zoom In |
| `Ctrl+- / -` | Zoom Out |
| `Ctrl+0 / 0` | Reset Zoom |
| `Ctrl+'` | Toggle Grid & Snapping |
| — | Toggle Onion Skin |
| — | Toggle Library Panel |
| — | Toggle Properties Panel |

## Tools

| Shortcut | Action |
| --- | --- |
| `V` | Select Tool |
| `H` | Hand Tool |
| `B` | Brush Tool |
| `E` | Eraser Tool |
| `R` | Rectangle Tool |
| `O` | Ellipse Tool |
| `L` | Line Tool |
| `P` | Pen Tool |
| `T` | Text Tool |
| `N` | Vector Tool |
| `[` | Decrease Brush Size |
| `]` | Increase Brush Size |

## Stage

| Shortcut | Action |
| --- | --- |
| `Space` | Pan Stage (hold) / Play-Pause (tap) |
| `Arrows (Shift: 10 px)` | Nudge Selection |
| `Enter` | Finish Pen Path |
| `Escape` | Cancel Pen / Stroke / Stop Playback |

## Help

| Shortcut | Action |
| --- | --- |
| `F1 / ?` | Keyboard Shortcuts |
| — | Documentation |
| — | About OpenAnimator |

## Context notes

- `Ctrl+C` / `Ctrl+V` act on the timeline keyframe clipboard while the timeline was the last clicked surface, otherwise on the selected scene nodes.
- `Ctrl+X` (cut) and `Ctrl+D` (duplicate) always act on scene nodes.
- Holding `Space` pans the stage; tapping it plays or pauses playback.
- The plain keys `+`, `-` and `0` zoom like their `Ctrl` counterparts; inside text fields native text editing wins over every binding except the File menu shortcuts and `F1`.
