import { COMMANDS_SCHEMA } from '../shared/scripting/commands'
import { DOCUMENT_SCHEMA } from '../shared/scripting/documentSchema'

/**
 * JSON Schema export shared by the `schema` CLI command and the docs-site
 * generator, so both ship byte-identical files (`commands-v1.json`,
 * `document-v7.json`).
 */

export type SchemaKind = 'commands' | 'document'

export function schemaForKind(kind: SchemaKind): Record<string, unknown> {
  return kind === 'document'
    ? (DOCUMENT_SCHEMA as unknown as Record<string, unknown>)
    : (COMMANDS_SCHEMA as unknown as Record<string, unknown>)
}

/** File name the schema is published under (also used by the docs site). */
export function schemaFileName(kind: SchemaKind): string {
  return kind === 'document' ? 'document-v7.json' : 'commands-v1.json'
}

/** Pretty JSON of the requested schema (stable: 2-space indent + newline). */
export function renderSchemaJson(kind: SchemaKind): string {
  return `${JSON.stringify(schemaForKind(kind), null, 2)}\n`
}
