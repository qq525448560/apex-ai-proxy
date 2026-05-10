/**
 * Generic passthrough proxy: forward the request as-is to
 * `https://{X-APEX-AI-PROXY-PROVIDER}{path}`.
 *
 * The client supplies the upstream auth header (Authorization / x-api-key)
 * directly — this Worker simply strips its own X-APEX-AI-PROXY-* control
 * headers and pipes the request/response through.
 */

import { stripProxyHeaders } from './utils';

export async function handleProxyPassthrough(
  request: Request,
  body: any,
  proxyProvider: string,
): Promise<Response> {
  const url = new URL(request.url);
  const targetUrl = `https://${proxyProvider}${url.pathname}${url.search}`;

  const headers = stripProxyHeaders(request.headers);
  headers.delete('cf-aig-authorization');
  headers.delete('host');
  headers.set('Content-Type', 'application/json');

  return await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}
