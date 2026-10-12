import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { validateDocumentPayload } from '../shared/scripting/commands'
import { evaluateDocumentAtFrame } from '../shared/render'
import { parseProject } from './projectContainer'

/**
 * The gallery samples under `docs/samples/` are committed artifacts: the app
 * must be able to open every one of them. This parses each `.oanim` through
 * the same container reader the app uses and validates the embedded document
 * against the published document schema.
 */

const SAMPLES_DIR = join(__dirname, '../../docs/samples')

const EXPECTED_SAMPLES = ['bouncing-ball.oanim', 'walk-cycle.oanim']

function sampleFiles(): string[] {
  return readdirSync(SAMPLES_DIR)
    .filter((name) => name.endsWith('.oanim'))
    .sort()
}

describe('docs samples', () => {
  it('ships exactly the expected sample files', () => {
    expect(sampleFiles()).toEqual(EXPECTED_SAMPLES)
  })

  for (const sample of EXPECTED_SAMPLES) {
    it(`${sample} parses as a project container and validates as a document`, () => {
      const bytes = new Uint8Array(readFileSync(join(SAMPLES_DIR, sample)))
      const { document, resources } = parseProject(bytes)
      expect(resources.size).toBe(0)
      const validation = validateDocumentPayload(document)
      expect(validation.errors).toEqual([])
      expect(validation.valid).toBe(true)
      // Sanity: the sample actually renders content on its first frame.
      const frame = evaluateDocumentAtFrame(document, 0)
      expect(frame.layers.length).toBeGreaterThan(0)
    })
  }
})
