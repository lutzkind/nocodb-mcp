import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { NocoDBClient } from '../client.js';
import { tryTool } from './helpers.js';

type Candidate = { id: string; name: string; kind: 'base' | 'table' | 'field'; score: number; parent_id?: string };

function rank(name: string, query: string): number {
  const left = String(name ?? '').trim().toLowerCase();
  const right = String(query ?? '').trim().toLowerCase();
  if (left === right) return 0;
  if (left.startsWith(right)) return 1;
  if (left.includes(right)) return 2;
  return 3;
}

export function resolveCandidates(candidates: Candidate[], query: string) {
  const ranked = candidates.map((candidate) => ({ ...candidate, score: rank(candidate.name, query) })).sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  const best = ranked[0]?.score;
  const top = best === undefined ? [] : ranked.filter((candidate) => candidate.score === best);
  return {
    resolution_status: ranked.length === 0 ? 'not_found' : top.length === 1 ? 'resolved' : 'ambiguous',
    selected: top.length === 1 ? top[0] : null,
    candidates: ranked.slice(0, 20),
  };
}

export function registerMetadataResolutionTools(server: McpServer, client: NocoDBClient): void {
  server.registerTool(
    'resolve_metadata',
    {
      title: 'Resolve NocoDB names to stable IDs',
      description:
        'Read-only resolver for bases, tables, and fields. Exact names win; partial matches are ranked. ' +
        'Ambiguous results are never selected, so callers must reuse the returned stable IDs before any write.',
      inputSchema: {
        operation: z.enum(['base', 'table', 'field']),
        name: z.string().min(1).describe('Exact or partial human-readable name/title to resolve'),
        workspace_id: z.string().optional().describe('Required for base resolution unless base_id is supplied.'),
        base_id: z.string().optional(),
        table_id: z.string().optional(),
      },
    },
    async ({ operation, name, workspace_id, base_id, table_id }) =>
      tryTool(async () => {
        if (operation === 'base') {
          if (!workspace_id) throw new Error('workspace_id is required for base resolution');
          const response = await client.request<{ list?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(`/meta/workspaces/${workspace_id}/bases`);
          const items = Array.isArray(response) ? response : response.list ?? [];
          const candidates = items.flatMap((item) => item.id ? [{ id: String(item.id), name: String(item.title ?? item.name ?? item.id), kind: 'base' as const, score: 0 }] : []);
          const resolution = resolveCandidates(candidates, name);
          return { operation, query: name, ...resolution, identifiers: resolution.selected ? { nocodb_base_id: resolution.selected.id } : {} };
        }
        if (!base_id) throw new Error('base_id is required for table and field resolution');
        if (operation === 'table') {
          const response = await client.request<{ list?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(`/meta/bases/${base_id}/tables`);
          const items = Array.isArray(response) ? response : response.list ?? [];
          const candidates = items.flatMap((item) => item.id ? [{ id: String(item.id), name: String(item.title ?? item.name ?? item.id), kind: 'table' as const, score: 0, parent_id: base_id }] : []);
          const resolution = resolveCandidates(candidates, name);
          return { operation, query: name, ...resolution, identifiers: resolution.selected ? { nocodb_base_id: base_id, nocodb_table_id: resolution.selected.id } : { nocodb_base_id: base_id } };
        }
        if (!table_id) throw new Error('table_id is required for field resolution');
        const response = await client.request<{ fields?: Array<Record<string, unknown>> }>(`/meta/bases/${base_id}/tables/${table_id}`);
        const candidates = (response.fields ?? []).flatMap((item) => item.id ? [{ id: String(item.id), name: String(item.title ?? item.name ?? item.id), kind: 'field' as const, score: 0, parent_id: table_id }] : []);
        const resolution = resolveCandidates(candidates, name);
        return { operation, query: name, ...resolution, identifiers: resolution.selected ? { nocodb_base_id: base_id, nocodb_table_id: table_id, nocodb_field_id: resolution.selected.id } : { nocodb_base_id: base_id, nocodb_table_id: table_id } };
      }, 'resolve_metadata'),
  );
}
