import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_DOWNLOAD_BYTES, MAX_TEXT_CHARS, parseFetchUrl } from '../src/fetch-guard.ts';
import { isPrivateAddress } from '../src/net.ts';
import { SCRAPE, scrapeBody, setup } from './helpers.ts';

const PAGE = 'https://docs.example.com';
const html = (title: string, body: string) =>
  new Response(`<html><head><title>${title}</title></head><body><main><p>${body}</p></main></body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

test('a context.dev scrape answers /fetch with main-content markdown, in the oms-search shape', async () => {
  const { call, upstream } = setup({ [SCRAPE]: () => scrapeBody('# Hello', 'https://docs.example.com/page', 'Docs') });
  const response = await call('/fetch', { url: `${PAGE}/page` });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json<any>(), {
    url: `${PAGE}/page`,
    finalUrl: `${PAGE}/page`,
    title: 'Docs',
    text: '# Hello',
    truncated: false,
    backend: 'context.dev',
    answered: ['context.dev'],
    attempts: {},
    cached: false,
  });
  assert.deepEqual(upstream.calls[0]!.body, {
    url: `${PAGE}/page`,
    formats: { markdown: true },
    sharedParams: { mainContentOnly: true },
    timeoutOpts: { milliseconds: 30000 },
  });
});

test('KV cache: /fetch stores 7 days under the canonical URL and serves the hit without calling out', async () => {
  const { call, upstream, kv } = setup({ [SCRAPE]: () => scrapeBody('text') });
  assert.equal((await (await call('/fetch', { url: `${PAGE}/x/` })).json<any>()).cached, false);
  assert.equal([...kv.data.values()][0]!.ttl, 7 * 24 * 60 * 60);
  const hit = await (await call('/fetch', { url: `${PAGE}/x#frag` })).json<any>();
  assert.equal(hit.cached, true);
  assert.equal(hit.text, 'text');
  assert.equal(upstream.calls.length, 1);
});

for (const status of [402, 429, 500, 503]) {
  test(`context.dev ${status} with Retry-After fails over to the plain fetch, pauses context.dev, never echoes the body`, async () => {
    const { call, gate } = setup({
      [SCRAPE]: () => new Response('UPSTREAM-SECRET-BODY', { status, headers: { 'retry-after': '30' } }),
      [PAGE]: () => html('Plain', 'plain body'),
    });
    const response = await call('/fetch', { url: `${PAGE}/p` });
    const raw = await response.text();
    assert.equal(response.status, 200);
    assert.ok(!raw.includes('UPSTREAM-SECRET-BODY'));
    const body = JSON.parse(raw);
    assert.equal(body.backend, 'plain');
    assert.deepEqual(body.answered, ['plain']);
    assert.equal(body.title, '');
    assert.equal(body.text, '# Plain\n\nplain body');
    assert.deepEqual(body.attempts, { 'context.dev': `HTTP ${status}` });
    const paused = gate.semaphore.pausedFor();
    assert.ok(paused > 25_000 && paused <= 30_000, String(paused));
  });
}

test('a 5xx without Retry-After fails over but does not pause context.dev', async () => {
  const { call, gate } = setup({ [SCRAPE]: () => new Response('', { status: 502 }), [PAGE]: () => html('P', 'b') });
  assert.equal((await (await call('/fetch', { url: `${PAGE}/n` })).json<any>()).backend, 'plain');
  assert.equal(gate.semaphore.pausedFor(), 0);
});

test('a 429 without Retry-After pauses context.dev for 60 s', async () => {
  const { call, gate } = setup({ [SCRAPE]: () => new Response('', { status: 429 }), [PAGE]: () => html('P', 'b') });
  await call('/fetch', { url: `${PAGE}/n` });
  assert.ok(gate.semaphore.pausedFor() > 59_000);
});

test('while context.dev is paused, /fetch goes straight to the plain fetch', async () => {
  const { call, upstream, gate } = setup({ [SCRAPE]: () => scrapeBody('x'), [PAGE]: () => html('P', 'b') });
  gate.semaphore.pause(10_000);
  const body = await (await call('/fetch', { url: `${PAGE}/q` })).json<any>();
  assert.equal(body.backend, 'plain');
  assert.deepEqual(body.attempts, { 'context.dev': 'cooling down 10 s' });
  assert.ok(!upstream.calls.some((c) => c.url === SCRAPE));
});

test('a failed scrape output (blocked page) falls back to the plain fetch', async () => {
  const { call } = setup({
    [SCRAPE]: () =>
      Response.json({
        markdown: { requested: true, success: false, data: null, error_code: 'WEBSITE_BLOCKED' },
        key_metadata: { credits_consumed: 0 },
      }),
    [PAGE]: () => html('P', 'fallback'),
  });
  const body = await (await call('/fetch', { url: `${PAGE}/b` })).json<any>();
  assert.equal(body.backend, 'plain');
  assert.deepEqual(body.attempts, { 'context.dev': 'no page (website_blocked)' });
});

test('every backend failing is a 502 with the attempts', async () => {
  const { call } = setup({
    [SCRAPE]: () => new Response('', { status: 500 }),
    [PAGE]: () => new Response('', { status: 404 }),
  });
  const response = await call('/fetch', { url: `${PAGE}/gone` });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json<any>(), {
    error: 'every fetch backend failed',
    attempts: { 'context.dev': 'HTTP 500', plain: 'web_fetch got HTTP 404' },
    answered: [],
  });
});

test('SSRF: URL rules refuse http://, credentials, metadata and private literals', () => {
  for (const url of [
    'http://example.com/',
    'https://user:pass@example.com/',
    'https://user@example.com/',
    'https://127.0.0.1/',
    'https://10.1.2.3/',
    'https://192.168.0.1/',
    'https://172.16.5.5/',
    'https://100.64.0.1/',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/',
    'https://[fe80::1]/',
    'https://[fd00:ec2::254]/',
    'https://[::ffff:127.0.0.1]/',
    'https://metadata.google.internal/',
    'https://localhost/',
    'file:///etc/passwd',
    'not a url',
  ])
    assert.throws(() => parseFetchUrl(url), Error, url);
  assert.equal(parseFetchUrl('https://solana.com/docs').href, 'https://solana.com/docs');
  assert.ok(!isPrivateAddress('8.8.8.8') && !isPrivateAddress('2606:4700::1111'));
});

for (const [name, url, error] of [
  ['private IP', 'https://10.0.0.1/', 'web_fetch refuses private, loopback and link-local addresses'],
  ['metadata IP', 'https://169.254.169.254/', 'web_fetch refuses private, loopback and link-local addresses'],
  ['http://', 'http://docs.example.com/', 'web_fetch only fetches https:// URLs'],
  ['credentials', 'https://u:p@docs.example.com/', 'web_fetch refuses URLs with credentials'],
  [
    'host resolving to a private address',
    'https://db.internal.example/',
    'private, loopback and link-local addresses are refused',
  ],
  [
    'host with one private answer among public ones',
    'https://rebind.example/',
    'private, loopback and link-local addresses are refused',
  ],
  ['host that does not resolve', 'https://nx.example/', 'host does not resolve'],
] as const) {
  test(`SSRF: /fetch refuses a ${name} with 400 before any upstream call`, async () => {
    const { call, upstream } = setup({ [SCRAPE]: () => scrapeBody('x') });
    const response = await call('/fetch', { url });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json<any>(), { error });
    assert.equal(upstream.calls.length, 0);
  });
}

for (const [name, location, error] of [
  ['a private IP', 'https://127.0.0.1/admin', /refuses private/],
  ['a host resolving to a private address', 'https://svc.internal.example/', /refuses private/],
  ['http://', 'http://docs.example.com/insecure', /only fetches https/],
  ['a URL with credentials', 'https://a:b@docs.example.com/', /credentials/],
] as const) {
  test(`SSRF: the plain fetch re-checks redirects and refuses one to ${name}`, async () => {
    const { call, upstream } = setup({
      [SCRAPE]: () => new Response('', { status: 503 }),
      [PAGE]: () => new Response(null, { status: 302, headers: { location } }),
    });
    const response = await call('/fetch', { url: `${PAGE}/start` });
    assert.equal(response.status, 502);
    const body = await response.json<any>();
    assert.match(body.attempts.plain, error);
    assert.equal(body.text, undefined);
    assert.equal(upstream.calls.filter((c) => c.url.startsWith(PAGE)).length, 1);
    assert.ok(!upstream.calls.some((c) => c.url.startsWith(location)));
  });
}

test('the plain fetch follows a public redirect and reports finalUrl', async () => {
  const { call } = setup({
    [SCRAPE]: () => new Response('', { status: 500 }),
    [`${PAGE}/old`]: () => new Response(null, { status: 301, headers: { location: '/new' } }),
    [`${PAGE}/new`]: () => html('New', 'moved'),
  });
  const body = await (await call('/fetch', { url: `${PAGE}/old` })).json<any>();
  assert.equal(body.finalUrl, `${PAGE}/new`);
  assert.equal(body.url, `${PAGE}/old`);
});

test('the plain fetch stops after 5 redirects', async () => {
  let hops = 0;
  const { call } = setup({
    [SCRAPE]: () => new Response('', { status: 500 }),
    [PAGE]: () => new Response(null, { status: 302, headers: { location: `/r${++hops}` } }),
  });
  const body = await (await call('/fetch', { url: `${PAGE}/r0` })).json<any>();
  assert.equal(body.attempts.plain, 'web_fetch stopped after 5 redirects');
  assert.equal(hops, 6);
});

test('size caps: the plain download stops at 2 MB and is marked truncated', async () => {
  let sent = 0;
  const { call } = setup({
    [SCRAPE]: () => new Response('', { status: 429 }),
    [PAGE]: () => {
      const chunk = new TextEncoder().encode('a'.repeat(64 * 1024));
      const stream = new ReadableStream({
        pull(controller) {
          if (sent >= 8 * 1024 * 1024) return controller.close();
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/plain' } });
    },
  });
  const body = await (await call('/fetch', { url: `${PAGE}/big` })).json<any>();
  assert.equal(body.truncated, true);
  assert.equal(MAX_DOWNLOAD_BYTES, 2_000_000);
  assert.equal(body.text.length, MAX_TEXT_CHARS);
  assert.ok(sent <= MAX_DOWNLOAD_BYTES + 128 * 1024, `read ${sent} bytes`);
});

test('size caps: returned text is cut at 200,000 characters', async () => {
  const { call } = setup({ [SCRAPE]: () => scrapeBody('b'.repeat(300_000)) });
  const body = await (await call('/fetch', { url: `${PAGE}/long` })).json<any>();
  assert.equal(body.text.length, 200_000);
  assert.equal(body.truncated, true);
});

test('size caps: an oversized context.dev response is not parsed and the plain fetch takes over', async () => {
  const { call } = setup({
    [SCRAPE]: () => scrapeBody('c'.repeat(5_000_000)),
    [PAGE]: () => html('Small', 'small'),
  });
  const body = await (await call('/fetch', { url: `${PAGE}/huge` })).json<any>();
  assert.equal(body.backend, 'plain');
  assert.deepEqual(body.attempts, { 'context.dev': 'response too large' });
});

test('non-text pages are refused by the plain fetch without echoing the content type', async () => {
  const { call } = setup({
    [SCRAPE]: () => new Response('', { status: 500 }),
    [PAGE]: () => new Response('PNG', { headers: { 'content-type': 'image/png; evil=<script>' } }),
  });
  const response = await call('/fetch', { url: `${PAGE}/img` });
  assert.equal(response.status, 502);
  assert.equal((await response.json<any>()).attempts.plain, 'web_fetch does not read image/png content');
});

test('a url that is not a string or longer than 2048 characters is a 400', async () => {
  const { call } = setup({});
  for (const url of [undefined, 5, `${PAGE}/${'a'.repeat(2048)}`])
    assert.equal((await call('/fetch', { url })).status, 400);
});
