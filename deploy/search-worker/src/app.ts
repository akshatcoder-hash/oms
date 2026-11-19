import { authorize, digestList, sha256Hex } from './auth.ts';
import { CONTEXT_DEV, contextDevScrape, contextDevSearch, type ContextDevConfig, type Outcome } from './context-dev.ts';
import {
  capText,
  GuardError,
  assertPublicHost,
  parseFetchUrl,
  plainFetch,
  type Page,
  type Resolve,
} from './fetch-guard.ts';
import { fuse } from './fusion.ts';
import { QUEUE_WAIT_MS, type UsageEvent } from './gate.ts';
import type { Grant } from './semaphore.ts';

export interface Env {
  CACHE: KVNamespace;
  GATE: DurableObjectNamespace;
  USAGE_EVENTS?: AnalyticsEngineDataset;
  CONTEXT_DEV_API_KEY?: string;
  ACCEPTED_TOKEN_SHA256?: string;
  ADMIN_TOKEN_SHA256?: string;
  /** "enabled" sends zdr: "enabled" on every context.dev request. */
  CONTEXT_DEV_ZDR?: string;
}

export interface Deps {
  fetch: typeof fetch;
  resolve: Resolve;
  now: () => number;
}

export const SEARCH_TTL_S = 24 * 60 * 60;
export const FETCH_TTL_S = 7 * 24 * 60 * 60;
const PREFIX = '/oms-search-api';
const MAX_QUERY_CHARS = 1_000;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
const unauthorized = () => text('unauthorized\n', 401, { 'www-authenticate': 'Bearer' });
const retryAfter = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));

type BackendState = 'ok' | 'error' | 'rate_limited' | 'busy' | 'paused' | 'skipped';

function gate(env: Env) {
  const stub = env.GATE.get(env.GATE.idFromName(CONTEXT_DEV));
  const post = (path: string, body: unknown) =>
    stub.fetch(`https://gate${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
  return {
    acquire: () => post('/acquire', { waitMs: QUEUE_WAIT_MS }) as Promise<Grant>,
    release: (lease: string, usage?: UsageEvent) => post('/release', { lease, usage }),
    pause: (ms: number) => post('/pause', { ms }),
    usage: (days: string | null) => stub.fetch(`https://gate/usage?days=${encodeURIComponent(days ?? '')}`),
  };
}

/** Runs `call` inside a gate slot, records its credits, and pauses the backend on 402/429/5xx. */
async function throughGate<T>(
  env: Env,
  route: UsageEvent['route'],
  digest: string,
  call: () => Promise<Outcome<T>>,
): Promise<{ grant: Grant; outcome?: Outcome<T> }> {
  const slots = gate(env);
  const grant = await slots.acquire();
  if (!('lease' in grant)) return { grant };
  let outcome: Outcome<T> | undefined;
  try {
    outcome = await call();
    return { grant, outcome };
  } finally {
    const credits = outcome?.credits ?? 0;
    const token = digest.slice(0, 16);
    if (!outcome?.ok && outcome?.pauseMs) await slots.pause(outcome.pauseMs);
    await slots.release(grant.lease, { route, token, credits });
    env.USAGE_EVENTS?.writeDataPoint({
      indexes: [token],
      blobs: [route, token, outcome?.ok ? 'ok' : 'error'],
      doubles: [credits],
    });
  }
}

const stateOf = (grant: Grant, outcome?: Outcome<unknown>): BackendState =>
  !('lease' in grant)
    ? grant.reason
    : outcome?.ok
      ? 'ok'
      : outcome && 'status' in outcome && outcome.status === 429
        ? 'rate_limited'
        : 'error';

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  if (Number(request.headers.get('content-length') ?? 0) > 64 * 1024) return undefined;
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function contextDev(env: Env, deps: Deps): ContextDevConfig | undefined {
  return env.CONTEXT_DEV_API_KEY
    ? { apiKey: env.CONTEXT_DEV_API_KEY, zdr: env.CONTEXT_DEV_ZDR === 'enabled', fetch: deps.fetch, now: deps.now }
    : undefined;
}

async function search(request: Request, env: Env, deps: Deps, digest: string): Promise<Response> {
  const body = await readJson(request);
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  const count = body?.count === undefined ? 10 : body.count;
  if (!query || query.length > MAX_QUERY_CHARS) return json({ error: 'query must be a non-empty string' }, 400);
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 20)
    return json({ error: 'count must be an integer from 1 to 20' }, 400);

  const key = `search:v1:${await sha256Hex(JSON.stringify([query, count]))}`;
  const hit = await env.CACHE.get<Record<string, unknown>>(key, 'json');
  if (hit) return json({ ...hit, cached: true });

  const config = contextDev(env, deps);
  if (!config)
    return json({ error: 'search is unavailable', backends: { [CONTEXT_DEV]: 'error' } }, 503, { 'retry-after': '60' });
  const { grant, outcome } = await throughGate(env, 'search', digest, () => contextDevSearch(config, query, count));
  const backends = { [CONTEXT_DEV]: stateOf(grant, outcome) };
  if (!outcome?.ok) {
    const wait = !('lease' in grant)
      ? grant.retryAfterMs
      : (outcome && 'pauseMs' in outcome && outcome.pauseMs) || 60_000;
    return json({ error: 'search is unavailable', backends }, 503, { 'retry-after': retryAfter(wait) });
  }
  const answer = { query, results: fuse(outcome.value, count), backends, answered: [CONTEXT_DEV] };
  await env.CACHE.put(key, JSON.stringify(answer), { expirationTtl: SEARCH_TTL_S });
  return json({ ...answer, cached: false });
}

async function fetchPage(request: Request, env: Env, deps: Deps, digest: string): Promise<Response> {
  const body = await readJson(request);
  let url: URL;
  try {
    url = parseFetchUrl(body?.url);
    await assertPublicHost(url, deps.resolve);
  } catch (error) {
    return json({ error: error instanceof GuardError ? error.message : 'url refused' }, 400);
  }
  const key = `fetch:v1:${await sha256Hex(url.href)}`;
  const hit = await env.CACHE.get<Record<string, unknown>>(key, 'json');
  if (hit) return json({ ...hit, cached: true });

  const attempts: { backend: string; state: BackendState }[] = [];
  let page: Page | undefined;
  let backend = '';
  const config = contextDev(env, deps);
  if (config) {
    const { grant, outcome } = await throughGate(env, 'fetch', digest, () => contextDevScrape(config, url.href));
    attempts.push({ backend: CONTEXT_DEV, state: stateOf(grant, outcome) });
    if (outcome?.ok) {
      page = capText(outcome.value);
      backend = CONTEXT_DEV;
    }
  } else attempts.push({ backend: CONTEXT_DEV, state: 'skipped' });

  if (!page) {
    try {
      page = await plainFetch(url, deps.resolve, AbortSignal.timeout(20_000), deps.fetch);
      backend = 'plain';
      attempts.push({ backend, state: 'ok' });
    } catch (error) {
      attempts.push({ backend: 'plain', state: 'error' });
      const refused = error instanceof GuardError && /refused|https/.test(error.message);
      return json(
        { error: error instanceof GuardError ? error.message : 'the page could not be fetched', attempts },
        refused ? 400 : 502,
      );
    }
  }
  const answer = {
    url: url.href,
    finalUrl: page.finalUrl,
    title: page.title,
    text: page.text,
    truncated: page.truncated,
    backend,
    answered: [backend],
    attempts,
  };
  await env.CACHE.put(key, JSON.stringify(answer), { expirationTtl: FETCH_TTL_S });
  return json({ ...answer, cached: false });
}

export function createApp(deps: Deps) {
  return async function handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || '/' : url.pathname;
    if (path === '/health')
      return request.method === 'GET' || request.method === 'HEAD'
        ? json({ status: 'ok' })
        : text('method not allowed\n', 405);
    if (path === '/usage') {
      if (!(await authorize(request, digestList(env.ADMIN_TOKEN_SHA256)))) return unauthorized();
      if (request.method !== 'GET') return text('method not allowed\n', 405);
      return gate(env).usage(url.searchParams.get('days'));
    }
    const digest = await authorize(request, digestList(env.ACCEPTED_TOKEN_SHA256));
    if (!digest) return unauthorized();
    if (path !== '/search' && path !== '/fetch') return text('not found\n', 404);
    if (request.method !== 'POST') return text('method not allowed\n', 405);
    try {
      return path === '/search'
        ? await search(request, env, deps, digest)
        : await fetchPage(request, env, deps, digest);
    } catch {
      return json({ error: 'internal error' }, 500);
    }
  };
}
