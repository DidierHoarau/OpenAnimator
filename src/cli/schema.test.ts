import { describe, expect, it } from 'vitest'
import Ajv from 'ajv'

import { COMMANDS_SCHEMA, OPS } from '../shared/scripting/commands'
import { DOCUMENT_SCHEMA } from '../shared/scripting/documentSchema'
import { renderSchemaJson, schemaFileName, schemaForKind } from './schema'

describe('CLI schema export', () => {
  it('renders parseable JSON for both kinds', () => {
    for (const kind of ['commands', 'document'] as const) {
      const parsed = JSON.parse(renderSchemaJson(kind)) as { $id?: string; $schema?: string }
      expect(parsed.$id).toContain(schemaFileName(kind))
      expect(parsed.$schema).toBe('http://json-schema.org/draft-07/schema#')
      expect(renderSchemaJson(kind).endsWith('\n')).toBe(true)
    }
  })

  it('compiles with ajv and the command enum covers every op', () => {
    const commands = schemaForKind('commands')
    expect(new Ajv({ allErrors: true }).compile(commands)).toBeTypeOf('function')
    expect(new Ajv({ allErrors: true }).compile(schemaForKind('document'))).toBeTypeOf('function')

    const schema = COMMANDS_SCHEMA as unknown as {
      definitions: { command: { properties: { op: { enum: readonly string[] } } } }
    }
    expect(schema.definitions.command.properties.op.enum).toEqual([...OPS])
  })

  it('publishes the document schema under its versioned file name', () => {
    expect(schemaFileName('document')).toBe('document-v9.json')
    expect(schemaFileName('commands')).toBe('commands-v1.json')
    expect(schemaForKind('document')).toBe(DOCUMENT_SCHEMA)
  })
})
