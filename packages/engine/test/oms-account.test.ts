import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, chmodSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmsAccountControls, type AccountInteraction } from '../src/runtime/oms-account.ts';
import { readInferencePreferences, writeInferencePreferences } from '../src/runtime/inference-preferences.ts';

async function fixture(t: TestContext, mount = '') {
  const root = mkdtempSync(join(tmpdir(), 'oms-account-'));
  const calls: Array<{ path: string; body: unknown; authorization?: string; time: number }> = [];
  const opened: string[] = [], notices: string[] = [], devices: unknown[] = [];
  let origin = '';
  let polls = 0;
  const state = {
    interval: 1, expiresIn: 60, verificationUri: '', meStatus: 200, logoutStatus: 200, revoked: true,
    meUser: 'user-1', holdMe: undefined as Promise<void> | undefined,
    poll: (_request: IncomingMessage, response: ServerResponse) => json(response, { access_token: 'synthetic-account-token', token_type: 'Bearer', expires_in: 3600 }),
  };
  function json(response: ServerResponse, body: unknown, status = 200) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    calls.push({ path: request.url!, body: body ? JSON.parse(body) : null, authorization: request.headers.authorization, time: Date.now() });
    if (request.url === mount + '/api/auth/device/code') return json(response, { device_code: 'synthetic-device-code', user_code: 'ABCD-EFGH', verification_uri: state.verificationUri || origin + '/device', verification_uri_complete: 'https://untrusted.invalid/approve', expires_in: state.expiresIn, interval: state.interval });
    if (request.url === mount + '/api/auth/device/token') { polls++; return state.poll(request, response); }
    if (request.url === mount + '/api/me') { if (state.holdMe) await state.holdMe; return json(response, { user: { id: state.meUser, email: 'synthetic@example.test' }, devices: [] }, state.meStatus); }
    if (request.url === mount + '/api/account/logout') return json(response, { serverRevoked: state.revoked }, state.logoutStatus);
    json(response, {}, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}${mount}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const preferencesPath = join(root, 'inference.json'), accountPath = join(root, 'oms-account.json');
  writeInferencePreferences(preferencesPath, { version: 1, gatewayOrigin: origin, mimoProvider: 'xiaomi-token-plan-sgp' });
  const controller = new AbortController();
  let gated = 0, busy = false;
  const options = {
    agentRoot: root, signal: controller.signal,
    async withUserOperation<T>(action: () => Promise<T>): Promise<T> { gated++; if (busy) throw new Error('Agent is busy'); return action(); },
    async openBrowser(url: string) { opened.push(url); },
  };
  const interaction: AccountInteraction = { showDevice(data) { devices.push(data); }, notice(message) { notices.push(message); } };
  return { root, calls, opened, notices, devices, state, origin, options, interaction, accountPath, preferencesPath, controller, json,
    polls: () => polls, gated: () => gated, busy(value: boolean) { busy = value; } };
}

test('device login uses library fields, private storage and private credentials without inference or preference changes', async t => {
  const f = await fixture(t);
  const before = readFileSync(f.preferencesPath, 'utf8');
  const account = await createOmsAccountControls(f.options);
  assert.equal(account.snapshot().state, 'signed-out');
  await account.login(f.interaction, new AbortController().signal);
  assert.deepEqual(f.opened, [f.origin + '/device']);
  assert.equal(f.devices.length, 1);
  assert.deepEqual(f.calls.map(c => c.path), ['/api/auth/device/code', '/api/auth/device/token', '/api/me']);
  assert.deepEqual(f.calls[0]?.body, { client_id: 'oms-cli' });
  assert.deepEqual(f.calls[1]?.body, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'synthetic-device-code', client_id: 'oms-cli' });
  assert.equal(f.calls[2]?.authorization, ['Bearer', 'synthetic-account-token'].join(' '));
  assert.equal(account.snapshot().state, 'signed-in');
  assert.equal(account.snapshot().email, 'synthetic@example.test');
  assert.equal(statSync(f.accountPath).mode & 0o777, 0o600);
  assert.equal(statSync(f.root).mode & 0o777, 0o700);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f.accountPath, 'utf8'))).sort(), ['expiresAt', 'origin', 'token', 'userId']);
  assert.equal(readFileSync(f.preferencesPath, 'utf8'), before);
  assert.ok(!JSON.stringify([account.snapshot(), f.notices, f.devices]).includes('synthetic-account-token'));
});

test('pending and slow_down respect the interval and its permanent five-second increase', async t => {
  const f = await fixture(t);
  f.state.poll = (_request, response) => f.json(response, { error: f.polls() === 1 ? 'authorization_pending' : f.polls() === 2 ? 'slow_down' : 'access_denied', error_description: 'untrusted secret diagnostic' }, 400);
  const account = await createOmsAccountControls(f.options);
  await assert.rejects(account.login(f.interaction, new AbortController().signal), e => e instanceof Error && e.message === 'Sign-in was declined in the browser. Run /login to try again.' && !e.message.includes('untrusted'));
  const times = f.calls.filter(c => c.path.endsWith('/token')).map(c => c.time);
  assert.equal(times.length, 3);
  assert.ok(times[1]! - times[0]! >= 950);
  assert.ok(times[2]! - times[1]! >= 5950);
  assert.equal(account.snapshot().state, 'signed-out');
});

for (const error of ['access_denied', 'expired_token', 'invalid_grant', 'invalid_request']) {
  test(`device ${error} stops polling and never persists credentials`, async t => {
    const f = await fixture(t);
    f.state.poll = (_request, response) => f.json(response, { error, error_description: 'synthetic-account-token' }, 400);
    const account = await createOmsAccountControls(f.options);
    await assert.rejects(account.login(f.interaction, new AbortController().signal), e => e instanceof Error && !e.message.includes('synthetic-account-token'));
    assert.equal(f.polls(), 1); assert.equal(existsSync(f.accountPath), false);
  });
}

test('a waitlisted account gets the waitlist message and no credential is written', async t => {
  const f = await fixture(t);
  f.state.poll = (_request, response) => f.json(response, { error: 'access_denied', error_description: 'waitlisted' }, 400);
  const account = await createOmsAccountControls(f.options);
  await assert.rejects(account.login(f.interaction, new AbortController().signal), e => e instanceof Error &&
    e.message === `You're on the OMS waitlist. We'll email you as soon as you're in. Have an invite code? Enter it at ${f.origin}/device, then run /login again.`);
  assert.equal(f.polls(), 1);
  assert.equal(existsSync(f.accountPath), false);
  assert.equal(account.snapshot().state, 'signed-out');
});

test('cancellation and local grant expiry stop before another poll', async t => {
  const f = await fixture(t);
  const account = await createOmsAccountControls(f.options);
  const cancel = new AbortController();
  await assert.rejects(account.login({ ...f.interaction, showDevice() { cancel.abort(); } }, cancel.signal), /cancel/i);
  assert.equal(f.polls(), 0);
  f.state.expiresIn = 1; f.state.interval = 5;
  await assert.rejects(account.login(f.interaction, new AbortController().signal), /expired/i);
  assert.equal(f.polls(), 0);
});

test('a timer that fires a little early at grant expiry still ends the login without a poll', async t => {
  const f = await fixture(t);
  const account = await createOmsAccountControls(f.options);
  f.state.expiresIn = 1; f.state.interval = 5;
  // From 900 ms on, the wall clock reads 5 ms behind the timers: what an early-firing timer looks like to the poll loop.
  const realNow = Date.now.bind(Date), start = realNow();
  t.mock.method(Date, 'now', () => { const now = realNow(); return now - start >= 900 ? now - 5 : now; });
  await assert.rejects(account.login(f.interaction, new AbortController().signal), /expired/i);
  assert.equal(f.polls(), 0);
});

test('a lost one-use exchange response is never retried and requires explicit new login', async t => {
  const f = await fixture(t);
  f.state.poll = (request, _response) => request.socket.destroy();
  const account = await createOmsAccountControls(f.options);
  await assert.rejects(account.login(f.interaction, new AbortController().signal), /new.*login|login.*again/i);
  assert.equal(f.polls(), 1); assert.equal(existsSync(f.accountPath), false);
});

test('fixed verification URI, redirect refusal and post-exchange verification fail closed', async t => {
  const f = await fixture(t);
  const account = await createOmsAccountControls(f.options);
  f.state.verificationUri = 'https://untrusted.invalid/device';
  await assert.rejects(account.login(f.interaction, new AbortController().signal));
  assert.equal(f.opened.length, 0); assert.equal(f.polls(), 0);
  f.state.verificationUri = '';
  f.state.poll = (_request, response) => { response.writeHead(307, { location: f.origin + '/unexpected' }); response.end(); };
  await assert.rejects(account.login(f.interaction, new AbortController().signal));
  assert.equal(f.calls.some(c => c.path === '/unexpected'), false);
  f.state.poll = (_request, response) => f.json(response, { access_token: 'synthetic-account-token', token_type: 'Bearer', expires_in: 3600 });
  f.state.meStatus = 401;
  await assert.rejects(account.login(f.interaction, new AbortController().signal));
  assert.equal(existsSync(f.accountPath), false);
});

test('browser launch failure leaves copyable device information and continues authentication', async t => {
  const f = await fixture(t);
  const account = await createOmsAccountControls({ ...f.options, async openBrowser() { throw Error('synthetic-private-path'); } });
  await account.login(f.interaction, new AbortController().signal);
  assert.equal(account.snapshot().state, 'signed-in'); assert.equal(f.devices.length, 1);
  assert.ok(f.notices.some(n => /browser/i.test(n))); assert.ok(!f.notices.join('').includes('synthetic-private-path'));
});

test('offline or unconfirmed server logout removes local access without claiming durable revocation', async t => {
  const f = await fixture(t);
  let offline = false;
  const account = await createOmsAccountControls({ ...f.options, fetch: async (input, init) => {
    if (offline) throw Error('synthetic-account-token');
    return fetch(input, init);
  } });
  await account.login(f.interaction, new AbortController().signal); offline = true;
  assert.deepEqual(await account.logout(new AbortController().signal), { serverRevoked: false });
  assert.equal(existsSync(f.accountPath), false); assert.equal(account.snapshot().state, 'signed-out');
  offline = false; await account.login(f.interaction, new AbortController().signal); f.state.revoked = false;
  assert.deepEqual(await account.logout(new AbortController().signal), { serverRevoked: false });
});

test('unsafe account files and mismatched origins cannot load or transmit credentials', async t => {
  const f = await fixture(t);
  const value = { origin: f.origin, token: 'synthetic-account-token', expiresAt: Date.now() + 60_000, userId: 'user-1' };
  writeFileSync(f.accountPath, JSON.stringify(value), { mode: 0o600 }); chmodSync(f.accountPath, 0o644);
  await assert.rejects(async () => createOmsAccountControls(f.options));
  chmodSync(f.accountPath, 0o600); rmSync(f.accountPath); const target = join(f.root, 'other.json');
  writeFileSync(target, JSON.stringify(value), { mode: 0o600 }); symlinkSync(target, f.accountPath);
  await assert.rejects(async () => createOmsAccountControls(f.options));
  rmSync(f.accountPath); writeFileSync(f.accountPath, JSON.stringify({ ...value, origin: 'https://another.invalid' }), { mode: 0o600 });
  await assert.rejects(async () => createOmsAccountControls(f.options));
  assert.equal(f.calls.length, 0);
});

test('logout still revokes and removes the private account', async t => {
  const f = await fixture(t);
  const account = await createOmsAccountControls(f.options);
  await account.login(f.interaction, new AbortController().signal);
  assert.deepEqual(await account.logout(new AbortController().signal), { serverRevoked: true });
  assert.equal(existsSync(f.accountPath), false);
});

test('expired stored sessions and revoked sessions lose runtime access without inference', async t => {
  const f = await fixture(t);
  writeFileSync(f.accountPath, JSON.stringify({ origin: f.origin, token: 'synthetic-account-token', expiresAt: Date.now() - 1000, userId: 'user-1' }), { mode: 0o600 });
  const account = await createOmsAccountControls(f.options);
  assert.equal(account.snapshot().state, 'signed-out'); assert.equal(existsSync(f.accountPath), false);
  assert.equal(f.calls.length, 0);
  await account.login(f.interaction, new AbortController().signal);
  f.state.meStatus = 401; await account.refresh();
  assert.equal(account.snapshot().state, 'signed-out');
  assert.equal(existsSync(f.accountPath), false);
});

test('logout interrupts pending login rather than permitting a later credential write', async t => {
  const f = await fixture(t);
  const account = await createOmsAccountControls(f.options);
  let shown: (() => void) | undefined;
  const displayed = new Promise<void>(resolve => { shown = resolve; });
  const pending = account.login({ ...f.interaction, showDevice() { shown?.(); } }, new AbortController().signal);
  const rejected = assert.rejects(pending, /cancel/i);
  await displayed;
  assert.deepEqual(await account.logout(new AbortController().signal), { serverRevoked: false });
  await rejected;
  assert.equal(f.polls(), 0); assert.equal(existsSync(f.accountPath), false);
});

test('mounted device login, refresh and logout stay on the exact base URL with real HTTP response URLs', async t => {
  const f = await fixture(t, '/oms');
  const account = createOmsAccountControls(f.options);
  await account.login(f.interaction, new AbortController().signal);
  assert.deepEqual(f.opened, [f.origin + '/device']);
  assert.equal(account.snapshot().state, 'signed-in');
  await account.refresh();
  assert.equal(account.snapshot().email, 'synthetic@example.test');
  assert.deepEqual(await account.logout(new AbortController().signal), { serverRevoked: true });
  assert.deepEqual(f.calls.map(call => call.path), ['/oms/api/auth/device/code', '/oms/api/auth/device/token', '/oms/api/me', '/oms/api/me', '/oms/api/account/logout']);
});

test('mounted account refuses root device URI and a saved credential from the legacy origin before sending it', async t => {
  const f = await fixture(t, '/oms');
  f.state.verificationUri = new URL('/device', f.origin).href;
  await assert.rejects(createOmsAccountControls(f.options).login(f.interaction, new AbortController().signal));
  assert.equal(f.opened.length, 0);
  writeFileSync(f.accountPath, JSON.stringify({ origin: 'https://oms.barestate.xyz', token: 'synthetic-old-token', userId: 'user-1', expiresAt: Date.now() + 60000 }), { mode: 0o600 });
  assert.throws(() => createOmsAccountControls(f.options));
  assert.equal(f.calls.some(call => call.authorization), false);
});

test('gateway preference paths reject URL normalization, encoded separators and invalid mounts', async t => {
  const f = await fixture(t);
  const value = readInferencePreferences(f.preferencesPath);
  for (const base of ['https://barestate.xyz/oms/', 'https://barestate.xyz/oms/../other', 'https://barestate.xyz/oms/%2fapi', 'https://barestate.xyz//oms', 'https://barestate.xyz/oms?x=1', 'https://barestate.xyz/oms#x', 'https://user@barestate.xyz/oms']) {
    assert.throws(() => writeInferencePreferences(f.preferencesPath, { ...value, gatewayOrigin: base }));
  }
  writeInferencePreferences(f.preferencesPath, { ...value, gatewayOrigin: 'https://barestate.xyz/oms' });
  assert.equal(readInferencePreferences(f.preferencesPath).gatewayOrigin, 'https://barestate.xyz/oms');
});


test('the search credential is the live account token and origin, and goes away on logout', async t => {
  const f = await fixture(t);
  const account = await createOmsAccountControls(f.options);
  assert.equal(account.searchCredential(), undefined);
  await account.login(f.interaction, new AbortController().signal);
  assert.deepEqual(account.searchCredential(), { origin: f.origin, token: 'synthetic-account-token' });
  await account.logout(new AbortController().signal);
  assert.equal(account.searchCredential(), undefined);
  writeFileSync(f.accountPath, JSON.stringify({ origin: f.origin, token: 'synthetic-account-token', expiresAt: Date.now() - 1000, userId: 'user-1' }), { mode: 0o600 });
  assert.equal((await createOmsAccountControls(f.options)).searchCredential(), undefined, 'an expired token is never offered');
});
