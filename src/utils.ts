/**
 * Utility functions for the AI service aggregator
 */

import type { ErrorResponse, AzureConfig } from './types';

export function getEndpoint(env: Env) {
  return `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.GATEWAY_ID}`;
}

/**
 * Verify API key from the Authorization header
 */
export function verifyApiKey(request: Request, apiKey?: string): boolean {
  // If no API key are configured, skip authentication
  if (!apiKey) return true;
  const [_authorization, _xApiKey] = ['Authorization', 'x-api-key'].map((header) => request.headers.get(header));

  const authHeader = _authorization || _xApiKey;
  if (!authHeader) return false;

  if (_authorization) {
    const match = _authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    return apiKey === match[1];
  }
  if (_xApiKey) {
    return apiKey === _xApiKey;
  }

  return false;
}

const OPENAI_ENDPOINT = ['cerebras', 'deepseek', 'groq', 'openai', 'perplexity-ai', 'compat']; // compat => google-vertex-ai
const OPENAI_V1_ENDPOINT = ['grok', 'mistral', 'openrouter'];
const SUPPORTED_ENDPOINTS = ['azure-openai', 'anthropic', 'google-ai-studio', 'cohere', ...OPENAI_ENDPOINT, ...OPENAI_V1_ENDPOINT];
const SUPPORTED_UNIFIED_API_ENDPOINTS = [
  'anthropic',
  'openai',
  'groq',
  'mistral',
  'cohere',
  'google-ai-studio',
  'grok',
  'deepseek',
  'cerebras',
];

export function isSupportedUnifiedApiEndpoint(provider: string): boolean {
  return SUPPORTED_UNIFIED_API_ENDPOINTS.includes(provider);
}

export const PROXY_HEADER_PREFIX = 'x-apex-ai-proxy-';
export const PROXY_HEADER_PROVIDER = 'X-APEX-AI-PROXY-PROVIDER';
export const PROXY_HEADER_TYPE = 'X-APEX-AI-PROXY-TYPE';
export const PROXY_HEADER_MAPPING = 'X-APEX-AI-PROXY-MAPPING';

/**
 * Parse `from1#to1,from2#to2` into Map<from, to>.
 */
export function parseModelMapping(headerValue: string): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const entry of headerValue.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('#');
    if (idx < 0) continue;
    const from = trimmed.slice(0, idx).trim();
    const to = trimmed.slice(idx + 1).trim();
    if (from && to) mapping.set(from, to);
  }
  return mapping;
}

/**
 * Mutate body.model in place if a mapping entry matches. The model field may be
 * `name` (passthrough mode) or `name#provider` (CF gateway mode); only the bare
 * name is matched against the mapping, with any `#provider` suffix preserved.
 */
export function applyModelMapping(body: any, mapping: Map<string, string>): void {
  if (!body || typeof body !== 'object' || typeof body.model !== 'string' || mapping.size === 0) return;
  const modelName: string = body.model;
  const sepIdx = modelName.indexOf('#');
  const base = sepIdx >= 0 ? modelName.slice(0, sepIdx) : modelName;
  const suffix = sepIdx >= 0 ? modelName.slice(sepIdx) : '';
  const mapped = mapping.get(base);
  if (mapped) {
    body.model = mapped + suffix;
  }
}

/**
 * Return a fresh Headers without any X-APEX-AI-PROXY-* entries.
 */
export function stripProxyHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, key) => {
    if (!key.toLowerCase().startsWith(PROXY_HEADER_PREFIX)) {
      out.set(key, value);
    }
  });
  return out;
}

export function urlBuilder(endpoint: string, provider: string, azureConfig?: AzureConfig) {
  const urlFragment = [endpoint];
  if (!SUPPORTED_ENDPOINTS.includes(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  if (isSupportedUnifiedApiEndpoint(provider)) {
    return `${endpoint}/compat/chat/completions`;
  }

  urlFragment.push(provider);

  if (provider === 'anthropic') {
    urlFragment.push('v1/messages');
    return urlFragment.join('/');
  }

  if (provider === 'azure-openai') {
    if (!azureConfig || !azureConfig.resource || !azureConfig.deployment) {
      throw new Error(`Missing Azure config for provider: ${provider}`);
    }
    urlFragment.push(azureConfig.resource);
    urlFragment.push(azureConfig.deployment);
  }

  if (OPENAI_V1_ENDPOINT.includes(provider)) {
    urlFragment.push('v1');
  }

  urlFragment.push(
    `chat/completions${provider === 'azure-openai' ? `?api-version=${azureConfig?.apiVersion ?? '2025-04-01-preview'}` : ''}`,
  );
  return urlFragment.join('/');
}

/**
 * Format error response in OpenAI compatible format
 */
export function formatErrorResponse(message: string, type: string = 'internal_error', status: number = 500, other?: Record<string, any>): Response {
  const errorResponse: ErrorResponse = {
    error: { message, type },
		...other,
  };

  return corsWrapper(
    new Response(JSON.stringify(errorResponse), {
      status,
      headers: {
        'Content-Type': 'application/json',
      },
    }),
  );
}

export function corsWrapper(response: Response): Response {
  const corsHeaders: { [key: string]: string } = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  // Build a fresh Headers because responses from `fetch()` have immutable headers.
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * Create a logger instance with Cloudflare-optimized formatting
 */
export function createLogger(request: Request): Logger {
  const { cf } = request;
  const { city, country, timezone } = cf || {};

  const baseInfo = {
    location: city && country ? `${city}, ${country}` : 'Unknown',
    timezone: timezone || 'UTC',
    method: request.method,
    url: new URL(request.url).pathname,
    userAgent: request.headers.get('User-Agent')?.slice(0, 100) || 'Unknown',
    timestamp: new Date()
      .toLocaleString('zh-CN', {
        timeZone: 'Asia/Singapore',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
      .replace(/\//g, '-'),
  };

  class CFLogger {
    private readonly context: typeof baseInfo;

    constructor(context: typeof baseInfo) {
      this.context = context;
    }

    info(message: string, data?: Record<string, any>) {
      console.log(
        JSON.stringify({
          level: 'INFO',
          ...this.context,
          message,
          ...data,
        }),
      );
    }

    error(message: string, error?: Error | Record<string, any>) {
      console.error(
        JSON.stringify({
          level: 'ERROR',
          ...this.context,
          message,
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : error,
        }),
      );
    }

    warn(message: string, data?: Record<string, any>) {
      console.warn(
        JSON.stringify({
          level: 'WARN',
          ...this.context,
          message,
          ...data,
        }),
      );
    }
  }

  return new CFLogger(baseInfo);
}
