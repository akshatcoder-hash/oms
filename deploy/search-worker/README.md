# oms-search-api

Hosted web search and page fetch for OMS, as a Cloudflare Worker backed by context.dev. It serves the same API as
`packages/search-service`, so the OMS client (`packages/engine/src/runtime/web.ts`) works unchanged.

Deployed as `oms-search-api` on `barestate.xyz/oms-search-api/*` only (`workers_dev` and preview URLs are off).

## API

| Route          | Auth                                | Body                   | Answer                                                                               |
| -------------- | ----------------------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `GET /health`  | none                                |                        | `{ "ok": true }`                                                                     |
| `POST /search` | `Bearer` in `ACCEPTED_TOKEN_SHA256` | `{ "query", "count" }` | `{ query, results: [{ title, url, snippet, sources }], backends, answered, cached }` |
| `POST /fetch`  | `Bearer` in `ACCEPTED_TOKEN_SHA256` | `{ "url" }`            | `{ url, finalUrl, title, text, truncated, backend, answered, attempts, cached }`     |
| `GET /usage`   | `Bearer` in `ADMIN_TOKEN_SHA256`    | `?days=1..90`          | `{ days: [{ date, requests, credits, routes, tokens }] }`                            |

- A missing or wrong token gets `401 Unauthorized` (text/plain). Tokens are compared by SHA-256 digest and never logged.
- Each token has a fixed one-minute window (`RATE_PER_MIN`, default 60, per isolate); over it the answer is `429` with `Retry-After`.
- `query` is 1-400 characters (whitespace collapsed); `count` is an integer from 1 to 20 (default 10).
- context.dev is named `contextdev` in `answered`, `backends` and `attempts` (the OMS client keeps only `[a-z]` names), and the plain fetch is `plain`.
- `/search`: context.dev web search, merged with reciprocal rank fusion (k = 60), deduplicated by canonical URL (no scheme,
  `www.`, port, fragment or tracking parameters; one form per Stack Exchange question), Solana sources scored x1.2.
  The top 20 are cached in KV for 24 h. When context.dev is unavailable it answers `503` with `Retry-After`.
- `/fetch`: context.dev scrape (Markdown, main content only), then a plain fetch. A 402, 429 or 5xx from context.dev
  moves on to the plain fetch. `attempts` maps each backend that failed to a short reason. Cached in KV for 7 days.
  - HTTPS only, no credentials in the URL, no hosts that are or resolve to private, loopback, link-local, CGNAT or
    metadata addresses. Every redirect of the plain fetch is checked again.
  - The download stops at 2 MB and the text at 200,000 characters (`truncated: true`).
- A 402, a 429, or any response with `Retry-After` pauses context.dev until the time it asked for (60 s if absent).
  Upstream error bodies are never returned.

## Concurrency and usage

A Durable Object (`ContextDevGate`) holds at most 5 context.dev calls in flight. Extra calls wait up to 4 s, then get
`503` with `Retry-After`. It also keeps daily credit totals (`key_metadata.credits_consumed`) per route and per token
digest prefix, which `/usage` returns. Each call is also written to the Analytics Engine dataset `oms_search_usage`.
Query text is never recorded.

## Configuration

| Name                    | Kind   | Meaning                                                                |
| ----------------------- | ------ | ---------------------------------------------------------------------- |
| `CONTEXT_DEV_API_KEY`   | secret | context.dev API key                                                    |
| `ACCEPTED_TOKEN_SHA256` | secret | comma-separated SHA-256 hex digests of accepted bearer tokens          |
| `ADMIN_TOKEN_SHA256`    | secret | comma-separated SHA-256 hex digests of tokens allowed to read `/usage` |
| `CONTEXT_DEV_ZDR`       | var    | `enabled` sends `zdr: "enabled"` on every context.dev request          |

## Develop

```sh
npm ci
npm run typecheck && npm run format:check && npm test
```

## Deploy

```sh
npx wrangler kv namespace create oms-search-cache # only for a new account; put the id in wrangler.jsonc
printf %s "$CONTEXT_DEV_API_KEY" | npx wrangler secret put CONTEXT_DEV_API_KEY
printf %s "<bench digest>,<gateway digest>" | npx wrangler secret put ACCEPTED_TOKEN_SHA256
printf %s "<admin digest>" | npx wrangler secret put ADMIN_TOKEN_SHA256
npx wrangler deploy
```

A digest is `printf %s "$TOKEN" | sha256sum | cut -d' ' -f1`.
