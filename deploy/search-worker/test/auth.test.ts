import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN, GATEWAY_TOKEN, SEARCH, searchBody, searchResult, setup } from './helpers.ts';

const routes = { [SEARCH]: () => searchBody([searchResult('https://example.com/a')]) };

test('GET /health needs no token', async () => {
  const { call } = setup(routes);
  const response = await call('/health', undefined, null);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json<any>(), { status: 'ok' });
});

for (const [name, token] of [
  ['missing', null],
  ['wrong', 'not-the-token'],
  ['empty bearer', ''],
] as const) {
  test(`${name} token gets 401 text/plain on /search and /fetch`, async () => {
    const { call, upstream } = setup(routes);
    for (const path of ['/search', '/fetch']) {
      const response = await call(path, { query: 'x', url: 'https://example.com' }, token);
      assert.equal(response.status, 401);
      assert.match(response.headers.get('content-type')!, /^text\/plain/);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
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

test('unknown routes and wrong methods answer after auth', async () => {
  const { call } = setup(routes);
  assert.equal((await call('/nope', {})).status, 404);
  assert.equal((await call('/search')).status, 405);
  assert.equal((await call('/nope', {}, null)).status, 401);
});
