import type { Hit } from './fusion.ts';
import { MAX_DOWNLOAD_BYTES, readCapped, type Page } from './fetch-guard.ts';

export const CONTEXT_DEV = 'context.dev';
const API = 'https://api.context.dev/v1';
const DEFAULT_RETRY_AFTER_MS = 60_000;
const RELEVANCE: Record<string, number> = { high: 1, medium: 0.8, low: 0.6 };

export type Outcome<T> =
  | { ok: true; value: T; credits: number }
  /** `pauseMs` is set for 402, 429 and 5xx: the backend is out of credit, rate limited or down. */
  | { ok: false; status: number; pauseMs?: number; credits: number };

/** Retry-After as delta-seconds or an HTTP date; absent or unreadable means 60 s. */
export function retryAfterMs(header: string | null, now: number): number {
  if (!header?.trim()) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, date - now);
}

export interface ContextDevConfig {
  apiKey: string;
  zdr: boolean;
  fetch: typeof fetch;
  now: () => number;
}

async function call(config: ContextDevConfig, path: string, body: object, timeoutMs: number): Promise<Outcome<any>> {
  let response: Response;
  try {
    response = await config.fetch(`${API}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, ...(config.zdr ? { zdr: 'enabled' } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, status: 0, pauseMs: 5_000, credits: 0 };
  }
  // Error bodies are never read past their credit count and never echoed.
  if (!response.ok) {
    const credits = Number(response.headers.get('x-credits-used')) || 0;
    void response.body?.cancel().catch(() => {});
    const unavailable = response.status === 402 || response.status === 429 || response.status >= 500;
    return {
      ok: false,
      status: response.status,
      credits,
      ...(unavailable ? { pauseMs: retryAfterMs(response.headers.get('retry-after'), config.now()) } : {}),
    };
  }
  const { bytes, truncated } = await readCapped(response, MAX_DOWNLOAD_BYTES + 64 * 1024);
  let parsed: any;
  try {
    if (truncated) throw new Error('too large');
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, status: 502, credits: Number(response.headers.get('x-credits-used')) || 0 };
  }
  const credits = Number(parsed?.key_metadata?.credits_consumed ?? response.headers.get('x-credits-used')) || 0;
  return { ok: true, value: parsed, credits };
}

/** Ranked hits; each is scored by reciprocal rank (k = 60) times its relevance band. */
export async function contextDevSearch(
  config: ContextDevConfig,
  query: string,
  count: number,
): Promise<Outcome<Hit[]>> {
  const outcome = await call(config, '/web/search', { query, numResults: count }, 30_000);
  if (!outcome.ok) return outcome;
  const results: any[] = Array.isArray(outcome.value?.results) ? outcome.value.results : [];
  const hits = results
    .filter((r) => typeof r?.url === 'string')
    .map((r, rank) => ({
      title: typeof r.title === 'string' ? r.title : '',
      url: r.url as string,
      snippet: typeof r.description === 'string' ? r.description : '',
      score: (RELEVANCE[r.relevance] ?? 0.6) / (60 + rank + 1),
      source: CONTEXT_DEV,
    }));
  return { ok: true, value: hits, credits: outcome.credits };
}

/** Main-content Markdown of one page, or a failure when the scrape output did not succeed. */
export async function contextDevScrape(config: ContextDevConfig, url: string): Promise<Outcome<Page>> {
  const outcome = await call(
    config,
    '/web/scrape',
    {
      url,
      formats: { markdown: true },
      sharedParams: { mainContentOnly: true },
      timeoutOpts: { milliseconds: 30_000 },
    },
    40_000,
  );
  if (!outcome.ok) return outcome;
  const markdown = outcome.value?.markdown;
  if (markdown?.success !== true || typeof markdown.data !== 'string')
    return { ok: false, status: 200, credits: outcome.credits };
  return {
    ok: true,
    credits: outcome.credits,
    value: {
      finalUrl: typeof outcome.value.url === 'string' ? outcome.value.url : url,
      title: typeof outcome.value.metadata?.title === 'string' ? outcome.value.metadata.title : '',
      text: markdown.data,
      truncated: false,
    },
  };
}
