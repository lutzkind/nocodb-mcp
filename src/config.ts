export interface NocoDBConfig {
  baseUrl: string;
  apiToken: string;
  defaultBaseId?: string;
  disposableBaseIds?: string[];
  timeoutMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(): NocoDBConfig {
  const baseUrl = process.env.NOCODB_BASE_URL;
  const apiToken = process.env.NOCODB_API_TOKEN;

  if (!baseUrl) {
    throw new Error('NOCODB_BASE_URL is required (e.g. https://data.example.com)');
  }
  if (!apiToken) {
    throw new Error('NOCODB_API_TOKEN is required (generate at NocoDB → Account → Tokens)');
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiToken,
    defaultBaseId: process.env.NOCODB_DEFAULT_BASE_ID || undefined,
    disposableBaseIds: (process.env.NOCODB_DISPOSABLE_BASE_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    timeoutMs: Number(process.env.NOCODB_TIMEOUT_MS) || 30_000,
    logLevel: (process.env.NOCODB_LOG_LEVEL as NocoDBConfig['logLevel']) || 'info',
  };
}
