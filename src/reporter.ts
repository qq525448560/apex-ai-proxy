import { Aepipe } from 'aepipe-sdk';

const PROJECT = 'apex-ai-proxy';
const LOGSTORE_REQUESTS = 'requests';
const LOGSTORE_RAW = 'raw';
const MAX_BODY_SIZE = 512 * 1024; // 512KB cap per body before truncation

export interface ReportContext {
  requestClone: Request;
  responseClone: Response;
  durationMs: number;
  aepipeToken: string;
  baseUrl: string;
}

export function scheduleReport(ctx: ExecutionContext, data: ReportContext): void {
  ctx.waitUntil(doReport(data));
}

async function readBody(readable: Request | Response): Promise<string> {
  try {
    const buf = await readable.arrayBuffer();
    const text = new TextDecoder().decode(buf);
    return text.length > MAX_BODY_SIZE ? text.slice(0, MAX_BODY_SIZE) + '\n...[truncated]' : text;
  } catch {
    return '';
  }
}

function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    out[key] = (k === 'authorization' || k === 'x-api-key' || k === 'cf-aig-authorization')
      ? '[REDACTED]'
      : value;
  });
  return out;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key] = value; });
  return out;
}

async function doReport({ requestClone, responseClone, durationMs, aepipeToken, baseUrl }: ReportContext): Promise<void> {
  try {
    const client = new Aepipe({
      baseUrl,
      token: aepipeToken,
      // Bind fetch to globalThis: the SDK stores fetch as `this.fetchFn` and
      // calls it as a method, which loses the original receiver in Workers.
      fetch: (input, init) => globalThis.fetch(input as any, init as any),
    });

    const url = new URL(requestClone.url);
    const path = url.pathname;
    const method = requestClone.method;
    const requestHeaders = redactHeaders(requestClone.headers);

    const requestBody = await readBody(requestClone);

    // Parse model/provider/stream from request body
    let model = '';
    let provider = '';
    let isStream = false;
    const endpointType = path.includes('/messages') ? 'messages' : 'chat_completions';
    try {
      const parsed = JSON.parse(requestBody);
      const modelName: string = parsed.model || '';
      if (modelName.includes('#')) [model, provider] = modelName.split('#');
      else model = modelName;
      isStream = !!parsed.stream;
    } catch { /* non-JSON or missing fields, leave defaults */ }

    const status = responseClone.status;
    const responseHeaders = headersToRecord(responseClone.headers);
    const responseBody = await readBody(responseClone);

    const level = status >= 400 ? 'error' : 'info';
    const reqSize = new TextEncoder().encode(requestBody).length;
    const resSize = new TextEncoder().encode(responseBody).length;

    // Structured ingest — queryable via Analytics Engine SQL
    // blobs: [provider, model, endpoint_type, status, stream_mode]
    // doubles: [duration_ms, http_status, req_body_size, res_body_size]
    await client.ingest(PROJECT, LOGSTORE_REQUESTS, [{
      event: `${method} ${path}`,
      level,
      blobs: [provider, model, endpointType, String(status), isStream ? 'stream' : 'sync'],
      doubles: [durationMs, status, reqSize, resSize],
      payload: {
        request: {
          method,
          url: requestClone.url,
          headers: requestHeaders,
          body: requestBody,
        },
        response: {
          status,
          headers: responseHeaders,
          body: responseBody,
          duration_ms: durationMs,
        },
        meta: { provider, model, endpoint_type: endpointType, is_stream: isStream },
      },
    }]);

    // Raw log — full details for text search and tail
    await client.log(PROJECT, LOGSTORE_RAW, [{
      message: `${method} ${path} ${status} ${Math.round(durationMs)}ms [${provider}/${model}]`,
      level,
      provider,
      model,
      endpoint_type: endpointType,
      is_stream: isStream,
      duration_ms: durationMs,
      status,
      request_url: requestClone.url,
      request_headers: requestHeaders,
      request_body: requestBody,
      request_body_size: reqSize,
      response_headers: responseHeaders,
      response_body: responseBody,
      response_body_size: resSize,
    }]);
  } catch (err) {
    console.error('[reporter] Failed to report to aepipe:', err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : String(err));
  }
}
