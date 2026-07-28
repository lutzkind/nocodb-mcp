import { describe, expect, it } from 'vitest';
import type { NocoDBClient } from '../src/client.js';
import { runConditionalBulkUpdate } from '../src/tools/records.js';

type Row = Record<string, unknown>;

function fixtureClient(rows: Row[]) {
  let patchCount = 0;
  const client = {
    request: async <T>(path: string, options: { query?: Record<string, unknown>; body?: unknown } = {}) => {
      if (path.endsWith('/count')) return rows.length as T;
      if (path.endsWith('/records')) {
        if (options.body) {
          patchCount += 1;
          for (const update of options.body as Row[]) {
            const target = rows.find((row) => row.Id === update.Id);
            if (target) Object.assign(target, update);
          }
          return {} as T;
        }
        const offset = Number(options.query?.offset ?? 0);
        const limit = Number(options.query?.limit ?? rows.length);
        return { list: rows.slice(offset, offset + limit).map((row) => ({ Id: row.Id })) } as T;
      }
      const id = decodeURIComponent(path.split('/').at(-1) ?? '');
      const row = rows.find((candidate) => String(candidate.Id) === id);
      if (!row) throw new Error('not found');
      return { ...row } as T;
    },
    get patchCount() {
      return patchCount;
    },
  };
  return client;
}

describe('conditional bulk update exact target binding', () => {
  it('refuses a preview target set that changed before apply and performs zero patches', async () => {
    const rows: Row[] = [{ Id: 1, Status: 'old' }, { Id: 2, Status: 'old' }];
    const client = fixtureClient(rows);
    const preview = await runConditionalBulkUpdate({
      base_id: 'base-a', table_id: 'table-a', where: '(Status,eq,old)',
      fields_to_clear_or_update: { Status: 'new' },
    }, client as unknown as NocoDBClient);
    rows.push({ Id: 3, Status: 'old' });
    await expect(runConditionalBulkUpdate({
      base_id: 'base-a', table_id: 'table-a', where: '(Status,eq,old)', apply: true,
      fields_to_clear_or_update: { Status: 'new' }, request_id: String(preview.request_id), preview_token: String(preview.preview_token),
    }, client as unknown as NocoDBClient)).rejects.toMatchObject({ code: 'TARGET_IDENTITY_MISMATCH' });
    expect(client.patchCount).toBe(0);
    expect(rows.every((row) => row.Status === 'old')).toBe(true);
  });

  it('cannot apply a token to another table and concurrent applies consume it once', async () => {
    const rows: Row[] = [{ Id: 'etsy-1', Status: 'old' }, { Id: 'etsy-2', Status: 'old' }];
    const client = fixtureClient(rows);
    const preview = await runConditionalBulkUpdate({
      base_id: 'base-a', table_id: 'etsy', where: '(Status,eq,old)',
      fields_to_clear_or_update: { Status: 'new' },
    }, client as unknown as NocoDBClient);
    await expect(runConditionalBulkUpdate({
      base_id: 'base-a', table_id: 'website-redesign', where: '(Status,eq,old)', apply: true,
      fields_to_clear_or_update: { Status: 'new' }, request_id: String(preview.request_id), preview_token: String(preview.preview_token),
    }, client as unknown as NocoDBClient)).rejects.toMatchObject({ code: 'TARGET_IDENTITY_MISMATCH' });
    const input = {
      base_id: 'base-a', table_id: 'etsy', where: '(Status,eq,old)', apply: true,
      fields_to_clear_or_update: { Status: 'new' }, request_id: String(preview.request_id), preview_token: String(preview.preview_token),
    };
    const results = await Promise.allSettled([
      runConditionalBulkUpdate(input, client as unknown as NocoDBClient),
      runConditionalBulkUpdate(input, client as unknown as NocoDBClient),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(client.patchCount).toBe(1);
    expect(rows.every((row) => row.Status === 'new')).toBe(true);
  });
});
