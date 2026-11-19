/** Result fusion, ported from packages/search-service/src/fusion.ts: reciprocal rank fusion, canonical-URL dedupe, Solana boost. */

/** `engines` names the engines behind a hit, for diagnostics. */
export interface Hit {
  title: string;
  url: string;
  snippet: string;
  engines?: string[];
}
export interface RankedList {
  source: string;
  hits: Hit[];
}
export interface FusedResult extends Hit {
  sources: string[];
  score: number;
}

/** The usual RRF constant: damps the gap between rank 1 and rank 2 so agreement across backends matters. */
const RRF_K = 60;
/** A Solana source at rank r beats a generic result up to rank ~1.2r + 12. */
export const SOLANA_BOOST = 1.2;
const TRACKING = /^(utm_|fbclid$|gclid$|msclkid$|ref$|ref_src$)/i;

/** Dedupe key: host without www, path without trailing slash (one form per Stack Exchange question), sorted query minus tracking params; no scheme, port or fragment. */
export function canonicalUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';
  // Stack Exchange: /q/<id> and /questions/<id>/<slug> are the same question.
  const question = /^\/(?:q|questions)\/(\d+)(?:\/|$)/.exec(path);
  if (question && (host.endsWith('stackexchange.com') || host === 'stackoverflow.com'))
    path = `/questions/${question[1]}`;
  const params = [...url.searchParams]
    .filter(([name]) => !TRACKING.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return host + path + (params.length ? '?' + new URLSearchParams(params).toString() : '');
}

const hostIs = (host: string, domain: string) => host === domain || host.endsWith('.' + domain);

/** solana.com, anchor-lang, solana.stackexchange.com, github.com/solana-*, surfpool, helius docs. */
export function isSolanaSource(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const [first = '', second = ''] = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  if (
    hostIs(host, 'solana.com') ||
    hostIs(host, 'anchor-lang.com') ||
    hostIs(host, 'surfpool.run') ||
    hostIs(host, 'solana.stackexchange.com')
  )
    return true;
  if (host === 'docs.rs') return first === 'anchor-lang';
  if (host === 'github.com') return first.startsWith('solana-') || second === 'surfpool' || second === 'anchor';
  if (hostIs(host, 'helius.dev')) return host === 'docs.helius.dev' || first === 'docs';
  return false;
}

export function fuse(lists: RankedList[], count: number): FusedResult[] {
  const byKey = new Map<string, FusedResult>();
  for (const { source, hits } of lists) {
    hits.forEach((hit, index) => {
      const key = canonicalUrl(hit.url);
      if (!key) return;
      const contribution = 1 / (RRF_K + index + 1);
      const seen = byKey.get(key);
      if (seen) {
        seen.score += contribution;
        if (!seen.sources.includes(source)) seen.sources.push(source);
        if (!seen.snippet) seen.snippet = hit.snippet;
        for (const engine of hit.engines ?? []) if (!seen.engines?.includes(engine)) (seen.engines ??= []).push(engine);
      } else
        byKey.set(key, {
          ...hit,
          ...(hit.engines ? { engines: [...hit.engines] } : {}),
          sources: [source],
          score: contribution,
        });
    });
  }
  const results = [...byKey.values()];
  for (const result of results) if (isSolanaSource(result.url)) result.score *= SOLANA_BOOST;
  // Array.prototype.sort is stable: equal scores keep first-seen order.
  return results.sort((a, b) => b.score - a.score).slice(0, count);
}
