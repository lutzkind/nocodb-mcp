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
const DISPOSABLE_TABLE_PREFIX = /^(mcp_test_|mcp_probe_)/;

function fieldName(field: Field): string {
  return String(field.title ?? field.name ?? field.field_name ?? '');
}

function fieldType(field: Field): string {
  return String(field.type ?? field.uidt ?? field.field_type ?? '');
}

function protectionClass(field: Field): string | null {
  const type = fieldType(field);
  const metadata = [field, (field.meta as Field | undefined) ?? {}];
  const classes: Array<[string, string[]]> = [
    ['primary', ['pk', 'pkey', 'primary', 'is_primary']],
    ['system', ['system', 'system_field', 'is_system']],
    ['relation', ['relation', 'is_relation']],
    ['lookup', ['lookup', 'is_lookup']],
    ['formula', ['formula', 'is_formula']],
    ['rollup', ['rollup', 'is_rollup']],
  ];
  for (const [name, keys] of classes) {
    if (metadata.some((item) => keys.some((key) => item[key] === true))) return name;
  }
  const typeClass: Record<string, string> = {
    ID: 'primary', AutoNumber: 'primary', CreatedTime: 'system', LastModifiedTime: 'system',
    CreatedBy: 'system', LastModifiedBy: 'system', ForeignKey: 'relation', Links: 'relation',
    LinkToAnotherRecord: 'relation', Lookup: 'lookup', Formula: 'formula', Rollup: 'rollup',
    Barcode: 'computed', Attachment: 'computed',
  };
  return typeClass[type] ?? null;
}

function jsonEqual(actual: unknown, requested: unknown): boolean {
  if (actual === undefined || requested === undefined) return actual === requested;
  if (actual === null || requested === null) return actual === requested;
  if (Array.isArray(actual) || Array.isArray(requested)) {
    return Array.isArray(actual) && Array.isArray(requested) && actual.length === requested.length && actual.every((item, index) => jsonEqual(item, requested[index]));
  }
  if (typeof actual === 'object' || typeof requested === 'object') {
    if (typeof actual !== 'object' || typeof requested !== 'object') return false;
    const left = Object.keys(actual as object).sort();
    const right = Object.keys(requested as object).sort();
    return left.length === right.length && left.every((key, index) => key === right[index] && jsonEqual((actual as Record<string, unknown>)[key], (requested as Record<string, unknown>)[key]));
  }
  return typeof actual === typeof requested && Object.is(actual, requested);
}

function sameOptions(actual: unknown, requested: unknown): boolean {
  return jsonEqual(actual ?? {}, requested ?? {});
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

function compactField(field: Field | undefined): Record<string, unknown> | null {
  if (!field) return null;
  return {
    id: field.id ?? field.field_id ?? null,
    name: fieldName(field),
    type: fieldType(field),
    options: field.options ?? undefined,
  };
}

function compactTable(table: Table | undefined): Record<string, unknown> | null {
  if (!table) return null;
  return { id: table.id ?? null, name: table.title ?? table.name ?? null };
}

function disposableBaseIds(): string[] {
  return (process.env.NOCODB_DISPOSABLE_BASE_IDS || '').split(',').map((value) => value.trim()).filter(Boolean);
}

function assertDisposableBase(baseId: string): void {
  if (!disposableBaseIds().includes(baseId)) throw new Error('base_id is not allowlisted for disposable MCP fixtures');
}

function assertDisposableTableName(name: string, label: string): void {
  if (!DISPOSABLE_TABLE_PREFIX.test(name)) throw new Error(`${label} must start with mcp_test_ or mcp_probe_`);
  if (!/^[A-Za-z0-9_ -]+$/.test(name)) throw new Error(`${label} contains unsupported characters`);
}

function attachFullSchema(result: Record<string, unknown>, includeFullSchema: boolean, before: Field[], after: Field[]): Record<string, unknown> {
  return includeFullSchema ? { ...result, before, after } : result;
}

export async function applySchemaWrite(input: Record<string, unknown>, client: NocoDBClient): Promise<Record<string, unknown>> {
  const entity = input.entity;
  const operation = input.operation;
  if (!['create', 'update', 'delete'].includes(String(operation))) throw new Error('operation must be one of create, update, delete');

  const baseId = requiredText(input.base_id, 'base_id');
  const tableId = entity === 'field' ? requiredText(input.table_id, 'table_id') : '';
  const apply = input.apply === true;

  if (entity === 'table') {
    assertDisposableBase(baseId);
    if (operation === 'create') {
      const tableName = requiredText(input.table_name, 'table_name');
      assertDisposableTableName(tableName, 'table_name');
      const tables = await client.request<Table[]>(`/meta/bases/${encodeURIComponent(baseId)}/tables`);
      const existing = (Array.isArray(tables) ? tables : []).find((table) => String(table.title ?? table.name ?? '') === tableName);
      if (existing) return { ok: true, applied: false, operation: 'create', table: compactTable(existing), idempotent: true, verification: { ok: true, mismatches: [] } };
      const preview = { preview_only: true, requested: { entity, operation, base_id: baseId, table_name: tableName }, affected_table: { name: tableName }, schema_field_count_before: 0, schema_field_count_after: 1 };
      if (!apply) return preview;
      const created = await client.request<Table>(`/meta/bases/${encodeURIComponent(baseId)}/tables`, { method: 'POST', body: { title: tableName, fields: [] } });
      const createdId = String(created.id ?? '');
      const table = createdId ? await client.request<Table>(`/meta/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(createdId)}`) : created;
      const verification = { ok: String(table.title ?? table.name ?? '') === tableName && Boolean(table.id ?? createdId), mismatches: [] as string[] };
      if (!verification.ok) verification.mismatches.push('created table identity');
      return { ok: verification.ok, applied: verification.ok, operation: 'create', table: compactTable(table), idempotent: false, verification };
    }

    if (operation !== 'delete') throw new Error('table schema_write supports only create and delete');

    const tableId = requiredText(input.table_id, 'table_id');
    const expectedName = requiredText(input.expected_table_name, 'expected_table_name');
    assertDisposableTableName(expectedName, 'expected_table_name');
    const tablePath = `/meta/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}`;
    const current = await client.request<Table>(tablePath);
    const currentName = String(current.title ?? current.name ?? '');
    if (currentName !== expectedName) throw new Error(`expected_table_name mismatch: current name is ${currentName}`);
    const count = await client.request<number | { count?: number; value?: number }>(`/data/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/count`);
    const recordCount = typeof count === 'number' ? count : Number(count.count ?? count.value ?? 0);
    if (recordCount !== 0) throw new Error(`refusing to delete disposable table containing ${recordCount} record(s)`);
    const preview = { preview_only: true, requested: { entity, operation, base_id: baseId, table_id: tableId, expected_table_name: expectedName }, affected_table: compactTable(current), schema_field_count_before: schemaView(current).length, schema_field_count_after: 0 };
    if (!apply) return preview;
    await client.request(tablePath, { method: 'DELETE' });
    let remaining: Table | null = null;
    try { remaining = await client.request<Table>(tablePath); } catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    const verification = { ok: remaining === null, field_absent: remaining === null, mismatches: remaining ? ['table still exists'] : [] };
    return { ok: verification.ok, applied: verification.ok, operation: 'delete', deleted_table: compactTable(current), verification };
  }

  if (entity !== 'field') throw new Error('entity must be field or table');
  const tablePath = `/meta/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}`;
  const before = await client.request<Table>(tablePath);
  const fields = schemaView(before);
  const requested: Record<string, unknown> = { entity, operation, base_id: baseId, table_id: tableId };
  const includeFullSchema = input.include_full_schema === true;

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
      return attachFullSchema({ ok: true, applied: false, operation: 'create', field: compactField(existing), idempotent: true, verification: { ok: true, mismatches: [] } }, includeFullSchema, fields, fields);
    }
    if (!apply) return { preview_only: true, requested, affected_field: { name: desired.name, type: desired.type }, schema_field_count_before: fields.length, schema_field_count_after: fields.length + 1 };
    await client.request(`/meta/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/fields`, {
      method: 'POST',
      body: { title: desired.name, type: desired.type, options: desired.options },
    });
    const reread = await client.request<Table>(tablePath);
    const matches = schemaView(reread).filter((field) => fieldName(field) === desired.name && fieldType(field) === desired.type && sameOptions(field.options, desired.options));
    const mismatches = matches.length === 1 ? [] : [`expected exactly one field ${desired.name} with type ${desired.type}`];
    const field = matches.length === 1 ? matches[0] : undefined;
    return attachFullSchema({ ok: mismatches.length === 0, applied: mismatches.length === 0, operation: 'create', field: compactField(field), idempotent: false, verification: { ok: mismatches.length === 0, mismatches } }, includeFullSchema, fields, schemaView(reread));
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
    const protection = protectionClass(current);
    if (protection) throw new Error(`refusing to delete protected ${protection} field`);
    if (!apply) return { preview_only: true, requested, affected_field: compactField(current), schema_field_count_before: fields.length, schema_field_count_after: fields.length };
    await client.request(`/meta/bases/${encodeURIComponent(baseId)}/fields/${encodeURIComponent(fieldId)}`, { method: 'DELETE' });
    const reread = await client.request<Table>(tablePath);
    const stillPresent = schemaView(reread).some((field) => String(field.id ?? field.field_id ?? '') === fieldId);
    const mismatches = stillPresent ? [`field ${fieldId} still exists after delete`] : [];
    return attachFullSchema({ ok: mismatches.length === 0, applied: mismatches.length === 0, operation: 'delete', deleted_field: compactField(current), verification: { ok: mismatches.length === 0, field_absent: mismatches.length === 0, mismatches } }, includeFullSchema, fields, schemaView(reread));
  }

  const desired = requestedField(input);
  requested.field_name = desired.name;
  requested.field_type = desired.type;
  requested.expected_field_type = expectedType;
  requested.options = desired.options;
  const protection = protectionClass(current);
  if (desired.type !== fieldType(current)) throw new Error(`refusing unsafe type conversion from ${fieldType(current)} to ${desired.type}`);
  if (protection && desired.name !== fieldName(current)) throw new Error(`refusing to rename protected ${protection} field`);
  if (!apply) return { preview_only: true, requested, affected_field: { id: fieldId, name: desired.name, type: desired.type }, schema_field_count_before: fields.length, schema_field_count_after: fields.length };
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
  return attachFullSchema({ ok: mismatches.length === 0, applied: mismatches.length === 0, operation: 'update', before_field: compactField(current), after_field: compactField(updated), changed_fields: ['name', 'type', 'options'].filter((field) => field === 'name' ? fieldName(current) !== desired.name : field === 'type' ? fieldType(current) !== desired.type : !sameOptions(current.options, desired.options)), verification: { ok: mismatches.length === 0, mismatches } }, includeFullSchema, fields, schemaView(reread));
}

export function registerSchemaWriteTool(server: McpServer, client: NocoDBClient): void {
  server.registerTool(
    'schema_write',
    {
      title: 'Safe schema write',
      description: 'schema_write: dry-run-first guarded field create/update/delete with compact responses, idempotent same-type create, type-conflict rejection, expected_field_type checks, protected-field rejection, and narrowly scoped disposable mcp_test_/mcp_probe_ table create/delete in explicitly allowlisted bases. Use include_full_schema=true only when full before/after arrays are needed.',
      inputSchema: {
        entity: z.enum(['field', 'table']),
        operation: z.enum(['create', 'update', 'delete']),
        base_id: baseIdSchema,
        table_id: tableIdSchema.optional().describe('Required for field operations and disposable table deletion; omit when creating a disposable table.'),
        field_id: fieldIdSchema.optional(),
        field_name: z.string().min(1).optional(),
        field_type: z.enum(SAFE_FIELD_TYPES).optional(),
        options: z.record(z.string(), z.unknown()).optional(),
        expected_field_type: z.string().min(1).optional(),
        table_name: z.string().min(1).optional().describe('Disposable fixture table name with mcp_test_ or mcp_probe_ prefix.'),
        expected_table_name: z.string().min(1).optional().describe('Exact disposable table name required for deletion.'),
        include_full_schema: z.boolean().default(false).describe('Opt in to full before/after field arrays; default responses are compact.'),
        apply: z.boolean().default(false),
      },
    },
    async (input) => tryTool(() => applySchemaWrite(input as Record<string, unknown>, client), 'schema_write'),
  );
}
