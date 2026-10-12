import { cloneDocument } from '@shared/document'
import type { AnimatorDocument } from '@shared/model'
import type { ScriptCommand } from '@shared/scripting/commands'
import {
  diffDocumentsToCommands,
  type RecorderDiffResult,
  type RecorderFrameContext
} from '@shared/scripting/recorder'

import type { Editor, HistoryCommit } from '../editor'

/**
 * Renderer-side script recorder: watches every committed history entry (the
 * editor's `onHistoryCommit` observer fires exactly once per gesture — drags
 * included, and once per script command) and derives the commands that
 * replay each gesture through the shared pure diff engine. Consecutive
 * states telescope: each flush covers exactly one gesture, and undo/redo
 * simply show up as document states the next flush reconciles.
 *
 * Recorded commands are plain `ScriptCommand`s; the console inserts them as
 * a payload that goes through `validateScriptPayload` +
 * `executeScriptCommands` like any hand-written script (one pipeline, no
 * second execution path).
 */

interface PendingState {
  snapshot: AnimatorDocument
  frameContext: RecorderFrameContext
}

/** Recorders currently recording (fed by `notifyGlobalPaletteSet`). */
const activeRecorders = new Set<ScriptRecorder>()

export class ScriptRecorder {
  private readonly editor: Editor
  private readonly changeListeners = new Set<() => void>()
  private unsubscribeHistory: (() => void) | null = null
  private pending: PendingState | null = null
  private commands: ScriptCommand[] = []
  private unsupportedNotes: string[] = []
  private lastPalette: string[] | null = null
  private active = false

  constructor(editor: Editor) {
    this.editor = editor
  }

  get recording(): boolean {
    return this.active
  }

  get steps(): number {
    return this.commands.length
  }

  get unsupported(): readonly string[] {
    return this.unsupportedNotes
  }

  /** Starts a fresh recording: clears any previous capture and captures the
   * gesture frame context of every commit from now on. */
  start(): void {
    if (this.active) return
    this.commands = []
    this.unsupportedNotes = []
    this.lastPalette = null
    this.pending = null
    this.active = true
    activeRecorders.add(this)
    this.unsubscribeHistory = this.editor.onHistoryCommit(this.handleCommit)
    this.emitChange()
  }

  /** Stops recording and flushes the gesture in flight (if any). The capture
   * stays available until `take()`. */
  stop(): void {
    if (!this.active) return
    if (this.pending) {
      this.flush(this.pending.snapshot, cloneDocument(this.editor.document), this.pending.frameContext)
      this.pending = null
    }
    this.unsubscribeHistory?.()
    this.unsubscribeHistory = null
    this.active = false
    activeRecorders.delete(this)
    this.emitChange()
  }

  /** Discards the capture (stops first when still recording). */
  clear(): void {
    this.stop()
    this.commands = []
    this.unsupportedNotes = []
    this.emitChange()
  }

  /** Stops when needed and hands over the capture, resetting the buffer. */
  take(): RecorderDiffResult {
    this.stop()
    const result: RecorderDiffResult = {
      commands: this.commands,
      unsupported: this.unsupportedNotes
    }
    this.commands = []
    this.unsupportedNotes = []
    this.emitChange()
    return result
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  /** Records a global-palette set (the palette lives outside the document;
   * the recorder taps the same bridge the property panel uses). */
  notifyGlobalPaletteSet(colors: readonly string[]): void {
    if (!this.active) return
    const next = [...colors]
    if (this.lastPalette && next.length === this.lastPalette.length && next.every((color, index) => color === this.lastPalette![index])) {
      return
    }
    this.lastPalette = next
    this.commands.push({ op: 'setGlobalPalette', colors: next })
    this.emitChange()
  }

  private readonly handleCommit = (commit: HistoryCommit): void => {
    if (!this.active) return
    const frameContext: RecorderFrameContext = {
      frame: this.editor.currentFrame,
      layerId: this.editor.currentLayerId
    }
    if (this.pending) {
      this.flush(this.pending.snapshot, commit.snapshot, this.pending.frameContext)
    }
    this.pending = { snapshot: commit.snapshot, frameContext }
    this.emitChange()
  }

  private flush(before: AnimatorDocument, after: AnimatorDocument, frameContext: RecorderFrameContext): void {
    const result = diffDocumentsToCommands(before, after, frameContext)
    if (result.commands.length > 0) this.commands.push(...result.commands)
    for (const note of result.unsupported) {
      if (!this.unsupportedNotes.includes(note)) this.unsupportedNotes.push(note)
    }
  }

  private emitChange(): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('OpenAnimator: a script recorder listener failed', error)
      }
    }
  }
}

const recorders = new WeakMap<Editor, ScriptRecorder>()

/** The per-editor recorder singleton (the console may reopen mid-recording). */
export function getScriptRecorder(editor: Editor): ScriptRecorder {
  let recorder = recorders.get(editor)
  if (!recorder) {
    recorder = new ScriptRecorder(editor)
    recorders.set(editor, recorder)
  }
  return recorder
}

/** Feeds a global-palette set into every active recording. Wired to the same
 * bridge calls that persist the palette, so swatch edits replay. */
export function notifyGlobalPaletteSet(colors: readonly string[]): void {
  for (const recorder of [...activeRecorders]) {
    recorder.notifyGlobalPaletteSet(colors)
  }
}
