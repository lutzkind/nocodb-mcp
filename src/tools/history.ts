import fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { NocoDBClient } from '../client.js';
import { baseIdSchema, tableIdSchema } from '../schemas/common.js';
import { tryTool } from './helpers.js';

const LOCAL_AUDIT_LOG = '/tmp/nocodb-mcp-audit.jsonl';
const sensitive = /(password|secret|token|api[_-]?key|authorization|private[_-]?key|email[_-]?body|mime|html|body)/i;

export function redactHistoryValue(value: unknown, key = ''): unknown {
  if (sensitive.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactHistoryValue(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactHistoryValue(v, k)]));
  return value;
}

async function firstAvailable(client: NocoDBClient, paths: string[]): Promise<{ source: string; data: unknown } | null> {
  for (const path of paths) {
    try {
      const data = await client.request(path);
      return { source: path, data };
    } catch (error) {
      if ((error as { status?: number })?.status !== 404) throw error;
    }
  }
  return null;
}

export function registerRecordHistoryTools(server: McpServer, client: NocoDBClient): void {
  server.registerTool(
    'record_history',
    {
      title: 'Read NocoDB record history',
      description:
        'Read-only audit/history lookup. Uses native NocoDB history/audit endpoints when exposed, then the existing MCP mutation audit log when it contains a matching event. It never fabricates history from the current row; unavailable history is explicit.',
      inputSchema: {
        base_id: baseIdSchema,
        table_id: tableIdSchema,
        record_id: z.union([z.string(), z.number()]).describe('Record primary key'),
        limit: z.number().int().positive().max(200).optional(),
        source: z.enum(['auto', 'native', 'mcp_audit']).optional(),
      },
    },
    async ({ base_id, table_id, record_id, limit, source }) =>
      tryTool(async () => {
        const native = source !== 'mcp_audit' ? await firstAvailable(client, [
          `/meta/bases/${base_id}/tables/${table_id}/records/${record_id}/history`,
          `/meta/bases/${base_id}/tables/${table_id}/records/${record_id}/audit`,
          `/meta/bases/${base_id}/audit-logs?record_id=${encodeURIComponent(String(record_id))}`,
        ]) : null;
        if (native) {
          const rows = Array.isArray(native.data) ? native.data : (native.data as { list?: unknown[] })?.list ?? [];
          return {
            history_available: true,
            source: 'nocodb_native',
            source_identifier: native.source,
            record_id: String(record_id),
            events: rows.slice(0, limit ?? 100).map((event) => redactHistoryValue(event)),
            identifiers: { nocodb_base_id: base_id, nocodb_table_id: table_id, nocodb_record_id: String(record_id) },
            redacted: true,
          };
        }
        if (source !== 'native' && fs.existsSync(LOCAL_AUDIT_LOG)) {
          const rows = fs.readFileSync(LOCAL_AUDIT_LOG, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
            try { return [JSON.parse(line)]; } catch { return []; }
          }).filter((event) => String(event.target ?? '').includes(`${base_id}/${table_id}`) && (!event.ids || event.ids.map(String).includes(String(record_id))));
          if (rows.length) return {
            history_available: true,
            source: 'mcp_audit_log',
            source_identifier: LOCAL_AUDIT_LOG,
            record_id: String(record_id),
            events: rows.slice(-(limit ?? 100)).map((event) => redactHistoryValue({ ...event, changed_fields: event.changed_fields ?? [], previous_values: null, new_values: null })),
            identifiers: { nocodb_base_id: base_id, nocodb_table_id: table_id, nocodb_record_id: String(record_id) },
            redacted: true,
            note: 'The local MCP audit log records mutation intent/counts, not full field values or actor identity.',
          };
        }
        return {
          history_available: false,
          reason: 'This NocoDB installation did not expose a native record history/audit endpoint, and no matching existing MCP audit event was available.',
          record_id: String(record_id),
          events: [],
          identifiers: { nocodb_base_id: base_id, nocodb_table_id: table_id, nocodb_record_id: String(record_id) },
          redacted: true,
        };
      }, 'record_history'),
  );
}
