import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { NocoDBClient } from '../client.js';
import { baseIdSchema, fieldIdSchema, tableIdSchema } from '../schemas/common.js';
import { tryTool } from './helpers.js';

const SAFE_FIELD_TYPES = [
  'SingleLineText',
  'LongText',
  'URL',
  'Checkbox',
  'Number',
  'Date',
  'DateTime',
  'SingleSelect',
] as const;

type Field = Record<string, unknown>;
type Table = { id?: string; title?: string; fields?: Field[] } & Field;

function fieldName(field: Field): string {
  return String(field.title ?? field.name ?? field.field_name ?? '');
}

function fieldType(field: Field): string {
  return String(field.type ?? field.uidt ?? field.field_type ?? '');
}

function isProtectedField(field: Field): boolean {
  const type = fieldType(field);
  const metadata = [field, (field.meta as Field | undefined) ?? {}];
  const flagged = metadata.some((item) =>
    ['pk', 'pkey', 'primary', 'is_primary', 'system', 'system_field', 'is_system', 'relation', 'is_relation', 'lookup', 'is_lookup', 'formula', 'is_formula', 'rollup', 'is_rollup'].some(
      (key) => item[key] === true,
    ),
  );
  return flagged || ['ID', 'ForeignKey', 'AutoNumber', 'Links', 'LinkToAnotherRecord', 'Lookup', 'Formula', 'Rollup'].includes(type);
}

function sameOptions(actual: unknown, requested: unknown): boolean {
  return JSON.stringify(actual ?? {}) === JSON.stringify(requested ?? {});
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function requestedField(input: Record<string, unknown>): { name: string; type: string; options: Record<string, unknown> } {
  const name = requiredText(input.field_name, 'field_name');
  const type = requiredText(input.field_type, 'field_type');
  if (!(SAFE_FIELD_TYPES as readonly string[]).includes(type)) {
    throw new Error(`field_type must be one of: ${SAFE_FIELD_TYPES.join(', ')}`);
  }
  const options = input.options === undefined ? {} : input.options;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new Error('options must be an object');
  return { name, type, options: options as Record<string, unknown> };
}

function schemaView(table: Table): Field[] {
  return Array.isArray(table.fields) ? table.fields : [];
}

export async function applySchemaWrite(input: Record<string, unknown>, client: NocoDBClient): Promise<Record<string, unknown>> {
  const entity = input.entity;
  if (entity !== 'field') throw new Error('entity must be field');
  const operation = input.operation;
  if (!['create', 'update', 'delete'].includes(String(operation))) throw new Error('operation must be one of create, update, delete');

  const baseId = requiredText(input.base_id, 'base_id');
  const tableId = requiredText(input.table_id, 'table_id');
  const apply = input.apply === true;
  const tablePath = `/meta/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}`;
  const before = await client.request<Table>(tablePath);
  const fields = schemaView(before);
  const requested: Record<string, unknown> = { entity, operation, base_id: baseId, table_id: tableId };

  if (operation === 'create') {
    const desired = requestedField(input);
    requested.field_name = desired.name;
    requested.field_type = desired.type;
    requested.options = desired.options;
    const sameName = fields.filter((field) => fieldName(field) === desired.name);
    if (sameName.length > 1) throw new Error(`field_name is ambiguous: ${desired.name}`);
    if (sameName.length === 1) {
      const existing = sameName[0];
      if (fieldType(existing) !== desired.type) throw new Error(`existing field ${desired.name} has conflicting type ${fieldType(existing)}`);
      if (!sameOptions(existing.options, desired.options)) throw new Error(`existing field ${desired.name} has conflicting options`);
      return { ok: true, applied: false, preview_only: !apply, before: fields, requested, after: fields, idempotent: true, verification: { ok: true, mismatches: [] } };
    }
    if (!apply) return { ok: true, applied: false, preview_only: true, before: fields, requested, after: [...fields, { title: desired.name, type: desired.type, options: desired.options }], verification: { ok: true, mismatches: [] } };
    await client.request(`/meta/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/fields`, {
      method: 'POST',
      body: { title: desired.name, type: desired.type, options: desired.options },
    });
    const reread = await client.request<Table>(tablePath);
    const matches = schemaView(reread).filter((field) => fieldName(field) === desired.name && fieldType(field) === desired.type && sameOptions(field.options, desired.options));
    const mismatches = matches.length === 1 ? [] : [`expected exactly one field ${desired.name} with type ${desired.type}`];
    return { ok: mismatches.length === 0, applied: mismatches.length === 0, preview_only: false, before: fields, requested, after: schemaView(reread), verification: { ok: mismatches.length === 0, mismatches } };
  }

  const fieldId = requiredText(input.field_id, 'field_id');
  const current = fields.find((field) => String(field.id ?? field.field_id ?? '') === fieldId);
  if (!current) throw new Error(`field_id not found in table: ${fieldId}`);
  requested.field_id = fieldId;
  const expectedType = requiredText(input.expected_field_type, 'expected_field_type');
  if (fieldType(current) !== expectedType) throw new Error(`expected_field_type mismatch: current type is ${fieldType(current)}`);

  if (operation === 'delete') {
    const expectedName = requiredText(input.field_name, 'field_name');
    if (fieldName(current) !== expectedName) throw new Error(`field_name mismatch: current name is ${fieldName(current)}`);
    requested.field_name = expectedName;
    requested.expected_field_type = expectedType;
    if (isProtectedField(current)) throw new Error('refusing to delete protected primary, system, relation, lookup, formula, or rollup field');
    if (!apply) return { ok: true, applied: false, preview_only: true, before: fields, requested, after: fields, verification: { ok: true, mismatches: [] } };
    await client.request(`/meta/bases/${encodeURIComponent(baseId)}/fields/${encodeURIComponent(fieldId)}`, { method: 'DELETE' });
    const reread = await client.request<Table>(tablePath);
    const stillPresent = schemaView(reread).some((field) => String(field.id ?? field.field_id ?? '') === fieldId);
    const mismatches = stillPresent ? [`field ${fieldId} still exists after delete`] : [];
    return { ok: mismatches.length === 0, applied: mismatches.length === 0, preview_only: false, before: fields, requested, after: schemaView(reread), verification: { ok: mismatches.length === 0, mismatches } };
  }

  const desired = requestedField(input);
  requested.field_name = desired.name;
  requested.field_type = desired.type;
  requested.expected_field_type = expectedType;
  requested.options = desired.options;
  if (isProtectedField(current) && desired.type !== fieldType(current)) throw new Error('refusing to change the type of a protected field');
  if (!apply) return { ok: true, applied: false, preview_only: true, before: fields, requested, after: fields.map((field) => String(field.id ?? field.field_id ?? '') === fieldId ? { ...field, title: desired.name, type: desired.type, options: desired.options } : field), verification: { ok: true, mismatches: [] } };
  await client.request(`/meta/bases/${encodeURIComponent(baseId)}/fields/${encodeURIComponent(fieldId)}`, {
    method: 'PATCH',
    body: { title: desired.name, type: desired.type, options: desired.options },
  });
  const reread = await client.request<Table>(tablePath);
  const updated = schemaView(reread).find((field) => String(field.id ?? field.field_id ?? '') === fieldId);
  const mismatches: string[] = [];
  if (!updated || fieldName(updated) !== desired.name) mismatches.push('field_name');
  if (!updated || fieldType(updated) !== desired.type) mismatches.push('field_type');
  if (!updated || !sameOptions(updated.options, desired.options)) mismatches.push('options');
  return { ok: mismatches.length === 0, applied: mismatches.length === 0, preview_only: false, before: fields, requested, after: schemaView(reread), verification: { ok: mismatches.length === 0, mismatches } };
}

export function registerSchemaWriteTool(server: McpServer, client: NocoDBClient): void {
  server.registerTool(
    'schema_write',
    {
      title: 'Safe schema write',
      description: 'Dry-run-first field schema mutation for exact NocoDB base/table IDs. Supports safe field types only and verifies the table schema after apply.',
      inputSchema: {
        entity: z.literal('field'),
        operation: z.enum(['create', 'update', 'delete']),
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        field_id: fieldIdSchema.optional(),
        field_name: z.string().min(1).optional(),
        field_type: z.enum(SAFE_FIELD_TYPES).optional(),
        options: z.record(z.string(), z.unknown()).optional(),
        expected_field_type: z.string().min(1).optional(),
        apply: z.boolean().default(false),
      },
    },
    async (input) => tryTool(() => applySchemaWrite(input as Record<string, unknown>, client), 'schema_write'),
  );
}
