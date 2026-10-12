import type { Editor } from './editor'

/** Audio formats the importer accepts (the browsers' decodable set). */
export type AudioFormat = 'wav' | 'mp3' | 'ogg'

/** Format of an imported file: extension first, then the magic bytes — WAV
 * (`RIFF….WAVE`), OGG (`OggS`), MP3 (`ID3` tag or a bare frame sync). Null
 * when the file is not recognizable audio. */
export function detectAudioFormat(fileName: string, bytes: Uint8Array): AudioFormat | null {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  if (ext === 'wav') return 'wav'
  if (ext === 'mp3') return 'mp3'
  if (ext === 'ogg') return 'ogg'
  if (isRiffWave(bytes)) return 'wav'
  if (isMp3(bytes)) return 'mp3'
  if (isOgg(bytes)) return 'ogg'
  return null
}

function isRiffWave(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  )
}

function isOgg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53
}

function isMp3(bytes: Uint8Array): boolean {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
}

/**
 * Stores raw audio bytes as a content-addressed resource and adds an audio
 * layer referencing it — one undo step. Returns false (with a status-bar
 * message) for unsupported formats or a store failure.
 */
export async function importAudioBytes(
  editor: Editor,
  fileName: string,
  bytes: Uint8Array,
  startFrame = 0
): Promise<boolean> {
  const format = detectAudioFormat(fileName, bytes)
  if (!format) {
    editor.showMessage('Unsupported audio format (WAV, MP3 or OGG)')
    return false
  }
  try {
    const { resourceId, deduped } = await window.api.addResource(bytes, fileName)
    // The renderer cache must hold the bytes too, or playback and the
    // timeline waveform resolve the resource id to nothing until reload.
    editor.resources.put(resourceId, bytes)
    const layer = editor.addAudioLayer(resourceId, fileName, startFrame)
    if (!layer) return false
    editor.showMessage(deduped ? `Added audio "${fileName}"` : `Imported audio "${fileName}"`)
    return true
  } catch (error) {
    console.warn('OpenAnimator: audio import failed', error)
    editor.showMessage('The audio file could not be imported')
    return false
  }
}

/** Picks an audio file through the OS dialog; null when canceled. */
export async function pickAudioFile(): Promise<{ fileName: string; bytes: Uint8Array } | null> {
  const result = await window.api.pickAudioFile('Import audio')
  return result.canceled ? null : { fileName: result.fileName, bytes: result.bytes }
}

/** Imports an audio file picked through the OS file dialog (toolbar). */
export async function importAudioViaDialog(editor: Editor): Promise<boolean> {
  const picked = await pickAudioFile()
  if (!picked) return false
  return importAudioBytes(editor, picked.fileName, picked.bytes)
}
