import { authorize, digestList, sha256Hex } from './auth.ts';
import { CONTEXT_DEV, contextDevScrape, contextDevSearch, type ContextDevConfig, type Outcome } from './context-dev.ts';
import { capText, GuardError, parseFetchUrl, plainFetch, type Page, type Resolve } from './fetch-guard.ts';
import { canonicalUrl, fuse, type FusedResult } from './fusion.ts';
import { QUEUE_WAIT_MS, type UsageEvent } from './gate.ts';
import { isIP, isPrivateAddress } from './net.ts';
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
  /** Calls per token per minute (default 60). */
  RATE_PER_MIN?: string;
}

export interface Deps {
  fetch: typeof fetch;
  resolve: Resolve;
  now: () => number;
}

export const SEARCH_TTL_S = 24 * 60 * 60;
export const FETCH_TTL_S = 7 * 24 * 60 * 60;
export const MAX_RESULTS = 20;
const PREFIX = '/oms-search-api';
const FETCH_TIMEOUT_MS = 45_000;
const WINDOW_MS = 60_000;

/** `answered` names the backends whose output is in the answer, so a run record can say what "OMS search" was. */
interface SearchAnswer {
  results: Omit<FusedResult, 'score'>[];
  backends: Record<string, string>;
  answered: string[];
}
interface PageAnswer {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  truncated: boolean;
  backend: string;
  answered: string[];
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const retryAfter = (ms: number) => ({ 'retry-after': String(Math.max(1, Math.ceil(ms / 1000))) });
const unauthorized = () =>
  new Response('Unauthorized', { status: 401, headers: { 'content-type': 'text/plain;charset=UTF-8' } });
const describe = (error: unknown) =>
  error instanceof Error && error.name === 'TimeoutError'
    ? 'timeout'
    : error instanceof GuardError
      ? error.message.slice(0, 160)
      : 'failed';
const coolingDown = (ms: number) => `cooling down ${Math.ceil(ms / 1000)} s`;

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

/** Runs `call` in a gate slot, records its credits, and pauses context.dev for the Retry-After it asked for. */
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
    if (outcome && !outcome.ok && outcome.pauseMs !== undefined) await slots.pause(outcome.pauseMs);
    await slots.release(grant.lease, { route, token, credits });
    env.USAGE_EVENTS?.writeDataPoint({
      indexes: [token],
      blobs: [route, token, outcome?.ok ? 'ok' : 'error'],
      doubles: [credits],
    });
  }
}

function contextDev(env: Env, deps: Deps): ContextDevConfig | undefined {
  return env.CONTEXT_DEV_API_KEY
    ? { apiKey: env.CONTEXT_DEV_API_KEY, zdr: env.CONTEXT_DEV_ZDR === 'enabled', fetch: deps.fetch, now: deps.now }
    : undefined;
}

async function search(env: Env, deps: Deps, digest: string, query: string, count: number): Promise<Response> {
  // The key is a digest, so KV never holds query text.
  const key = `search:${await sha256Hex(query.toLowerCase())}`;
  const hit = await env.CACHE.get<SearchAnswer>(key, 'json');
  if (hit)
    return json(200, {
      query,
      results: hit.results.slice(0, count),
      backends: hit.backends,
      answered: hit.answered,
      cached: true,
    });
  const backends: Record<string, string> = {};
  const config = contextDev(env, deps);
  if (!config)
    return json(503, { error: 'no search backend is configured', backends, answered: [] }, retryAfter(60_000));
  const { grant, outcome } = await throughGate(env, 'search', digest, () => contextDevSearch(config, query));
  if (!('lease' in grant)) {
    backends[CONTEXT_DEV] = coolingDown(grant.retryAfterMs);
    return json(
      503,
      { error: 'every search backend is cooling down', backends, answered: [] },
      retryAfter(grant.retryAfterMs),
    );
  }
  if (!outcome?.ok) {
    backends[CONTEXT_DEV] = outcome?.error ?? 'failed';
    if (outcome?.unavailable)
      return json(
        503,
        { error: 'every search backend failed', backends, answered: [] },
        retryAfter(outcome.pauseMs ?? 5_000),
      );
    return json(502, { error: 'every search backend failed', backends, answered: [] });
  }
  backends[CONTEXT_DEV] = `ok (${outcome.value.length})`;
  const results = fuse([{ source: CONTEXT_DEV, hits: outcome.value }], MAX_RESULTS).map(({ score: _score, ...r }) => r);
  const answered = [CONTEXT_DEV];
  if (results.length)
    await env.CACHE.put(key, JSON.stringify({ results, backends, answered } satisfies SearchAnswer), {
      expirationTtl: SEARCH_TTL_S,
    });
  return json(200, { query, results: results.slice(0, count), backends, answered, cached: false });
}

async function fetchPage(env: Env, deps: Deps, digest: string, raw: string): Promise<Response> {
  let url: URL;
  try {
    url = parseFetchUrl(raw);
  } catch (error) {
    return json(400, { error: describe(error) });
  }
  // context.dev dials for us, so the host must resolve public before it gets the URL; the plain fetch re-checks every hop.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host)) {
    const addresses = await deps.resolve(host).catch(() => [] as string[]);
    if (!addresses.length) return json(400, { error: 'host does not resolve' });
    if (addresses.some(isPrivateAddress))
      return json(400, { error: 'private, loopback and link-local addresses are refused' });
  }
  const key = `page:${await sha256Hex(canonicalUrl(url.href) ?? url.href)}`;
  const hit = await env.CACHE.get<PageAnswer>(key, 'json');
  if (hit) return json(200, { ...hit, cached: true });

  const attempts: Record<string, string> = {};
  const answer = async (backend: string, page: Page) => {
    const capped = capText(page);
    const value: PageAnswer = {
      url: url.href,
      finalUrl: capped.finalUrl,
      title: capped.title,
      text: capped.text,
      truncated: capped.truncated,
      backend,
      answered: [backend],
    };
    await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: FETCH_TTL_S });
    return json(200, { ...value, attempts, cached: false });
  };

  const config = contextDev(env, deps);
  if (config) {
    const { grant, outcome } = await throughGate(env, 'fetch', digest, () => contextDevScrape(config, url.href));
    if (!('lease' in grant)) attempts[CONTEXT_DEV] = coolingDown(grant.retryAfterMs);
    else if (outcome?.ok) return answer(CONTEXT_DEV, outcome.value);
    else attempts[CONTEXT_DEV] = outcome?.error ?? 'failed';
  }
  try {
    return await answer(
      'plain',
      await plainFetch(url, deps.resolve, AbortSignal.timeout(FETCH_TIMEOUT_MS), deps.fetch),
    );
  } catch (error) {
    attempts.plain = describe(error);
  }
  return json(502, { error: 'every fetch backend failed', attempts, answered: [] });
}

/** Fixed one-minute window per token digest, per isolate. Returns 0 when allowed, else ms until the window resets. */
function rateLimiter(now: () => number): (digest: string, perMinute: number) => number {
  const windows = new Map<string, { start: number; count: number }>();
  return (digest, perMinute) => {
    const at = now();
    let window = windows.get(digest);
    if (!window || at - window.start >= WINDOW_MS) windows.set(digest, (window = { start: at, count: 0 }));
    if (window.count >= perMinute) return window.start + WINDOW_MS - at;
    window.count++;
    return 0;
  };
}

export function createApp(deps: Deps) {
  const limit = rateLimiter(deps.now);
  return async function handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || '/' : url.pathname;
    if (pathname === '/health' && request.method === 'GET') return json(200, { ok: true });
    if (pathname === '/usage') {
      if (!(await authorize(request, digestList(env.ADMIN_TOKEN_SHA256)))) return unauthorized();
      if (request.method !== 'GET') return json(405, { error: 'use GET' }, { allow: 'GET' });
      return gate(env).usage(url.searchParams.get('days'));
    }
    if (pathname !== '/search' && pathname !== '/fetch') return json(404, { error: 'not found' });
    const digest = await authorize(request, digestList(env.ACCEPTED_TOKEN_SHA256));
    if (!digest) return unauthorized();
    if (request.method !== 'POST') return json(405, { error: 'use POST' }, { allow: 'POST' });
    const wait = limit(digest, Number(env.RATE_PER_MIN) || 60);
    if (wait) return json(429, { error: 'rate limit exceeded' }, retryAfter(wait));
    let body: any;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: 'body must be JSON' });
    }
    try {
      if (pathname === '/search') {
        const query = typeof body?.query === 'string' ? body.query.replace(/\s+/g, ' ').trim() : '';
        if (!query || query.length > 400) return json(400, { error: 'query must be 1-400 characters' });
        const count = body.count ?? 10;
        if (!Number.isInteger(count) || count < 1 || count > MAX_RESULTS)
          return json(400, { error: `count must be an integer 1-${MAX_RESULTS}` });
        return await search(env, deps, digest, query, count);
      }
      if (typeof body?.url !== 'string' || body.url.length > 2048)
        return json(400, { error: 'url must be a string of at most 2048 characters' });
      return await fetchPage(env, deps, digest, body.url);
    } catch {
      return json(500, { error: 'internal error' });
    }
  };
}
