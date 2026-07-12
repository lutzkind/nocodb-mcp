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
      return { id: 'm-table', fields };
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
});
