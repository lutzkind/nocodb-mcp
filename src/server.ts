import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NocoDBClient } from './client.js';
import type { NocoDBConfig } from './config.js';
import { Logger } from './logger.js';
import { registerAttachmentTools } from './tools/attachments.js';
import { registerBaseTools } from './tools/bases.js';
import { registerCommentTools } from './tools/comments.js';
import { registerDashboardTools } from './tools/dashboards.js';
import { registerDocsTools } from './tools/docs.js';
import { registerFieldTools } from './tools/fields.js';
import { registerFilterTools } from './tools/filters.js';
import { registerImportExportTools } from './tools/import-export.js';
import { registerMetadataResolutionTools } from './tools/metadata-resolution.js';
import { registerLinkTools } from './tools/links.js';
import { registerPingTool } from './tools/ping.js';
import { registerRecordTools } from './tools/records.js';
import { registerSchemaOpsTools } from './tools/schema-ops.js';
import { registerScriptTools } from './tools/scripts.js';
import { registerSortTools } from './tools/sorts.js';
import { registerTableTools } from './tools/tables.js';
import { registerViewTools } from './tools/views.js';
import { registerWebhookTools } from './tools/webhooks.js';
import { registerWorkflowTools } from './tools/workflows.js';
import { registerRecordHistoryTools } from './tools/history.js';
import { registerWorkspaceTools } from './tools/workspaces.js';
import { registerSchemaWriteTool } from './tools/schema-write.js';

export const SERVER_VERSION = '1.0.5';

export function createServer(config: NocoDBConfig): McpServer {
  const client = new NocoDBClient(config);
  const log = new Logger(config.logLevel);

  const server = new McpServer({
    name: 'nocodb-mcp',
    version: SERVER_VERSION,
  });

  registerPingTool(server, client, config);
  registerWorkspaceTools(server, client);
  registerBaseTools(server, client);
  registerMetadataResolutionTools(server, client);
  registerTableTools(server, client);
  registerFieldTools(server, client);
  registerSchemaWriteTool(server, client);
  registerRecordTools(server, client);
  registerViewTools(server, client);
  registerFilterTools(server, client);
  registerSortTools(server, client);
  registerWebhookTools(server, client);
  registerLinkTools(server, client);
  registerAttachmentTools(server, client, config);
  registerImportExportTools(server, client);
  registerSchemaOpsTools(server, client);
  registerCommentTools(server, client);
  registerRecordHistoryTools(server, client);
  registerScriptTools(server, client);
  registerDashboardTools(server, client);
  registerWorkflowTools(server, client);
  registerDocsTools(server, client);

  log.info('nocodb-mcp tools registered', {
    target: config.baseUrl,
    version: SERVER_VERSION,
    groups: [
      'ping',
      'workspaces',
      'bases',
      'tables',
      'fields',
      'records',
      'views',
      'filters',
      'sorts',
      'webhooks',
      'links',
      'attachments',
      'import-export',
      'schema-ops',
      'comments',
      'scripts',
      'dashboards',
      'workflows',
      'docs',
    ],
  });

  return server;
}
