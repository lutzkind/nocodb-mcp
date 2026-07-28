import fs from 'node:fs';
import crypto from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { NocoDBClient } from '../client.js';
import { baseIdSchema, dryRunSchema, tableIdSchema } from '../schemas/common.js';
import { dryRunPreview, tryTool } from './helpers.js';

const recordSchema = z
  .record(z.string(), z.unknown())
  .describe('Object: { field_title: value, ... }');
const AUDIT_LOG_PATH = '/tmp/nocodb-mcp-audit.jsonl';
const MAX_BATCH_SIZE = 200;
const MAX_ID_SCAN = 20000;
const DEFAULT_SAMPLE_SIZE = 10;
const MAX_GUARDED_RECORDS = 100;

export class TargetIdentityMismatch extends Error {
  readonly code = 'TARGET_IDENTITY_MISMATCH';

  constructor(message: string) {
    super(message);
    this.name = 'TargetIdentityMismatch';
  }
}

interface ConditionalBulkUpdateInput {
  base_id: string;
  table_id: string;
  where: string;
  fields_to_clear_or_update: Record<string, unknown>;
  apply?: boolean;
  batch_size?: number;
  sample_size?: number;
  request_id?: string;
  preview_token?: string;
}

interface ConditionalBulkPreview {
  request_id: string;
  base_id: string;
  table_id: string;
  where: string;
  fields_digest: string;
  batch_size: number;
  sample_size: number;
  ids: Array<string | number>;
  target_digest: string;
  expires_at: number;
}

const conditionalBulkPreviews = new Map<string, ConditionalBulkPreview>();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function requestIdFor(value: string | undefined, required: boolean): string {
  if (value !== undefined) {
    const requestId = value.trim();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) throw new TargetIdentityMismatch('request_id is invalid');
    return requestId;
  }
  if (required) throw new TargetIdentityMismatch('request_id is required when applying a preview token');
  return crypto.randomUUID();
}

function identityDigest(input: Pick<ConditionalBulkUpdateInput, 'base_id' | 'table_id' | 'where' | 'fields_to_clear_or_update'>, batchSize: number, sampleSize: number): string {
  return digest({ base_id: input.base_id, table_id: input.table_id, where: input.where, fields: input.fields_to_clear_or_update, batch_size: batchSize, sample_size: sampleSize });
}

function idDigest(ids: Array<string | number>): string {
  return digest(ids.map((id) => `${typeof id}:${String(id)}`));
}

function previewFor(token: string): ConditionalBulkPreview {
  const preview = conditionalBulkPreviews.get(token);
  if (!preview || preview.expires_at < Date.now()) {
    if (preview) conditionalBulkPreviews.delete(token);
    throw new TargetIdentityMismatch('preview token is missing or expired');
  }
  return preview;
}

function claimPreview(token: string, requestId: string): ConditionalBulkPreview {
  const preview = previewFor(token);
  if (preview.request_id !== requestId) throw new TargetIdentityMismatch('preview token does not match request_id');
  // Map deletion is synchronous and occurs before the first await. This makes
  // the capability single-use under interleaved concurrent apply requests.
  conditionalBulkPreviews.delete(token);
  return preview;
}

function mutationEnvelope(target: Record<string, unknown>, changed: boolean, verified: boolean, warnings: string[] = []) {
  return {
    requested_target: target,
    applied_target: changed ? target : null,
    changed,
    verified,
    warnings,
    audit_id: crypto.randomUUID(),
  };
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (key === 'Id') continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) diff[key] = { before: before[key], after: value };
  }
  return diff;
}

function appendAuditLog(entry: Record<string, unknown>): void {
  fs.appendFileSync(
    AUDIT_LOG_PATH,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
    'utf8',
  );
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function recordIdValue(record: Record<string, unknown>): string | number | null {
  const id = record.Id;
  if (typeof id === 'string' || typeof id === 'number') {
    return id;
  }
  return null;
}

async function countMatchingRecords(
  client: NocoDBClient,
  baseId: string,
  tableId: string,
  where?: string,
): Promise<number> {
  const count = await client.request<number | { count?: number; value?: number }>(
    `/data/${baseId}/${tableId}/count`,
    { query: { where } },
  );

  if (typeof count === 'number') return count;
  if (typeof count.count === 'number') return count.count;
  if (typeof count.value === 'number') return count.value;
  return 0;
}

async function listMatchingRecordIds(
  client: NocoDBClient,
  baseId: string,
  tableId: string,
  where: string | undefined,
  limit: number,
): Promise<Array<string | number>> {
  const ids: Array<string | number> = [];
  let offset = 0;
  const pageSize = Math.min(MAX_BATCH_SIZE, Math.max(limit, 1));

  while (ids.length < limit) {
    const page = await client.request<{ list?: Array<Record<string, unknown>> }>(
      `/data/${baseId}/${tableId}/records`,
      {
        query: {
          where,
          fields: 'Id',
          limit: Math.min(pageSize, limit - ids.length),
          offset,
        },
      },
    );
    const records = page.list ?? [];
    if (records.length === 0) break;
    for (const record of records) {
      const id = recordIdValue(record);
      if (id !== null) ids.push(id);
    }
    if (records.length < pageSize) break;
    offset += records.length;
  }

  return ids;
}

export async function runConditionalBulkUpdate(input: ConditionalBulkUpdateInput, client: NocoDBClient): Promise<Record<string, unknown>> {
  const sampleSize = input.sample_size ?? DEFAULT_SAMPLE_SIZE;
  const effectiveBatchSize = input.batch_size ?? 100;
  const auditBase = {
    tool: 'conditional_bulk_update_records',
    request_id: input.request_id ?? null,
    requested_target: `${input.base_id}/${input.table_id}`,
    resolved_target: `${input.base_id}/${input.table_id}`,
    applied_target: null,
    verified_target: null,
    expected_hash: null,
    current_hash: null,
    new_hash: null,
    outcome: input.apply ? 'apply_started' : 'preview',
  };

  if (!input.apply) {
    const requestId = requestIdFor(input.request_id, false);
    const matchedBefore = await countMatchingRecords(client, input.base_id, input.table_id, input.where);
    if (matchedBefore > MAX_ID_SCAN) throw new TargetIdentityMismatch(`target set exceeds exact binding limit of ${MAX_ID_SCAN} records`);
    const ids = await listMatchingRecordIds(client, input.base_id, input.table_id, input.where, matchedBefore);
    if (ids.length !== matchedBefore) throw new TargetIdentityMismatch('target set changed during preview; exact target identity could not be bound');
    const token = crypto.randomBytes(24).toString('hex');
    const preview: ConditionalBulkPreview = {
      request_id: requestId,
      base_id: input.base_id,
      table_id: input.table_id,
      where: input.where,
      fields_digest: digest(input.fields_to_clear_or_update),
      batch_size: effectiveBatchSize,
      sample_size: sampleSize,
      ids,
      target_digest: idDigest(ids),
      expires_at: Date.now() + 15 * 60 * 1000,
    };
    conditionalBulkPreviews.set(token, preview);
    while (conditionalBulkPreviews.size > 256) conditionalBulkPreviews.delete(conditionalBulkPreviews.keys().next().value as string);
    appendAuditLog({ ...auditBase, request_id: requestId, preview_token_hash: digest(token), target_digest: preview.target_digest, preview_count: ids.length, updated_count: 0, outcome: 'preview_created' });
    return {
      ok: true,
      preview_only: true,
      request_id: requestId,
      preview_token: token,
      preview_digest: preview.target_digest,
      requested_target: `${input.base_id}/${input.table_id}`,
      matched_before: matchedBefore,
      matched_after: matchedBefore,
      updated_count: 0,
      target_ids_bound: ids.length,
      sample_ids: ids.slice(0, sampleSize),
      changed_fields: input.fields_to_clear_or_update,
      note: 'No changes were made. Re-run with apply=true, the returned request_id, and the exact preview_token within 15 minutes.',
    };
  }

  const requestId = requestIdFor(input.request_id, true);
  const token = String(input.preview_token ?? '');
  if (!token) throw new TargetIdentityMismatch('preview_token is required when applying a conditional bulk update');
  const candidate = previewFor(token);
  const candidateDigest = identityDigest(input, effectiveBatchSize, sampleSize);
  const expectedDigest = identityDigest({ ...input, fields_to_clear_or_update: input.fields_to_clear_or_update }, candidate.batch_size, candidate.sample_size);
  if (candidate.request_id !== requestId || candidate.base_id !== input.base_id || candidate.table_id !== input.table_id || candidate.where !== input.where || candidate.fields_digest !== digest(input.fields_to_clear_or_update) || candidate.batch_size !== effectiveBatchSize || candidate.sample_size !== sampleSize) {
    throw new TargetIdentityMismatch(`preview target binding differs (requested=${candidateDigest.slice(0, 12)}, preview=${expectedDigest.slice(0, 12)})`);
  }
  const saved = claimPreview(token, requestId);
  const matchedBefore = await countMatchingRecords(client, saved.base_id, saved.table_id, saved.where);
  const currentIds = await listMatchingRecordIds(client, saved.base_id, saved.table_id, saved.where, saved.ids.length);
  if (matchedBefore !== saved.ids.length || currentIds.length !== saved.ids.length || idDigest(currentIds) !== saved.target_digest) {
    appendAuditLog({ ...auditBase, request_id: requestId, preview_token_hash: digest(token), target_digest: saved.target_digest, current_target_digest: idDigest(currentIds), preview_count: saved.ids.length, current_count: matchedBefore, outcome: 'error', error_code: 'TARGET_IDENTITY_MISMATCH' });
    throw new TargetIdentityMismatch('target ID set changed after preview; no records were mutated');
  }

  let updatedCount = 0;
  const idsUpdatedSample: Array<string | number> = [];
  for (const idChunk of chunkArray(saved.ids, saved.batch_size)) {
    await client.request(`/data/${saved.base_id}/${saved.table_id}/records`, {
      method: 'PATCH',
      body: idChunk.map((id) => ({ Id: id, ...input.fields_to_clear_or_update })),
    });
    updatedCount += idChunk.length;
    idsUpdatedSample.push(...idChunk.slice(0, Math.max(0, sampleSize - idsUpdatedSample.length)));
  }

  const verifiedRows = await Promise.all(saved.ids.map((id) => client.request<Record<string, unknown>>(`/data/${saved.base_id}/${saved.table_id}/records/${encodeURIComponent(String(id))}`)));
  const verified = verifiedRows.every((row) => Object.entries(input.fields_to_clear_or_update).every(([key, value]) => JSON.stringify(row[key]) === JSON.stringify(value)));
  if (!verified) {
    appendAuditLog({ ...auditBase, request_id: requestId, preview_token_hash: digest(token), target_digest: saved.target_digest, applied_target: `${saved.base_id}/${saved.table_id}`, outcome: 'error', error_code: 'POST_WRITE_VERIFICATION_FAILED' });
    throw new Error('POST_WRITE_VERIFICATION_FAILED: one or more records did not match the requested fields');
  }
  const matchedAfter = await countMatchingRecords(client, saved.base_id, saved.table_id, saved.where);
  appendAuditLog({ ...auditBase, request_id: requestId, preview_token_hash: digest(token), target_digest: saved.target_digest, applied_target: `${saved.base_id}/${saved.table_id}`, verified_target: `${saved.base_id}/${saved.table_id}`, preview_count: saved.ids.length, updated_count: updatedCount, current_count: matchedAfter, outcome: 'success' });
  return {
    ok: true,
    preview_only: false,
    request_id: requestId,
    preview_token: token,
    preview_digest: saved.target_digest,
    requested_target: `${saved.base_id}/${saved.table_id}`,
    applied_target: `${saved.base_id}/${saved.table_id}`,
    verified_target: `${saved.base_id}/${saved.table_id}`,
    matched_before: matchedBefore,
    updated_count: updatedCount,
    matched_after: matchedAfter,
    sample_ids_updated: idsUpdatedSample,
    changed_fields: input.fields_to_clear_or_update,
    verified,
  };
}

export function registerRecordTools(server: McpServer, client: NocoDBClient): void {
  server.registerTool(
    'list_records',
    {
      title: 'List records',
      description:
        'List records from a table with optional filtering, sorting, pagination, and field selection. ' +
        'NocoDB v3 `where` syntax: (FieldName,operator,value) joined by ~and / ~or. ' +
        'Operators: eq, neq, like, nlike, gt, lt, ge, le, null, notnull, empty, notempty, in, notin. ' +
        'Wrap values containing commas/parens in quotes: (Name,eq,"Smith, John").',
      inputSchema: {
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        where: z.string().optional().describe('NocoDB v3 where clause'),
        sort: z
          .string()
          .optional()
          .describe('Comma-separated field names. Prefix with - for descending: "Name,-CreatedAt"'),
        fields: z.string().optional().describe('Comma-separated list of fields to return'),
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe('Page size (default 25, max 1000)'),
        offset: z.number().int().nonnegative().optional().describe('Skip N records'),
        view_id: z.string().optional().describe('Filter by a specific view ID'),
      },
    },
    async ({ base_id, table_id, where, sort, fields, limit, offset, view_id }) =>
      tryTool(
        () =>
          client.request(`/data/${base_id}/${table_id}/records`, {
            query: { where, sort, fields, limit, offset, viewId: view_id },
          }),
        'list_records',
      ),
  );

  server.registerTool(
    'get_record',
    {
      title: 'Get record',
      description: 'Get a single record by its ID.',
      inputSchema: {
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        record_id: z.string().describe('Record ID (primary key value, usually numeric or UUID)'),
        fields: z.string().optional().describe('Comma-separated list of fields to return'),
      },
    },
    async ({ base_id, table_id, record_id, fields }) =>
      tryTool(
        () =>
          client.request(`/data/${base_id}/${table_id}/records/${record_id}`, {
            query: { fields },
          }),
        'get_record',
      ),
  );

  server.registerTool(
    'create_records',
    {
      title: 'Create records (bulk)',
      description:
        'Insert one or more records. Each record is an object { field_title: value, ... }. ' +
        'Returns the created records with their assigned IDs.',
      inputSchema: {
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        records: z.array(recordSchema).min(1).describe('Array of records to insert (max ~1000)'),
      },
    },
    async ({ base_id, table_id, records }) =>
      tryTool(
        () =>
          client.request(`/data/${base_id}/${table_id}/records`, {
            method: 'POST',
            body: records,
          }),
        'create_records',
      ),
  );

  server.registerTool(
    'update_records',
    {
      title: 'Update records (bulk)',
      description:
        'Dry-run-first guarded update. Each record MUST include its exact primary key (Id). ' +
        'Set apply=true to write; optional expected_values prevent stale overwrites. Maximum 100 records.',
      inputSchema: {
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        records: z.array(recordSchema).min(1).max(MAX_GUARDED_RECORDS),
        expected_values: z.record(z.string(), z.unknown()).optional().describe('Values that must still match on every targeted record.'),
        apply: z.boolean().optional().default(false),
      },
    },
    async ({ base_id, table_id, records, expected_values, apply }) => tryTool(async () => {
      const ids = records.map(recordIdValue);
      if (ids.some((id) => id === null)) throw new Error('TARGET_MISMATCH: every record must include an exact Id primary key');
      const current = await Promise.all(ids.map((id) => client.request<Record<string, unknown>>(`/data/${base_id}/${table_id}/records/${encodeURIComponent(String(id))}`)));
      const previews = current.map((before, index) => ({ id: ids[index], changed_fields: changedFields(before, records[index]) }));
      for (const before of current) {
        for (const [key, value] of Object.entries(expected_values ?? {})) {
          if (JSON.stringify(before[key]) !== JSON.stringify(value)) throw new Error(`STALE_REVISION: expected value for ${key} does not match record ${String(before.Id)}`);
        }
      }
      if (!apply) return { ok: true, ...mutationEnvelope({ base_id, table_id, ids }, false, true), preview_only: true, previews, note: 'No changes were made. Re-run with apply=true.' };
      await client.request(`/data/${base_id}/${table_id}/records`, { method: 'PATCH', body: records });
      const after = await Promise.all(ids.map((id) => client.request<Record<string, unknown>>(`/data/${base_id}/${table_id}/records/${encodeURIComponent(String(id))}`)));
      const verified = after.every((row, index) => Object.entries(records[index]).every(([key, value]) => key === 'Id' || JSON.stringify(row[key]) === JSON.stringify(value)));
      if (!verified) throw new Error('POST_WRITE_VERIFICATION_FAILED: one or more records did not match the requested fields');
      const envelope = mutationEnvelope({ base_id, table_id, ids }, true, true);
      appendAuditLog({ tool: 'update_records', ...envelope });
      return { ok: true, ...envelope, preview_only: false, previews, verified_records: after.map((row) => row.Id) };
    }, 'update_records'),
  );

  server.registerTool(
    'upsert_records',
    {
      title: 'Upsert records (guarded)',
      description: 'Dry-run-first bounded upsert. Requires an explicit table and conflict key list; no filter-based matching.',
      inputSchema: {
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        conflict_keys: z.array(z.string().min(1)).min(1).max(8),
        records: z.array(recordSchema).min(1).max(MAX_GUARDED_RECORDS),
        apply: z.boolean().optional().default(false),
      },
    },
    async ({ base_id, table_id, conflict_keys, records, apply }) => tryTool(async () => {
      const target = { base_id, table_id, conflict_keys, count: records.length };
      if (!apply) return { ok: true, ...mutationEnvelope(target, false, true), preview_only: true, records, note: 'No changes were made. Re-run with apply=true.' };
      const result = await client.request<unknown>(`/data/${base_id}/${table_id}/records/upsert`, {
        method: 'POST',
        body: { records, conflict_keys },
      });
      const resultRows = Array.isArray(result)
        ? result
        : result && typeof result === 'object' && Array.isArray((result as Record<string, unknown>).list)
          ? (result as Record<string, unknown>).list as unknown[]
          : [];
      const returnedIds = resultRows
        .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'))
        .map(recordIdValue)
        .filter((id): id is string | number => id !== null);
      if (returnedIds.length !== records.length) {
        throw new Error('POST_WRITE_VERIFICATION_FAILED: upsert did not return one exact record identity per requested row');
      }
      const verifiedRows = await Promise.all(returnedIds.map((id) => client.request<Record<string, unknown>>(`/data/${base_id}/${table_id}/records/${encodeURIComponent(String(id))}`)));
      const verified = verifiedRows.every((row, index) => conflict_keys.every((key) => JSON.stringify(row[key]) === JSON.stringify(resultRows[index][key])));
      if (!verified) throw new Error('POST_WRITE_VERIFICATION_FAILED: upsert conflict keys did not match the returned records');
      const envelope = mutationEnvelope(target, true, true);
      appendAuditLog({ tool: 'upsert_records', ...envelope });
      return { ok: true, ...envelope, preview_only: false, result };
    }, 'upsert_records'),
  );

  server.registerTool(
    'delete_records_guarded',
    {
      title: 'Delete records (guarded)',
      description: 'Dry-run-first exact-ID deletion. Broad filters and unbounded deletion are not accepted.',
      inputSchema: {
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        record_ids: z.array(z.union([z.string(), z.number()])).min(1).max(MAX_GUARDED_RECORDS),
        expected_values: z.record(z.string(), z.unknown()).optional(),
        apply: z.boolean().optional().default(false),
      },
    },
    async ({ base_id, table_id, record_ids, expected_values, apply }) => tryTool(async () => {
      const target = { base_id, table_id, record_ids };
      const current = await Promise.all(record_ids.map((id) => client.request<Record<string, unknown>>(`/data/${base_id}/${table_id}/records/${encodeURIComponent(String(id))}`)));
      for (const row of current) for (const [key, value] of Object.entries(expected_values ?? {})) if (JSON.stringify(row[key]) !== JSON.stringify(value)) throw new Error(`STALE_REVISION: expected value for ${key} does not match record ${String(row.Id)}`);
      if (!apply) return { ok: true, ...mutationEnvelope(target, false, true), preview_only: true, matched: current.map((row) => row.Id), note: 'No changes were made. Re-run with apply=true.' };
      await client.request(`/data/${base_id}/${table_id}/records`, { method: 'DELETE', body: record_ids.map((id) => ({ Id: id })) });
      const remaining = [];
      for (const id of record_ids) {
        try { await client.request(`/data/${base_id}/${table_id}/records/${encodeURIComponent(String(id))}`); remaining.push(id); } catch { /* expected absence */ }
      }
      if (remaining.length) throw new Error(`POST_WRITE_VERIFICATION_FAILED: records remain after deletion: ${remaining.join(',')}`);
      const envelope = mutationEnvelope(target, true, true);
      appendAuditLog({ tool: 'delete_records_guarded', ...envelope });
      return { ok: true, ...envelope, preview_only: false, deleted: record_ids };
    }, 'delete_records_guarded'),
  );

  server.registerTool(
    'delete_records',
    {
      title: 'Delete records (bulk)',
      description:
        'Delete one or more records by their primary keys. Irreversible. ' +
        'Use `dry_run: true` first to preview which records would be deleted.',
      inputSchema: {
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        record_ids: z
          .array(z.union([z.string(), z.number()]))
          .min(1)
          .describe('Array of primary key values'),
        dry_run: dryRunSchema,
      },
    },
    async ({ base_id, table_id, record_ids, dry_run }) => {
      if (dry_run) {
        return dryRunPreview('delete_records', {
          base_id,
          table_id,
          count: record_ids.length,
          record_ids,
        });
      }
      return tryTool(
        () =>
          client.request(`/data/${base_id}/${table_id}/records`, {
            method: 'DELETE',
            body: record_ids.map((id) => ({ Id: id })),
          }),
        'delete_records',
      );
    },
  );

  server.registerTool(
    'count_records',
    {
      title: 'Count records',
      description:
        'Count records in a table, optionally filtered by a `where` clause. ' +
        'Cheaper than list_records when you only need the count.',
      inputSchema: {
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        where: z.string().optional().describe('Optional NocoDB v3 where clause'),
        view_id: z.string().optional(),
      },
    },
    async ({ base_id, table_id, where, view_id }) =>
      tryTool(
        () =>
          client.request(`/data/${base_id}/${table_id}/count`, {
            query: { where, viewId: view_id },
          }),
        'count_records',
      ),
  );

  server.registerTool(
    'conditional_bulk_update_records',
    {
      title: 'Conditional bulk update records',
      description:
        'Preview or update matching records without deleting anything. Apply requires the exact single-use preview token, request ID, target, filter, patch, and unchanged target ID set from preview.',
      inputSchema: {
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        where: z.string().min(1).describe('NocoDB v3 where clause selecting the target records'),
        fields_to_clear_or_update: recordSchema.describe(
          'Fields to clear or update, e.g. { "Website Enrichment Status": null }',
        ),
        apply: z.boolean().optional().describe('Set true to perform the update. Omit or false to preview only.'),
        batch_size: z.number().int().positive().max(MAX_BATCH_SIZE).optional().describe(`Batch size for apply mode (max ${MAX_BATCH_SIZE}, default 100)`),
        sample_size: z.number().int().positive().max(50).optional().describe('How many sample IDs to return in preview/apply summaries (default 10)'),
        request_id: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional().describe('Request binding ID returned by preview; required for apply.'),
        preview_token: z.string().regex(/^[a-f0-9]{48}$/i).optional().describe('Single-use exact-target preview capability.'),
      },
    },
    async (input) => tryTool(() => runConditionalBulkUpdate(input, client), 'conditional_bulk_update_records'),
  );

  server.registerTool(
    'update_records_compact',
    {
      title: 'Update records compact',
      description:
        'Update records by ID with a compact response that returns only IDs and changed fields, not full NocoDB row payloads.',
      inputSchema: {
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        record_ids: z
          .array(z.union([z.string(), z.number()]))
          .min(1)
          .describe('Record IDs to update'),
        fields: recordSchema.describe('Fields to update on every selected record'),
        apply: z
          .boolean()
          .optional()
          .describe('Set true to perform the update. Omit or false to preview only.'),
        batch_size: z
          .number()
          .int()
          .positive()
          .max(MAX_BATCH_SIZE)
          .optional()
          .describe(`Batch size for apply mode (max ${MAX_BATCH_SIZE}, default 100)`),
      },
    },
    async ({ base_id, table_id, record_ids, fields, apply, batch_size }) =>
      tryTool(async () => {
        const sampleIds = record_ids.slice(0, DEFAULT_SAMPLE_SIZE);
        const auditBase = {
          tool: 'update_records_compact',
          target: `${base_id}/${table_id}`,
          preview_count: record_ids.length,
        };

        if (!apply) {
          appendAuditLog({ ...auditBase, updated_count: 0 });
          return {
            ok: true,
            preview_only: true,
            matched_before: record_ids.length,
            updated_count: 0,
            ids: sampleIds,
            changed_fields: fields,
            note: 'No changes were made. Re-run with apply=true to execute.',
          };
        }

        const effectiveBatchSize = batch_size ?? 100;
        let updatedCount = 0;
        for (const idChunk of chunkArray(record_ids, effectiveBatchSize)) {
          await client.request(`/data/${base_id}/${table_id}/records`, {
            method: 'PATCH',
            body: idChunk.map((id) => ({ Id: id, ...fields })),
          });
          updatedCount += idChunk.length;
        }

        appendAuditLog({ ...auditBase, updated_count: updatedCount });
        return {
          ok: true,
          preview_only: false,
          matched_before: record_ids.length,
          updated_count: updatedCount,
          ids: record_ids,
          changed_fields: fields,
        };
      }, 'update_records_compact'),
  );

  server.registerTool(
    'global_search',
    {
      title: 'Global search across base',
      description:
        'Search a substring across all string-like fields of all tables in a base. ' +
        'WARNING: this lists tables and runs a separate query per table — can be slow on large bases. ' +
        'Use `table_ids` to limit scope.',
      inputSchema: {
        base_id: baseIdSchema,
        query: z.string().min(1).describe('Substring to search for (case-insensitive)'),
        table_ids: z
          .array(z.string())
          .optional()
          .describe('Optional: only search these tables. Defaults to all tables in the base.'),
        limit_per_table: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe('Max matching records per table (default 10)'),
      },
    },
    async ({ base_id, query, table_ids, limit_per_table }) =>
      tryTool(async () => {
        const limit = limit_per_table ?? 10;
        let tables: Array<{
          id: string;
          title: string;
          fields?: Array<{ title: string; uidt: string }>;
        }>;

        if (table_ids?.length) {
          tables = await Promise.all(
            table_ids.map((tid) =>
              client.request<{
                id: string;
                title: string;
                fields?: Array<{ title: string; uidt: string }>;
              }>(`/meta/bases/${base_id}/tables/${tid}`),
            ),
          );
        } else {
          const tableList = await client.request<{
            list?: Array<{ id: string; title: string }>;
          }>(`/meta/bases/${base_id}/tables`);
          tables = await Promise.all(
            (tableList.list ?? []).map((t) =>
              client.request<{
                id: string;
                title: string;
                fields?: Array<{ title: string; uidt: string }>;
              }>(`/meta/bases/${base_id}/tables/${t.id}`),
            ),
          );
        }

        const stringTypes = new Set([
          'SingleLineText',
          'LongText',
          'RichText',
          'Email',
          'URL',
          'PhoneNumber',
          'SingleSelect',
          'MultiSelect',
        ]);

        const results: Array<{ table_id: string; table_title: string; matches: unknown[] }> = [];

        for (const table of tables) {
          const searchableFields = (table.fields ?? []).filter((f) => stringTypes.has(f.uidt));
          if (searchableFields.length === 0) continue;

          const whereClause = searchableFields
            .map((f) => `(${f.title},like,%${query}%)`)
            .join('~or');

          const data = await client.request<{ list?: unknown[] }>(
            `/data/${base_id}/${table.id}/records`,
            { query: { where: whereClause, limit } },
          );

          if (data.list && data.list.length > 0) {
            results.push({
              table_id: table.id,
              table_title: table.title,
              matches: data.list,
            });
          }
        }

        return {
          query,
          tables_searched: tables.length,
          tables_with_matches: results.length,
          results,
        };
      }, 'global_search'),
  );
}
