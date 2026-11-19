import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalUrl, fuse, isSolanaSource, SOLANA_BOOST } from '../src/fusion.ts';
import { ADMIN, GATEWAY_TOKEN, SEARCH, searchBody, searchResult, setup, sha, TOKEN } from './helpers.ts';

const hit = (url: string, title = url) => ({ title, url, snippet: '' });

test('result shape matches the oms-search contract', async () => {
  const { call } = setup({
    [SEARCH]: () => searchBody([searchResult('https://example.com/a', 'A', 'high', 'snippet a')]),
  });
  const response = await call('/search', { query: '  anchor   idl ', count: 5 });
  assert.equal(response.status, 200);
  const body = await response.json<any>();
  assert.deepEqual(Object.keys(body).sort(), ['answered', 'backends', 'cached', 'query', 'results']);
  assert.equal(body.query, 'anchor idl');
  assert.deepEqual(body.results, [
    { title: 'A', url: 'https://example.com/a', snippet: 'snippet a', sources: ['contextdev'] },
  ]);
  assert.deepEqual(body.backends, { contextdev: 'ok (1)' });
  assert.deepEqual(body.answered, ['contextdev']);
  assert.equal(body.cached, false);
});

test('context.dev gets the query and 20 results; zdr is sent only when CONTEXT_DEV_ZDR=enabled', async () => {
  const off = setup({ [SEARCH]: () => searchBody([]) });
  await off.call('/search', { query: 'q', count: 7 });
  assert.deepEqual(off.upstream.calls[0]!.body, { query: 'q', numResults: 20 });
  assert.equal(off.upstream.calls[0]!.url, SEARCH);
  const on = setup({ [SEARCH]: () => searchBody([]) }, { CONTEXT_DEV_ZDR: 'enabled' });
  await on.call('/search', { query: 'q' });
  assert.equal(on.upstream.calls[0]!.body.zdr, 'enabled');
});

test('bad query or count is a 400 before any upstream call', async () => {
  const { call, upstream } = setup({ [SEARCH]: () => searchBody([]) });
  for (const body of [
    {},
    { query: '' },
    { query: '  ' },
    { query: 'x'.repeat(401) },
    { query: 'q', count: 0 },
    { query: 'q', count: 21 },
    { query: 'q', count: 2.5 },
    { query: 'q', count: '5' },
  ])
    assert.equal((await call('/search', body)).status, 400, JSON.stringify(body));
  assert.equal(upstream.calls.length, 0);
});

test('canonicalUrl folds scheme, www, case, fragment, tracking params, port and trailing slash', () => {
  assert.equal(canonicalUrl('http://WWW.Example.com/Docs/?utm_source=x&b=2&a=1#top'), 'example.com/Docs?a=1&b=2');
  assert.equal(canonicalUrl('https://example.com/Docs?b=2&a=1'), 'example.com/Docs?a=1&b=2');
  assert.equal(canonicalUrl('https://example.com:443/'), 'example.com/');
  assert.equal(
    canonicalUrl('https://solana.stackexchange.com/questions/5275/a-seeds-constraint'),
    canonicalUrl('https://solana.stackexchange.com/q/5275'),
  );
  assert.notEqual(
    canonicalUrl('https://solana.stackexchange.com/q/5275'),
    canonicalUrl('https://stackoverflow.com/q/5275'),
  );
  assert.notEqual(canonicalUrl('https://example.com/docs?page=2'), canonicalUrl('https://example.com/docs'));
  assert.equal(canonicalUrl('not a url'), undefined);
  assert.equal(canonicalUrl('ftp://example.com/x'), undefined);
});

test('duplicates are merged by canonical URL; the first title and snippet win', async () => {
  const { call } = setup({
    [SEARCH]: () =>
      searchBody([
        searchResult('https://example.com/docs/', 'Docs'),
        searchResult('https://www.example.com/docs#x', 'Docs again'),
        searchResult('https://example.com/other'),
        searchResult('http://example.com/docs?utm_campaign=z'),
        searchResult('javascript:alert(1)'),
      ]),
  });
  const body = await (await call('/search', { query: 'q', count: 10 })).json<any>();
  assert.deepEqual(
    body.results.map((r: any) => r.url),
    ['https://example.com/docs/', 'https://example.com/other'],
  );
  assert.equal(body.results[0].title, 'Docs');
  assert.equal(body.backends['contextdev'], 'ok (5)');
});

test('reciprocal rank fusion puts a result both lists agree on first and dedupes it', () => {
  const results = fuse(
    [
      { source: 'a', hits: [hit('https://one.example/'), hit('https://shared.example/page')] },
      { source: 'b', hits: [hit('https://two.example/'), hit('http://www.shared.example/page/#x')] },
    ],
    10,
  );
  assert.deepEqual(
    results.map((r) => r.url),
    ['https://shared.example/page', 'https://one.example/', 'https://two.example/'],
  );
  assert.deepEqual(results[0]!.sources, ['a', 'b']);
});

test('isSolanaSource covers the listed Solana sources and nothing look-alike', () => {
  for (const url of [
    'https://solana.com/docs',
    'https://docs.solana.com/x',
    'https://www.anchor-lang.com/docs',
    'https://docs.rs/anchor-lang/latest',
    'https://solana.stackexchange.com/questions/1',
    'https://github.com/solana-foundation/anchor',
    'https://github.com/solana-labs/solana',
    'https://docs.surfpool.run/',
    'https://github.com/txtx/surfpool',
    'https://www.helius.dev/docs/rpc',
    'https://docs.helius.dev/',
  ])
    assert.ok(isSolanaSource(url), url);
  for (const url of [
    'https://notsolana.com/',
    'https://solana.com.evil.example/',
    'https://github.com/someone/solana-notes',
    'https://helius.dev.evil.example/',
    'https://www.helius.dev/blog/post',
  ])
    assert.ok(!isSolanaSource(url), url);
});

test('Solana sources score x1.2: one outranks a slightly better-ranked generic result', () => {
  assert.equal(SOLANA_BOOST, 1.2);
  const results = fuse(
    [
      {
        source: 'a',
        hits: [
          hit('https://blog.example/solana-pdas'),
          hit('https://random.example/x'),
          hit('https://solana.com/docs/core/pda'),
        ],
      },
    ],
    10,
  );
  assert.equal(results[0]!.url, 'https://solana.com/docs/core/pda');
  assert.equal(results[1]!.url, 'https://blog.example/solana-pdas');
  assert.ok(Math.abs(results[0]!.score - 1.2 / 63) < 1e-12);
});

test('the boost does not lift a Solana source past many better-ranked results', () => {
  const generic = Array.from({ length: 20 }, (_, i) => hit(`https://g${i}.example/`));
  const results = fuse([{ source: 'a', hits: [...generic, hit('https://solana.stackexchange.com/q/1')] }], 30);
  assert.equal(results[0]!.url, 'https://g0.example/');
  assert.ok(results.findIndex((r) => r.url.includes('stackexchange')) > 5);
});

test('Solana boost reorders live results', async () => {
  const { call } = setup({
    [SEARCH]: () =>
      searchBody([
        searchResult('https://example.com/a', 'a'),
        searchResult('https://example.com/b', 'b'),
        searchResult('https://solana.com/docs/core/accounts', 'sol'),
      ]),
  });
  const body = await (await call('/search', { query: 'q' })).json<any>();
  assert.deepEqual(
    body.results.map((r: any) => r.title),
    ['sol', 'a', 'b'],
  );
});

test('KV cache: a miss calls context.dev and stores 24 h; a hit serves any count without calling out', async () => {
  const urls = Array.from({ length: 12 }, (_, i) => searchResult(`https://example.com/${i}`));
  const { call, upstream, kv } = setup({ [SEARCH]: () => searchBody(urls) });
  const first = await (await call('/search', { query: 'Q', count: 3 })).json<any>();
  assert.equal(first.cached, false);
  assert.equal(first.results.length, 3);
  assert.equal(upstream.calls.length, 1);
  const [entry] = [...kv.data.values()];
  assert.equal(entry!.ttl, 24 * 60 * 60);
  const second = await (await call('/search', { query: 'q', count: 10 }, GATEWAY_TOKEN)).json<any>();
  assert.equal(second.cached, true);
  assert.equal(second.results.length, 10);
  assert.deepEqual(second.results.slice(0, 3), first.results);
  assert.equal(upstream.calls.length, 1);
  await call('/search', { query: 'another' });
  assert.equal(upstream.calls.length, 2);
});

test('an empty answer is not cached', async () => {
  const { call, upstream, kv } = setup({ [SEARCH]: () => searchBody([]) });
  await call('/search', { query: 'q' });
  await call('/search', { query: 'q' });
  assert.equal(kv.data.size, 0);
  assert.equal(upstream.calls.length, 2);
});

test('the cache key and stored value never hold the query text or the token', async () => {
  const { call, kv } = setup({ [SEARCH]: () => searchBody([searchResult('https://example.com/a')]) });
  await call('/search', { query: 'very-private-query' });
  const [key] = [...kv.data.keys()];
  assert.ok(!key!.includes('very-private-query'));
  assert.ok(![...kv.data.values()].some((v) => v.value.includes(TOKEN) || v.value.includes('very-private-query')));
});

test('credits are recorded per request and per token digest, without the query, and /usage returns daily totals', async () => {
  const { call, events } = setup({ [SEARCH]: () => searchBody([searchResult('https://example.com/a')], 2) });
  await call('/search', { query: 'secret one' });
  await call('/search', { query: 'secret two' }, GATEWAY_TOKEN);
  await call('/search', { query: 'secret two' }, GATEWAY_TOKEN);
  const usage = await (await call('/usage', undefined, ADMIN)).json<any>();
  const [today] = usage.days;
  assert.equal(today.date, new Date().toISOString().slice(0, 10));
  assert.equal(today.requests, 2);
  assert.equal(today.credits, 4);
  assert.deepEqual(today.routes, { search: { requests: 2, credits: 4 } });
  assert.deepEqual(today.tokens, {
    [sha(TOKEN).slice(0, 16)]: { requests: 1, credits: 2 },
    [sha(GATEWAY_TOKEN).slice(0, 16)]: { requests: 1, credits: 2 },
  });
  assert.equal(events.length, 2);
  assert.ok(!JSON.stringify([usage, events]).includes('secret'));
});
