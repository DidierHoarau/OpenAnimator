import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { COMMANDS_SCHEMA, OPS, OP_FIELDS } from './commands'
import { SCRIPT_EXAMPLES } from './examples'
import { renderScriptingReference } from './referenceMarkdown'

const REFERENCE_PATH = fileURLToPath(
  new URL('../../../docs/scripting-reference.md', import.meta.url)
)

describe('renderScriptingReference', () => {
  it('matches the committed docs/scripting-reference.md (drift gate)', () => {
    const committed = readFileSync(REFERENCE_PATH, 'utf8')
    expect(renderScriptingReference()).toBe(committed)
  })

  it('documents every op with a field table and every example', () => {
    const reference = renderScriptingReference()
    expect(reference).toContain('Generated from')
    for (const op of OPS) {
      expect(reference).toContain(`### ${op}\n`)
      for (const field of Object.keys(OP_FIELDS[op])) {
        expect(reference).toContain(`| \`${field}\` |`)
      }
    }
    for (const example of SCRIPT_EXAMPLES) {
      expect(reference).toContain(`### ${example.name}`)
      expect(reference).toContain(example.description)
    }
  })

  it('is deterministic and keeps the schema op order', () => {
    const once = renderScriptingReference()
    expect(renderScriptingReference()).toBe(once)
    const schemaOps = (
      COMMANDS_SCHEMA as unknown as {
        definitions: { command: { properties: { op: { enum: readonly string[] } } } }
      }
    ).definitions.command.properties.op.enum
    const positions = schemaOps.map((op) => once.indexOf(`### ${op}\n`))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('throws when OPS and the schema enum disagree', () => {
    // Sanity: the guard reads the live schema, so equal-length lists pass.
    const schemaOps = (
      COMMANDS_SCHEMA as unknown as {
        definitions: { command: { properties: { op: { enum: readonly string[] } } } }
      }
    ).definitions.command.properties.op.enum
    expect(schemaOps.length).toBe(OPS.length)
    schemaOps.forEach((op, index) => expect(op).toBe(OPS[index]))
  })
})
