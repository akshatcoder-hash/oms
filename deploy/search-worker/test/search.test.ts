import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalUrl, fuse, isSolanaSource, SOLANA_BOOST } from '../src/fusion.ts';
import { ADMIN, GATEWAY_TOKEN, SEARCH, searchBody, searchResult, setup, sha, TOKEN } from './helpers.ts';

test('result shape matches the oms-search contract', async () => {
  const { call } = setup({
    [SEARCH]: () => searchBody([searchResult('https://example.com/a', 'A', 'high', 'snippet a')]),
  });
  const response = await call('/search', { query: 'anchor idl', count: 5 });
  assert.equal(response.status, 200);
  const body = await response.json<any>();
  assert.deepEqual(Object.keys(body).sort(), ['answered', 'backends', 'cached', 'query', 'results']);
  assert.equal(body.query, 'anchor idl');
  assert.deepEqual(body.results, [
    { title: 'A', url: 'https://example.com/a', snippet: 'snippet a', sources: ['context.dev'] },
  ]);
  assert.deepEqual(body.backends, { 'context.dev': 'ok' });
  assert.deepEqual(body.answered, ['context.dev']);
  assert.equal(body.cached, false);
});

test('the request asks context.dev for `count` results with the API key, never forwarding the caller token', async () => {
  const { call, upstream } = setup({ [SEARCH]: () => searchBody([]) });
  await call('/search', { query: 'q', count: 7 });
  const sent: Record<string, unknown> = upstream.calls[0]!.body;
  assert.equal(sent.zdr, undefined);
  assert.deepEqual(sent, { query: 'q', numResults: 7 });
});

test('CONTEXT_DEV_ZDR=enabled adds zdr to every request', async () => {
  const { call, upstream } = setup({ [SEARCH]: () => searchBody([]) }, { CONTEXT_DEV_ZDR: 'enabled' });
  await call('/search', { query: 'q' });
  assert.equal(upstream.calls[0]!.body.zdr, 'enabled');
});

test('bad query or count is a 400', async () => {
  const { call, upstream } = setup({ [SEARCH]: () => searchBody([]) });
  for (const body of [
    {},
    { query: '' },
    { query: '  ' },
    { query: 'q', count: 0 },
    { query: 'q', count: 21 },
    { query: 'q', count: 2.5 },
    { query: 'q', count: '5' },
  ])
    assert.equal((await call('/search', body)).status, 400, JSON.stringify(body));
  assert.equal(upstream.calls.length, 0);
});

test('canonical URLs collapse www, case, trailing slash, fragments, default ports and tracking params', () => {
  const same = [
    'https://Example.com/docs/',
    'https://www.example.com/docs#intro',
    'https://example.com:443/docs?utm_source=x&gclid=1',
    'http://example.com/docs/index.html',
  ];
  assert.equal(new Set(same.map(canonicalUrl)).size, 1);
  assert.notEqual(canonicalUrl('https://example.com/docs?page=2'), canonicalUrl('https://example.com/docs'));
  assert.equal(canonicalUrl('https://example.com/a?b=2&a=1'), canonicalUrl('https://example.com/a?a=1&b=2'));
  assert.equal(canonicalUrl('ftp://example.com/x'), undefined);
  assert.equal(canonicalUrl('not a url'), undefined);
});

test('duplicates are merged by canonical URL and counted once', async () => {
  const { call } = setup({
    [SEARCH]: () =>
      searchBody([
        searchResult('https://example.com/docs/', 'Docs'),
        searchResult('https://www.example.com/docs#x', 'Docs again'),
        searchResult('https://example.com/other'),
        searchResult('https://example.com/docs?utm_campaign=z'),
      ]),
  });
  const body = await (await call('/search', { query: 'q', count: 10 })).json<any>();
  assert.deepEqual(
    body.results.map((r: any) => r.url),
    ['https://example.com/docs/', 'https://example.com/other'],
  );
  assert.equal(body.results[0].title, 'Docs');
});

test('Solana sources are recognised', () => {
  for (const url of [
    'https://solana.com/docs',
    'https://www.anchor-lang.com/docs/basics/idl',
    'https://solana.stackexchange.com/questions/1',
    'https://github.com/solana-labs/solana',
    'https://github.com/solana-foundation/anchor',
    'https://github.com/solana-developers/program-examples',
    'https://docs.surfpool.run/rpc',
    'https://github.com/txtx/surfpool',
    'https://docs.helius.dev/rpc',
    'https://www.helius.dev/docs/api-reference',
  ])
    assert.ok(isSolanaSource(url), url);
  for (const url of [
    'https://example.com/solana.com',
    'https://notsolana.com/',
    'https://github.com/someone/solana-thing',
    'https://www.helius.dev/blog/post',
    'https://docs.rs/anchor',
  ])
    assert.ok(!isSolanaSource(url), url);
});

test('Solana sources score x1.2: a boosted hit overtakes one that scored up to 20% higher', () => {
  const ranked = fuse(
    [
      { title: 'other', url: 'https://example.com/a', snippet: '', score: 1.15, source: 'context.dev' },
      { title: 'sol', url: 'https://solana.com/docs', snippet: '', score: 1, source: 'context.dev' },
      { title: 'far', url: 'https://example.com/b', snippet: '', score: 1.25, source: 'context.dev' },
    ],
    10,
  );
  assert.equal(SOLANA_BOOST, 1.2);
  assert.deepEqual(
    ranked.map((r) => r.title),
    ['far', 'sol', 'other'],
  );
});

test('Solana boost reorders live results', async () => {
  const { call } = setup({
    [SEARCH]: () =>
      searchBody([
        searchResult('https://example.com/a', 'a', 'high'),
        searchResult('https://solana.com/docs/core/accounts', 'sol', 'high'),
      ]),
  });
  const body = await (await call('/search', { query: 'q' })).json<any>();
  assert.deepEqual(
    body.results.map((r: any) => r.title),
    ['sol', 'a'],
  );
});

test('KV cache: a miss calls context.dev and stores 24 h; a hit does not and says cached', async () => {
  const { call, upstream, kv } = setup({ [SEARCH]: () => searchBody([searchResult('https://example.com/a')]) });
  const first = await (await call('/search', { query: 'q', count: 3 })).json<any>();
  assert.equal(first.cached, false);
  assert.equal(upstream.calls.length, 1);
  const [entry] = [...kv.data.values()];
  assert.equal(entry!.ttl, 24 * 60 * 60);
  assert.equal(JSON.parse(entry!.value).cached, undefined);
  const second = await (await call('/search', { query: 'q', count: 3 }, GATEWAY_TOKEN)).json<any>();
  assert.equal(second.cached, true);
  assert.deepEqual({ ...second, cached: false }, first);
  assert.equal(upstream.calls.length, 1);
  await call('/search', { query: 'q', count: 4 });
  assert.equal(upstream.calls.length, 2);
});

test('the cache key and stored value never hold the query text or the token', async () => {
  const { call, kv } = setup({ [SEARCH]: () => searchBody([]) });
  await call('/search', { query: 'very-private-query' });
  const [key] = [...kv.data.keys()];
  assert.ok(!key!.includes('very-private-query'));
  assert.ok(![...kv.data.values()].some((v) => v.value.includes(TOKEN)));
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
