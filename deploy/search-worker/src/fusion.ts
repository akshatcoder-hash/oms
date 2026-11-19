export interface Hit {
  title: string;
  url: string;
  snippet: string;
  /** Higher is better; backends score their own hits before fusion. */
  score: number;
  source: string;
  engines?: string[];
}

export interface Result {
  title: string;
  url: string;
  snippet: string;
  sources: string[];
  engines?: string[];
}

const TRACKING = /^(utm_[a-z]+|gclid|fbclid|dclid|msclkid|mc_cid|mc_eid|ref_src|igshid|_hsenc|_hsmi|yclid)$/i;

/** One key per page: lowercase scheme and host, no www., default port, fragment, tracking params or trailing slash. */
export function canonicalUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  const params = [...url.searchParams]
    .filter(([name]) => !TRACKING.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  let path = url.pathname.replace(/\/{2,}/g, '/');
  path = path.replace(/\/(index\.html?)?$/i, '') || '';
  return `${host}${url.port ? `:${url.port}` : ''}${path}${query}`;
}

const SOLANA_HOSTS = ['solana.com', 'anchor-lang.com', 'solana.stackexchange.com', 'surfpool.run', 'helius.dev'];

/** Solana sources: solana.com, Anchor, Solana StackExchange, github.com/solana-*, Surfpool and Helius docs. */
export function isSolanaSource(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.toLowerCase();
  if (host === 'github.com')
    return (
      /^\/(solana-[^/]+|solana-labs|solana-foundation|solana-developers)(\/|$)/.test(path) ||
      /^\/[^/]+\/surfpool(\/|$)/.test(path)
    );
  if (host.includes('anchor-lang')) return true;
  if (host.includes('surfpool')) return true;
  if (host === 'helius.dev' || host.endsWith('.helius.dev'))
    return host.startsWith('docs.') || path.startsWith('/docs');
  return SOLANA_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export const SOLANA_BOOST = 1.2;

/** Dedupes hits by canonical URL (first title/snippet kept, scores and sources merged), boosts Solana sources, ranks. */
export function fuse(hits: Hit[], count: number): Result[] {
  const merged = new Map<string, Hit & { sources: Set<string>; engineSet: Set<string> }>();
  for (const hit of hits) {
    const key = canonicalUrl(hit.url);
    if (!key) continue;
    const seen = merged.get(key);
    if (seen) {
      seen.score += hit.score;
      seen.sources.add(hit.source);
      for (const engine of hit.engines ?? []) seen.engineSet.add(engine);
      if (!seen.snippet && hit.snippet) seen.snippet = hit.snippet;
      if (!seen.title && hit.title) seen.title = hit.title;
    } else {
      merged.set(key, { ...hit, sources: new Set([hit.source]), engineSet: new Set(hit.engines ?? []) });
    }
  }
  return [...merged.values()]
    .map((hit) => ({ hit, score: hit.score * (isSolanaSource(hit.url) ? SOLANA_BOOST : 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(({ hit }) => ({
      title: hit.title,
      url: hit.url,
      snippet: hit.snippet,
      sources: [...hit.sources],
      ...(hit.engineSet.size ? { engines: [...hit.engineSet] } : {}),
    }));
}
