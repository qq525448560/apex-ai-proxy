/**
 * AI Service Aggregator Worker
 *
 * Two routing modes:
 *   1. Passthrough — when X-APEX-AI-PROXY-PROVIDER is set, forward directly to
 *      `https://{PROVIDER}{path}`. Client provides upstream auth.
 *   2. CF AI Gateway — legacy `model#provider` routing through Cloudflare AI
 *      Gateway, authenticated by GatewayToken.
 *
 * X-APEX-AI-PROXY-MAPPING applies in both modes: rewrites the body's `model`
 * field. All X-APEX-AI-PROXY-* headers are stripped before forwarding.
 */
import { AzureConfig } from './types';
import {
  getEndpoint,
  verifyApiKey,
  formatErrorResponse,
  corsWrapper,
  createLogger,
  parseModelMapping,
  applyModelMapping,
  stripProxyHeaders,
  PROXY_HEADER_PROVIDER,
  PROXY_HEADER_MAPPING,
} from './utils';
import { handleChatCompletionsRequest } from './handlers';
import { handleAnthropicMessagesRequest } from './anthropicHandlers';
import { handleProxyPassthrough } from './proxyHandler';
import { scheduleReport } from './reporter';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return corsWrapper(new Response(null, { status: 204 }));
    }
    if (request.method !== 'POST') {
      return formatErrorResponse('Method not allowed', 'method_not_allowed', 405);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.includes('/messages') && !path.includes('/chat/completions')) {
      return formatErrorResponse('Not found', 'not_found', 404);
    }

    const aepipeToken: string = (await env.AepipeToken.get()) ?? '';
    const aepipeBaseUrl: string = env.AEPIPE_BASE_URL;

    const proxyProvider = request.headers.get(PROXY_HEADER_PROVIDER);
    const proxyMapping = request.headers.get(PROXY_HEADER_MAPPING);

    // Clone original request (with X-APEX-AI-PROXY-* headers and pre-mapping
    // body) so the reporter sees what the client actually sent.
    const requestClone = request.clone();
    const startTime = Date.now();

    let body: any;
    try {
      body = await request.json();
    } catch {
      return formatErrorResponse('Invalid request body', 'invalid_request_error', 400);
    }

    if (proxyMapping) {
      applyModelMapping(body, parseModelMapping(proxyMapping));
    }

    const reportIfNeeded = (finalResponse: Response) => {
      if (aepipeToken) {
        scheduleReport(ctx, {
          requestClone,
          responseClone: finalResponse.clone(),
          durationMs: Date.now() - startTime,
          aepipeToken,
          baseUrl: aepipeBaseUrl,
        });
      }
    };

    // Passthrough mode — no Worker-level auth; upstream provider authenticates.
    if (proxyProvider) {
      let response: Response;
      try {
        response = await handleProxyPassthrough(request, body, proxyProvider);
      } catch (error) {
        response = formatErrorResponse(
          `Passthrough failed: ${error instanceof Error ? error.message : String(error)}`,
          'connection_error',
          503,
        );
      }
      const finalResponse = corsWrapper(response);
      reportIfNeeded(finalResponse);
      return finalResponse;
    }

    // CF AI Gateway mode
    const apiKey = await env.GatewayToken.get();
    if (!verifyApiKey(request, apiKey)) {
      return formatErrorResponse('Invalid API key', 'unauthorized', 401);
    }

    const logger = createLogger(request);
    const endpoint = getEndpoint(env);
    const azureConfig: AzureConfig = {
      resource: env.AZURE_RESOURCE,
      apiVersion: env.AZURE_API_VERSION,
    };

    // Rebuild request with proxy headers stripped and (possibly mapped) body.
    const cleanedHeaders = stripProxyHeaders(request.headers);
    const cleanedRequest = new Request(request.url, {
      method: 'POST',
      headers: cleanedHeaders,
      body: JSON.stringify(body),
    });

    try {
      let response: Response;
      if (path.includes('/messages')) {
        response = await handleAnthropicMessagesRequest(cleanedRequest, logger, endpoint, apiKey, azureConfig);
      } else {
        response = await handleChatCompletionsRequest(cleanedRequest, logger, endpoint, apiKey, azureConfig);
      }
      const finalResponse = corsWrapper(response);
      reportIfNeeded(finalResponse);
      return finalResponse;
    } catch (error) {
      console.error('Unhandled error:', error);
      return formatErrorResponse(
        `Unhandled error: ${error instanceof Error ? error.message : String(error)}`,
        'internal_error',
        500,
      );
    }
  },
};
