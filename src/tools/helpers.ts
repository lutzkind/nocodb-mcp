import { NocoDBError } from '../client.js';

export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [x: string]: unknown;
}

/**
 * Wraps a successful result as an MCP tool response with pretty-printed JSON.
 */
export function ok(data: unknown): ToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Wraps an error as an MCP tool response (isError: true) so the AI can react.
 * If the error is a NocoDBError, exposes status + body for diagnostics.
 */
export function fail(err: unknown, context?: string): ToolResponse {
  const payload: Record<string, unknown> = { ok: false };
  if (context) payload.context = context;

  if (err instanceof NocoDBError) {
    payload.error = err.message;
    payload.status = err.status;
    payload.details = err.body;
  } else if (err instanceof Error) {
    payload.error = err.message;
    const errorCode = (err as Error & { code?: unknown }).code;
    if (typeof errorCode === 'string') payload.error_code = errorCode;
  } else {
    payload.error = String(err);
  }

  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Standard async wrapper: try { await fn() } catch -> fail()
 */
export async function tryTool<T>(fn: () => Promise<T>, context?: string): Promise<ToolResponse> {
  try {
    const result = await fn();
    return ok(result);
  } catch (err) {
    return fail(err, context);
  }
}

/**
 * Build a "would have done X" preview response for dry_run mode on
 * destructive operations. Use BEFORE making any API call.
 */
export function dryRunPreview(action: string, target: Record<string, unknown>): ToolResponse {
  return ok({
    dryRun: true,
    action,
    wouldAffect: target,
    note: 'No changes were made. Re-run without dry_run: true to execute.',
  });
}
