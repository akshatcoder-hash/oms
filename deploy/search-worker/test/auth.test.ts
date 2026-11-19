import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN, GATEWAY_TOKEN, SEARCH, searchBody, searchResult, setup } from './helpers.ts';

const routes = { [SEARCH]: () => searchBody([searchResult('https://example.com/a')]) };

test('GET /health needs no token', async () => {
  const { call } = setup(routes);
  const response = await call('/health', undefined, null);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json<any>(), { ok: true });
});

for (const [name, token] of [
  ['missing', null],
  ['wrong', 'not-the-right-token-at-all'],
  ['too short', 'short'],
  ['empty bearer', ''],
] as const) {
  test(`${name} token gets 401 Unauthorized text/plain on /search and /fetch`, async () => {
    const { call, upstream } = setup(routes);
    for (const path of ['/search', '/fetch']) {
      const response = await call(path, { query: 'x', url: 'https://example.com' }, token);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('content-type'), 'text/plain;charset=UTF-8');
      assert.equal(await response.text(), 'Unauthorized');
    }
    assert.equal(upstream.calls.length, 0);
  });
}

test('every digest in ACCEPTED_TOKEN_SHA256 is accepted', async () => {
  const { call } = setup(routes);
  assert.equal((await call('/search', { query: 'x' })).status, 200);
  assert.equal((await call('/search', { query: 'y' }, GATEWAY_TOKEN)).status, 200);
});

test('no accepted digests configured refuses everyone', async () => {
  const { call } = setup(routes, { ACCEPTED_TOKEN_SHA256: '' });
  assert.equal((await call('/search', { query: 'x' })).status, 401);
});

test('/usage needs the admin token, not a search token', async () => {
  const { call } = setup(routes);
  assert.equal((await call('/usage')).status, 401);
  assert.equal((await call('/usage', undefined, null)).status, 401);
  assert.equal((await call('/search', { query: 'x' }, ADMIN)).status, 401);
  assert.equal((await call('/usage', undefined, ADMIN)).status, 200);
});

test('unknown routes are 404 JSON, wrong methods 405 with Allow, bad JSON 400', async () => {
  const { call } = setup(routes);
  const missing = await call('/nope', {}, null);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json<any>(), { error: 'not found' });
  const get = await call('/search');
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  const bad = await call('/search', undefined, undefined, 'POST');
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json<any>(), { error: 'body must be JSON' });
});

test('each token is rate limited per minute with Retry-After', async () => {
  const { call } = setup(routes, { RATE_PER_MIN: '3' });
  for (let i = 0; i < 3; i++) assert.equal((await call('/search', { query: `q${i}` })).status, 200);
  const limited = await call('/search', { query: 'q4' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await call('/search', { query: 'q5' }, GATEWAY_TOKEN)).status, 200);
});
