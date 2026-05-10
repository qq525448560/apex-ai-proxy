# Apex AI Proxy

Cloudflare Worker that fronts LLM requests with three behaviors:

1. **CF AI Gateway routing** — `model#provider` format, traffic flows through Cloudflare AI Gateway for BYOK, caching, and rate limits.
2. **Passthrough** — header-driven direct forwarding to any upstream provider.
3. **Model mapping** — header-driven rewrite of the `model` field; works in both modes above.

Plus optional async observability via [aepipe](https://github.com/loadchange/aepipe).

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/loadchange/apex-ai-proxy)

## Quick start

```bash
git clone https://github.com/loadchange/apex-ai-proxy.git
cd apex-ai-proxy
pnpm install

cp wrangler.example.jsonc wrangler.jsonc
# Fill in ACCOUNT_ID, GATEWAY_ID, store_id, AEPIPE_BASE_URL
```

Create the secrets in Cloudflare dashboard → **Secrets Store**:

| Secret | Purpose |
|--------|---------|
| `GatewayToken` | CF AI Gateway authentication token |
| `AepipeToken`  | aepipe `ADMIN_TOKEN` (skip if you don't need logging) |

Deploy:

```bash
pnpm run deploy
```

## Routing modes

### 1. CF AI Gateway

Standard mode. Authenticate with the gateway token; model uses `<model>#<provider>`.

OpenAI style:

```bash
curl -X POST https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5#openai",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Anthropic style:

```bash
curl -X POST https://your-worker.workers.dev/v1/messages \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4.7#anthropic",
    "max_tokens": 1000,
    "messages": [{"role":"user","content":"hi"}]
  }'
```

### 2. Passthrough

Direct forward to any upstream provider. The client supplies the upstream API key in `Authorization` / `x-api-key`; the Worker does **no** token validation in this mode.

| Header | Value |
|--------|-------|
| `X-APEX-AI-PROXY-PROVIDER` | upstream host + base path, e.g. `zenmux.ai/api/anthropic` |
| `X-APEX-AI-PROXY-TYPE`     | `anthropic` or `chat-completions` (informational) |

The Worker forwards `POST {path}` to `https://{PROVIDER}{path}`. All `X-APEX-AI-PROXY-*` headers are stripped before forwarding.

OpenAI style → forwards to `https://zenmux.ai/api/v1/chat/completions`:

```bash
curl -X POST https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $UPSTREAM_KEY" \
  -H "X-APEX-AI-PROXY-PROVIDER: zenmux.ai/api" \
  -H "X-APEX-AI-PROXY-TYPE: chat-completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Anthropic style → forwards to `https://zenmux.ai/api/anthropic/v1/messages`:

```bash
curl -X POST https://your-worker.workers.dev/v1/messages \
  -H "x-api-key: $UPSTREAM_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "X-APEX-AI-PROXY-PROVIDER: zenmux.ai/api/anthropic" \
  -H "X-APEX-AI-PROXY-TYPE: anthropic" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1000,
    "messages": [{"role":"user","content":"hi"}]
  }'
```

### 3. Model mapping (both modes)

Rewrite the request body's `model` field on the fly:

```
X-APEX-AI-PROXY-MAPPING: claude-opus-4.7#mimo-v2.5-pro,claude-sonnet-4-6#mimo-v2.5
```

Format: `from1#to1,from2#to2`. Matching is on the bare model name; any `#provider` suffix is preserved.

Use case: an SDK hard-codes a model name (`claude-opus-4.7`) but you want it routed to a different upstream model (`mimo-v2.5-pro`) without touching client code.

## Observability (aepipe)

When `AEPIPE_BASE_URL` and the `AepipeToken` secret are set, every request is reported asynchronously (via `ctx.waitUntil`) to two logstores:

| Logstore | Backend | Content |
|----------|---------|---------|
| `apex-ai-proxy/requests` | Analytics Engine | Structured: provider, model, status, duration, sizes — queryable via SQL |
| `apex-ai-proxy/raw`      | Workers Logs     | Full text: headers, request/response bodies |

Auth headers (`Authorization`, `x-api-key`, `cf-aig-authorization`) are redacted. Reporting failures don't affect the response — they log to console and continue. If `AepipeToken` is empty, logging is silently skipped.

## Supported providers (CF Gateway mode)

Anthropic · OpenAI · Google AI Studio · Groq · Mistral · Grok · DeepSeek · Cerebras · Cohere · Perplexity · Azure OpenAI · OpenRouter

Model format: `<model>#<provider>`.

```
gpt-5.5#openai
gpt-5.3-codex#openai
claude-opus-4.7#anthropic
claude-sonnet-4-6#anthropic
deepseek-v4-pro#deepseek
deepseek-v4-flash#deepseek
gemini-2.0-flash#google-ai-studio
mistral-large-latest#mistral
```

## Client integration

Use any OpenAI- or Anthropic-compatible SDK and point its base URL at the Worker.

```python
from openai import OpenAI

client = OpenAI(
    api_key="<gateway-token>",
    base_url="https://your-worker.workers.dev/v1",
)
resp = client.chat.completions.create(
    model="claude-opus-4.7#anthropic",
    messages=[{"role": "user", "content": "hello"}],
)
```

```python
from anthropic import Anthropic

client = Anthropic(
    api_key="<gateway-token>",
    base_url="https://your-worker.workers.dev",
)
resp = client.messages.create(
    model="claude-sonnet-4-6#anthropic",
    max_tokens=1000,
    messages=[{"role": "user", "content": "hello"}],
)
```

## Configuration reference

`wrangler.jsonc` (gitignored — see `wrangler.example.jsonc`):

| Var | Description |
|-----|-------------|
| `ACCOUNT_ID`        | Cloudflare account ID |
| `GATEWAY_ID`        | AI Gateway ID |
| `AEPIPE_BASE_URL`   | aepipe Worker URL (logging) |
| `AZURE_RESOURCE`    | Azure OpenAI resource (optional) |
| `AZURE_API_VERSION` | Azure OpenAI API version (optional) |

`secrets_store_secrets` bindings:

| Binding | Required |
|---------|----------|
| `GatewayToken` | Yes (for CF Gateway mode) |
| `AepipeToken`  | No (logging optional) |

## Local development

```bash
cp wrangler.example.jsonc wrangler.jsonc  # fill IDs
# .dev.vars (gitignored) — local secret values:
#   GatewayToken=...
#   AepipeToken=...
pnpm run dev
# Worker listens on http://localhost:8787
```

## Architecture

```
Client ──┬─► Worker ──► CF AI Gateway ──► Provider     (mode 1)
         │
         └─► Worker ──► https://{PROVIDER}{path}        (mode 2)

         Worker ─async─► aepipe (Analytics Engine + Workers Logs)
```

## License

MIT
