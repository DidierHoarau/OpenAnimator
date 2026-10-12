# Sample gallery

Two ready-made projects ship with the docs, committed under
`docs/samples/` and regenerated deterministically by `npm run
samples:build`. Both mirror examples from the
[scripting reference](scripting-reference.md#examples) — the `.oanim` files
here are the same artwork hand-built as documents, so they open straight in
the app without running a script first.

## Bouncing ball

![Bouncing ball preview](samples/bouncing-ball.gif)

A red ball falls from the top of the stage, hits the floor at frame 12 and
bounces back up: two tweens with opposite easing around the impact keyframe
(`ease-in` falling, `ease-out` rising). Three keyframes over 24 frames on a
single layer — the smallest complete tweening project.

- [bouncing-ball.oanim](samples/bouncing-ball.oanim) — open it in the app,
  or render it headless:
  `npm run cli -- render docs/samples/bouncing-ball.oanim --out ball.gif`
- The same animation as a script payload: `bouncingBall` in the
  [reference examples](scripting-reference.md#examples).

## Walk cycle

![Walk cycle preview](samples/walk-cycle.gif)

A stick figure walks in place: five flip-book poses over 24 frames (no
tween — the poses hold like a real walk cycle on twos) swinging two legs
and two arms around their joints while the body bobs. The limb paths'
local origin sits on the hip/shoulder, so a plain rotation keyframe
swings the limb.

- [walk-cycle.oanim](samples/walk-cycle.oanim) — open it in the app, or
  render it headless:
  `npm run cli -- render docs/samples/walk-cycle.oanim --out walk.gif`
- The same animation as a script payload: `walkCycle` in the
  [reference examples](scripting-reference.md#examples).

## Build them yourself

```bash
npm run samples:build   # regenerates docs/samples/*.oanim and the GIF previews
```

The generator (`scripts/make-samples.ts`) builds the documents with the
same pure helpers the application uses, packs them through the project
container writer and renders the previews through the shared export
pipeline — with literal ids and a pinned ZIP timestamp so repeated runs
produce byte-identical files.
