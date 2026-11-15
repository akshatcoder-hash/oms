import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hostAllowed, publicAddress, startEgressProxy } from '../src/egress.ts';
import { buildSubscriptionLaunch, parseCliUsage } from '../src/harnesses.ts';
import { HARNESSES, parseContender, SUBSCRIPTION_MODELS } from '../src/matrix.ts';
import { codexCredential } from '../src/subscription.ts';
import { benchAgentImage, defaultHarnessEnvironment } from '@oms/engine';

test('the three published cells parse; everything else is not a cell', () => {
  assert.deepEqual(parseContender('oms3-web:gpt-sol'), { harness: 'oms3', modelKey: 'gpt-sol', online: 'web + Solana MCP' });
  assert.deepEqual(parseContender('codex-web:gpt-sol')?.harness, 'codex');
  assert.deepEqual(parseContender('claude-code-web:opus-sub')?.harness, 'claude-code');
  for (const id of ['oms3:gpt-sol', 'oms-web:gpt-sol', 'codex-web:opus', 'fusion:auto', '']) assert.equal(parseContender(id), null);
  for (const harness of HARNESSES) assert.ok(Object.keys(SUBSCRIPTION_MODELS[harness]).length > 0);
  for (const models of Object.values(SUBSCRIPTION_MODELS)) for (const model of Object.values(models)) assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('hostnames match exactly or by wildcard subdomain, and only public addresses pass', () => {
  assert.equal(hostAllowed('chatgpt.com', ['chatgpt.com']), true);
  assert.equal(hostAllowed('evilchatgpt.com', ['chatgpt.com']), false);
  assert.equal(hostAllowed('a.grok.com', ['*.grok.com']), true);
  assert.equal(publicAddress('93.184.216.34'), true);
  for (const ip of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '172.31.0.1', '192.168.1.1', '::1', '::ffff:10.0.0.1']) assert.equal(publicAddress(ip), false, ip);
});

test('the egress tunnel refuses CONNECT to a non-public address in public-https mode', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-egress-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tunnel = await startEgressProxy({ host: '127.0.0.1', port: 0, allow: 'public-https', logFile: join(dir, 'egress.log') });
  t.after(() => tunnel.close());
  const answer = await new Promise<number>(done => {
    const request = createServer().listen(0, '127.0.0.1').close();
    void request;
    import('node:http').then(({ request: http }) => {
      const req = http({ host: '127.0.0.1', port: tunnel.port, method: 'CONNECT', path: '127.0.0.1:443' });
      req.on('connect', response => { response.statusCode === undefined ? done(0) : done(response.statusCode); });
      req.on('response', response => done(response.statusCode ?? 0));
      req.on('error', () => done(0));
      req.end();
    });
  });
  assert.notEqual(answer, 200);
});

test('subscription launches use the tunnel, never a provider URL, key or token', () => {
  for (const harness of ['codex', 'claude-code'] as const) {
    const launch = buildSubscriptionLaunch({ harness, modelId: 'm', prompt: 'p', egress: 'http://172.31.0.1:3171', online: true });
    assert.equal(launch.env.HTTPS_PROXY, 'http://172.31.0.1:3171');
    assert.equal(launch.env.HOME, '/home/agent');
    assert.ok(!Object.keys(launch.env).some(key => /API_KEY|AUTH_TOKEN|BASE_URL/.test(key)));
  }
  assert.match(buildSubscriptionLaunch({ harness: 'codex', modelId: 'm', prompt: 'p', egress: 'x', online: true }).files['.codex/config.toml']!, /web_search = "live"[\s\S]*mcp\.solana\.com/);
  assert.match(buildSubscriptionLaunch({ harness: 'codex', modelId: 'm', prompt: 'p', egress: 'x' }).files['.codex/config.toml']!, /web_search = "disabled"/);
  assert.ok(buildSubscriptionLaunch({ harness: 'claude-code', modelId: 'm', prompt: 'p', egress: 'x', online: true }).argv.includes('--strict-mcp-config'));
});

test('token usage is read from each CLI output and never guessed', () => {
  assert.equal(parseCliUsage('codex', 'no events here'), null);
  const codex = ['{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":5}}',
    '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":10,"output_tokens":7}}'].join('\n');
  assert.deepEqual(parseCliUsage('codex', codex), { inputTokens: 80, outputTokens: 12, cacheReadTokens: 70, cacheWriteTokens: 0, turns: 2 });
  const claude = JSON.stringify({ type: 'result', num_turns: 3, usage: { input_tokens: 4, output_tokens: 9, cache_read_input_tokens: 20, cache_creation_input_tokens: 6 } });
  assert.deepEqual(parseCliUsage('claude-code', claude), { inputTokens: 4, outputTokens: 9, cacheReadTokens: 20, cacheWriteTokens: 6, turns: 3 });
});

test('the Codex login becomes a refresh-free credential, and unusable logins are refused', t => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-codex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
  const file = join(dir, 'auth.json');
  const exp = Math.floor(Date.now() / 1000) + 7200;
  writeFileSync(file, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } }), refresh_token: 'secret' } }));
  const credential = codexCredential(file);
  assert.equal(credential.refresh, '');
  assert.equal(credential.accountId, 'acct');
  writeFileSync(file, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'k' }));
  assert.throws(() => codexCredential(file), /not a ChatGPT subscription/);
  writeFileSync(file, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 60, 'https://api.openai.com/auth': { chatgpt_account_id: 'a' } }) } }));
  assert.throws(() => codexCredential(file), /expires within the hour/);
});

test('OMS_BENCH_AGENT_IMAGE swaps the exec image only when it is a pinned image id', () => {
  const saved = process.env.OMS_BENCH_AGENT_IMAGE;
  try {
    process.env.OMS_BENCH_AGENT_IMAGE = 'oms-solbench-harness:1';
    assert.equal(benchAgentImage(), undefined);
    process.env.OMS_BENCH_AGENT_IMAGE = `sha256:${'a'.repeat(64)}`;
    assert.equal(benchAgentImage(), `sha256:${'a'.repeat(64)}`);
    assert.equal(defaultHarnessEnvironment('/x/surfpool', 'docker').image, `sha256:${'a'.repeat(64)}`);
  } finally { if (saved === undefined) delete process.env.OMS_BENCH_AGENT_IMAGE; else process.env.OMS_BENCH_AGENT_IMAGE = saved; }
});
