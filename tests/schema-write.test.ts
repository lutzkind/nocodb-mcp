import { describe, expect, it } from 'vitest';
import { applySchemaWrite } from '../src/tools/schema-write.js';

function fakeClient(initialFields: Array<Record<string, unknown>>) {
  let fields = initialFields.map((field) => ({ ...field }));
  const calls: Array<{ path: string; options?: Record<string, unknown> }> = [];
  const client = {
    async request(path: string, options?: Record<string, unknown>) {
      calls.push({ path, options });
      if (options?.method === 'POST') {
        const body = options.body as Record<string, unknown>;
        fields = [...fields, { id: 'c-created', title: body.title, type: body.type, options: body.options ?? {} }];
      }
      if (options?.method === 'PATCH') {
        const body = options.body as Record<string, unknown>;
        fields = fields.map((field) => String(field.id) === path.split('/').pop() ? { ...field, title: body.title, type: body.type, options: body.options ?? {} } : field);
      }
      if (options?.method === 'DELETE') {
        const fieldId = path.split('/').pop();
        fields = fields.filter((field) => String(field.id) !== fieldId);
      }
      return { id: 'm-table', fields };
    },
  };
  return { client: client as never, calls };
}

function fakeDisposableTableClient() {
  let table: Record<string, unknown> | null = null;
  const calls: string[] = [];
  const client = {
    async request(path: string, options?: Record<string, unknown>) {
      calls.push(`${options?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/tables') && !options?.method) return table ? [table] : [];
      if (path.endsWith('/tables') && options?.method === 'POST') {
        table = { id: 'm-probe', title: (options.body as Record<string, unknown>).title, fields: [{ id: 'c-id', title: 'Id', type: 'ID' }] };
        return table;
      }
      if (path.endsWith('/count')) return 0;
      if (path.includes('/tables/m-probe') && options?.method === 'DELETE') { table = null; return null; }
      if (path.includes('/tables/m-probe')) {
        if (!table) throw Object.assign(new Error('not found'), { status: 404 });
        return table;
      }
      throw new Error(`unhandled ${path}`);
    },
  };
  return { client: client as never, calls };
}

describe('schema_write', () => {
  it('creates a URL field idempotently and verifies the applied schema', async () => {
    const fake = fakeClient([]);
    const result = await applySchemaWrite(
      {
        entity: 'field', operation: 'create', base_id: 'p-disposable', table_id: 'm-disposable',
        field_name: 'Website', field_type: 'URL', options: {}, apply: true,
      },
      fake.client,
    );
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.verification).toEqual({ ok: true, mismatches: [] });
    expect(result).not.toHaveProperty('before');
    expect(result).not.toHaveProperty('after');
    expect(result.field).toMatchObject({ id: 'c-created', name: 'Website', type: 'URL' });
    expect(fake.calls.map((call) => call.options?.method ?? 'GET')).toEqual(['GET', 'POST', 'GET']);

    const repeat = fakeClient([{ id: 'c-existing', title: 'Website', type: 'URL', options: {} }]);
    const repeatResult = await applySchemaWrite(
      {
        entity: 'field', operation: 'create', base_id: 'p-disposable', table_id: 'm-disposable',
        field_name: 'Website', field_type: 'URL', options: {}, apply: true,
      },
      repeat.client,
    );
    expect(repeatResult.ok).toBe(true);
    expect(repeatResult.applied).toBe(false);
    expect(repeatResult.idempotent).toBe(true);
    expect(repeat.calls).toHaveLength(1);
  });

  it('rejects a conflicting type for an existing field name', async () => {
    const fake = fakeClient([{ id: 'c-existing', title: 'Website', type: 'LongText', options: {} }]);
    await expect(
      applySchemaWrite(
        {
          entity: 'field', operation: 'create', base_id: 'p-disposable', table_id: 'm-disposable',
          field_name: 'Website', field_type: 'URL', options: {}, apply: true,
        },
        fake.client,
      ),
    ).rejects.toThrow(/conflicting type/);
    expect(fake.calls).toHaveLength(1);
  });

  it('returns compact update/delete results and rejects protected fields', async () => {
    const fake = fakeClient([{ id: 'c-existing', title: 'Website', type: 'URL', options: {} }]);
    const updated = await applySchemaWrite({
      entity: 'field', operation: 'update', base_id: 'p-disposable', table_id: 'm-disposable', field_id: 'c-existing',
      field_name: 'Homepage', field_type: 'URL', expected_field_type: 'URL', options: {}, apply: true,
    }, fake.client);
    expect(updated).toMatchObject({ operation: 'update', ok: true, applied: true, changed_fields: ['name'] });
    expect(updated).not.toHaveProperty('before');
    await expect(applySchemaWrite({
      entity: 'field', operation: 'delete', base_id: 'p-disposable', table_id: 'm-disposable', field_id: 'c-id',
      field_name: 'Id', field_type: 'URL', expected_field_type: 'ID', apply: true,
    }, fakeClient([{ id: 'c-id', title: 'Id', type: 'ID', pk: true }]).client)).rejects.toThrow(/protected primary/);
  });

  it('supports an explicitly allowlisted disposable table fixture', async () => {
    process.env.NOCODB_DISPOSABLE_BASE_IDS = 'p-disposable';
    const fake = fakeDisposableTableClient();
    const created = await applySchemaWrite({ entity: 'table', operation: 'create', base_id: 'p-disposable', table_name: 'mcp_test_schema_probe', apply: true }, fake.client);
    expect(created).toMatchObject({ ok: true, applied: true, operation: 'create', idempotent: false, table: { id: 'm-probe', name: 'mcp_test_schema_probe' } });
    const preview = await applySchemaWrite({ entity: 'table', operation: 'delete', base_id: 'p-disposable', table_id: 'm-probe', expected_table_name: 'mcp_test_schema_probe' }, fake.client);
    expect(preview.preview_only).toBe(true);
    const deleted = await applySchemaWrite({ entity: 'table', operation: 'delete', base_id: 'p-disposable', table_id: 'm-probe', expected_table_name: 'mcp_test_schema_probe', apply: true }, fake.client);
    expect(deleted).toMatchObject({ ok: true, applied: true, verification: { field_absent: true } });
    delete process.env.NOCODB_DISPOSABLE_BASE_IDS;
  });
});
