# oms-search-api

Hosted web search and page fetch for OMS, as a Cloudflare Worker backed by context.dev. It serves the same API as
`packages/search-service`, so the OMS client (`packages/engine/src/runtime/web.ts`) works unchanged.

Deployed as `oms-search-api` on `barestate.xyz/oms-search-api/*` only (`workers_dev` and preview URLs are off).

## API

| Route          | Auth                                | Body                   | Answer                                                                               |
| -------------- | ----------------------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `GET /health`  | none                                |                        | `{ "status": "ok" }`                                                                 |
| `POST /search` | `Bearer` in `ACCEPTED_TOKEN_SHA256` | `{ "query", "count" }` | `{ query, results: [{ title, url, snippet, sources }], backends, answered, cached }` |
| `POST /fetch`  | `Bearer` in `ACCEPTED_TOKEN_SHA256` | `{ "url" }`            | `{ url, finalUrl, title, text, truncated, backend, answered, attempts, cached }`     |
| `GET /usage`   | `Bearer` in `ADMIN_TOKEN_SHA256`    | `?days=1..90`          | `{ days: [{ date, requests, credits, routes, tokens }] }`                            |

- A missing or wrong token gets `401` `text/plain`. Tokens are compared by SHA-256 digest and never logged.
- `count` is an integer from 1 to 20 (default 10).
- `/search`: context.dev web search, deduplicated by canonical URL, Solana sources scored x1.2, cached in KV for 24 h.
  When context.dev is unavailable it answers `503` with `Retry-After`.
- `/fetch`: context.dev scrape (Markdown, main content only), then a plain fetch. A 402, 429 or 5xx from context.dev
  moves on to the plain fetch. Cached in KV for 7 days.
  - HTTPS only, no credentials in the URL, no hosts that are or resolve to private, loopback, link-local, CGNAT or
    metadata addresses. Every redirect of the plain fetch is checked again.
  - The download stops at 2 MB and the text at 200,000 characters (`truncated: true`).
- A 402, 429 or 5xx pauses context.dev for its `Retry-After` (60 s if absent). Upstream error bodies are never returned.

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
