import fs from 'node:fs';
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
        'Update one or more records. Each record MUST include its primary key (Id). ' +
        'Only the included fields are updated.',
      inputSchema: {
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        records: z
          .array(recordSchema)
          .min(1)
          .describe('Array of records, each with primary key + fields to update'),
      },
    },
    async ({ base_id, table_id, records }) =>
      tryTool(
        () =>
          client.request(`/data/${base_id}/${table_id}/records`, {
            method: 'PATCH',
            body: records,
          }),
        'update_records',
      ),
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
    'upsert_records',
    {
      title: 'Upsert records',
      description:
        'Insert records, or update them if a record with the same primary key already exists. ' +
        'Useful for idempotent imports.',
      inputSchema: {
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        records: z.array(recordSchema).min(1),
      },
    },
    async ({ base_id, table_id, records }) =>
      tryTool(
        () =>
          client.request(`/data/${base_id}/${table_id}/records/upsert`, {
            method: 'POST',
            body: records,
          }),
        'upsert_records',
      ),
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
        'Preview or update matching records without deleting anything. ' +
        'Preview returns a matching count and sample IDs; apply mode updates in batches and returns compact counts.',
      inputSchema: {
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        where: z.string().min(1).describe('NocoDB v3 where clause selecting the target records'),
        fields_to_clear_or_update: recordSchema.describe(
          'Fields to clear or update, e.g. { "Website Enrichment Status": null }',
        ),
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
        sample_size: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe('How many sample IDs to return in preview/apply summaries (default 10)'),
      },
    },
    async ({ base_id, table_id, where, fields_to_clear_or_update, apply, batch_size, sample_size }) =>
      tryTool(async () => {
        const sampleSize = sample_size ?? DEFAULT_SAMPLE_SIZE;
        const matchedBefore = await countMatchingRecords(client, base_id, table_id, where);
        const sampleIds = await listMatchingRecordIds(client, base_id, table_id, where, sampleSize);
        const auditBase = {
          tool: 'conditional_bulk_update_records',
          target: `${base_id}/${table_id}`,
          preview_count: matchedBefore,
        };

        if (!apply) {
          appendAuditLog({ ...auditBase, updated_count: 0 });
          return {
            ok: true,
            preview_only: true,
            matched_before: matchedBefore,
            matched_after: matchedBefore,
            updated_count: 0,
            sample_ids: sampleIds,
            changed_fields: fields_to_clear_or_update,
            note: 'No changes were made. Re-run with apply=true to execute.',
          };
        }

        const idsToUpdate = await listMatchingRecordIds(
          client,
          base_id,
          table_id,
          where,
          Math.min(matchedBefore, MAX_ID_SCAN),
        );
        let updatedCount = 0;
        const idsUpdatedSample: Array<string | number> = [];
        const effectiveBatchSize = batch_size ?? 100;

        for (const idChunk of chunkArray(idsToUpdate, effectiveBatchSize)) {
          await client.request(`/data/${base_id}/${table_id}/records`, {
            method: 'PATCH',
            body: idChunk.map((id) => ({ Id: id, ...fields_to_clear_or_update })),
          });
          updatedCount += idChunk.length;
          for (const id of idChunk) {
            if (idsUpdatedSample.length < sampleSize) idsUpdatedSample.push(id);
          }
        }

        const matchedAfter = await countMatchingRecords(client, base_id, table_id, where);
        appendAuditLog({ ...auditBase, updated_count: updatedCount });
        return {
          ok: true,
          preview_only: false,
          matched_before: matchedBefore,
          updated_count: updatedCount,
          matched_after: matchedAfter,
          sample_ids_updated: idsUpdatedSample,
          changed_fields: fields_to_clear_or_update,
          scan_capped: matchedBefore > MAX_ID_SCAN,
        };
      }, 'conditional_bulk_update_records'),
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
