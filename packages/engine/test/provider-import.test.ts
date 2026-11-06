import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, symlinkSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import { importProviderEnvironment, inspectProviderEnvironment } from '../src/runtime/provider-import.ts';
import { readInferencePreferences, writeInferencePreferences } from '../src/runtime/inference-preferences.ts';
import { registerOmsCatalog } from '../src/runtime/catalog.ts';

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'oms-import-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'synthetic.env');
  const preferencesPath = join(dir, 'inference.json');
  const stored = new Map<string, Credential>();
  const credentials: CredentialStore = {
    async read(id) { return stored.get(id); },
    async list() { return [...stored].map(([providerId, value]) => ({ providerId, type: value.type })); },
    async modify(id, fn) { const value = await fn(stored.get(id)); if (value) stored.set(id, value); return value; },
    async delete(id) { stored.delete(id); },
  };
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  registerOmsCatalog(runtime);
  const signal = new AbortController().signal;
  function content(value: string) { writeFileSync(file, value, { mode: 0o600 }); }
  return { dir, file, preferencesPath, stored, runtime, signal, content };
}

test('inspection reveals names only; confirmed snapshot imports through real canonical login', async t => {
  const f = await fixture(t);
  f.content('export OPENAI_API_KEY="synthetic-openai"\nANTHROPIC_API_KEY=synthetic-anthropic\nIGNORED=not-imported\n');
  assert.deepEqual(await inspectProviderEnvironment(f.file), { names: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'], requiresTokenPlanRegion: false });
  let checks = 0;
  const result = await importProviderEnvironment(f.file, f.runtime, f.signal, {
    checkAuthFile() { checks++; },
    interaction: { notify() {}, async prompt(prompt) {
      assert.equal(prompt.type, 'select');
      assert.ok(prompt.message.includes('OPENAI_API_KEY'));
      assert.ok(!JSON.stringify(prompt).includes('synthetic-openai'));
      f.content('OPENCODE_API_KEY=changed-after-disclosure\n');
      return 'confirm';
    } },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.outcomes.map(value => value.status), ['configured', 'configured']);
  assert.deepEqual(f.stored.get('openai'), { type: 'api_key', key: 'synthetic-openai' });
  assert.equal(f.stored.has('opencode'), false);
  assert.equal(checks, 4);
  assert.ok(!JSON.stringify(result).includes('synthetic-'));
});

test('whole-file invalid inputs produce zero credential writes and sanitized errors', async t => {
  const f = await fixture(t);
  for (const invalid of [
    'OPENAI_API_KEY=good\nOPENAI_API_KEY=duplicate',
    'OPENAI_API_KEY=good\nexport OPENAI_API_KEY=duplicate',
    'OPENAI_API_KEY=good\nOPENCODE_API_KEY="$SECRET"',
    'OPENAI_API_KEY=good\nOPENCODE_API_KEY="$(command)"',
    'OPENAI_API_KEY=good\nOPENCODE_API_KEY="`command`"',
    'OPENAI_API_KEY=good\nOPENCODE_API_KEY=!command',
    'OPENAI_API_KEY=good\nOPENCODE_API_KEY="contains space"',
    'OPENAI_API_KEY=good\nOPENCODE_API_KEY="unterminated',
    'OPENAI_API_KEY=good\n' + '#'.repeat(65536),
  ]) {
    f.content(invalid);
    await assert.rejects(importProviderEnvironment(f.file, f.runtime, f.signal), error => error instanceof Error && error.message.length < 200 && !error.message.includes(invalid) && error.cause === undefined);
    assert.equal(f.stored.size, 0);
  }
  f.content('OPENAI_API_KEY=synthetic-private');
  chmodSync(f.file, 0o644);
  await assert.rejects(inspectProviderEnvironment(f.file));
  chmodSync(f.file, 0o600);
  symlinkSync(f.file, join(f.dir, 'link'));
  await assert.rejects(importProviderEnvironment(join(f.dir, 'link'), f.runtime, f.signal));
  assert.equal(f.stored.size, 0);
});

test('decline and pre-login auth-file failure do not attempt imports', async t => {
  const f = await fixture(t); f.content('OPENAI_API_KEY=synthetic-secret');
  const declined = await importProviderEnvironment(f.file, f.runtime, f.signal, { interaction: { notify() {}, async prompt() { return 'cancel'; } } });
  assert.equal(declined.status, 'cancelled');
  assert.equal(declined.outcomes[0]?.status, 'not_attempted');
  const stopped = await importProviderEnvironment(f.file, f.runtime, f.signal, { checkAuthFile() { throw Error('synthetic-secret'); } });
  assert.equal(stopped.outcomes[0]?.status, 'not_attempted');
  assert.equal(f.stored.size, 0);
});

test('post-save synchronization failure preserves partial outcomes and stops remaining providers', async t => {
  const f = await fixture(t); f.content('OPENAI_API_KEY=synthetic-one\nANTHROPIC_API_KEY=synthetic-two\nOPENCODE_API_KEY=synthetic-three');
  let calls = 0;
  const result = await importProviderEnvironment(f.file, f.runtime, f.signal, { async flushSettings() { if (++calls === 2) throw Error('synthetic-two'); } });
  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.outcomes.map(value => value.status), ['configured', 'may_have_saved', 'not_attempted']);
  assert.equal(f.stored.has('anthropic'), true);
  assert.equal(f.stored.has('opencode'), false);
  assert.ok(!JSON.stringify(result).includes('synthetic-'));
});

test('Token Plan requires explicit region and private preferences; never falls back to PAYG', async t => {
  const f = await fixture(t); f.content('XIAOMI_MIMO_TP_API_KEY=synthetic-tp');
  await assert.rejects(importProviderEnvironment(f.file, f.runtime, f.signal, { preferencesPath: f.preferencesPath }));
  assert.equal(f.stored.size, 0);
  const result = await importProviderEnvironment(f.file, f.runtime, f.signal, { tokenPlanProvider: 'xiaomi-token-plan-sgp', preferencesPath: f.preferencesPath });
  assert.equal(result.outcomes[0]?.provider, 'xiaomi-token-plan-sgp');
  assert.equal(f.stored.has('xiaomi'), false);
  assert.deepEqual(f.stored.get('xiaomi-token-plan-sgp'), { type: 'api_key', key: 'synthetic-tp' });
  assert.equal(readInferencePreferences(f.preferencesPath).mimoProvider, 'xiaomi-token-plan-sgp');
  assert.equal(statSync(f.preferencesPath).mode & 0o777, 0o600);
});

test('PAYG import persists its explicit source without changing other preferences', async t => {
  const f = await fixture(t); f.content('XIAOMI_API_KEY=synthetic-payg');
  writeInferencePreferences(f.preferencesPath, { version: 1, gatewayOrigin: 'https://oms.barestate.xyz', mimoProvider: 'xiaomi-token-plan-cn' });
  await importProviderEnvironment(f.file, f.runtime, f.signal, { preferencesPath: f.preferencesPath });
  assert.equal(readInferencePreferences(f.preferencesPath).mimoProvider, 'xiaomi');
  assert.ok(!readFileSync(f.preferencesPath, 'utf8').includes('synthetic-payg'));
});

test('inference preferences reject unsafe files and invalid persisted policy without overwriting', async t => {
  const f = await fixture(t);
  assert.equal(readInferencePreferences(f.preferencesPath).mimoProvider, null);
  writeFileSync(f.preferencesPath, JSON.stringify({ version: 1, gatewayOrigin: 'https://evil.invalid/path/', mimoProvider: null }), { mode: 0o600 });
  await assert.rejects(async () => readInferencePreferences(f.preferencesPath));
  chmodSync(f.preferencesPath, 0o644);
  await assert.rejects(async () => writeInferencePreferences(f.preferencesPath, { version: 1, gatewayOrigin: 'https://oms.barestate.xyz', mimoProvider: null }));
});

test('both MiMo classes require an explicit source independent of assignment order', async t => {
  const f = await fixture(t);
  f.content('XIAOMI_API_KEY=synthetic-payg\nXIAOMI_MIMO_TP_API_KEY=synthetic-tp');
  const options = { preferencesPath: f.preferencesPath, tokenPlanProvider: 'xiaomi-token-plan-cn' as const };
  await assert.rejects(importProviderEnvironment(f.file, f.runtime, f.signal, options), /routing source explicitly/);
  assert.equal(f.stored.size, 0);
  const result = await importProviderEnvironment(f.file, f.runtime, f.signal, { ...options, interaction: {
    notify() {}, async prompt(p) { return p.message.includes('Both MiMo') ? 'xiaomi' : 'confirm'; },
  } });
  assert.equal(result.status, 'completed');
  assert.equal(f.stored.has('xiaomi-token-plan-cn'), true);
  assert.equal(readInferencePreferences(f.preferencesPath).mimoProvider, 'xiaomi');
});

test('cancellation during an ignoring post-save synchronization stops promptly without claiming rollback', async t => {
  const f = await fixture(t); f.content('OPENAI_API_KEY=synthetic-one\nOPENCODE_API_KEY=synthetic-two');
  const controller = new AbortController();
  let entered!: () => void;
  // ES2023 baseline: Promise.withResolvers is unavailable.
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = importProviderEnvironment(f.file, f.runtime, controller.signal, {
    async flushSettings() { entered(); return new Promise<void>(() => {}); },
  });
  await started;
  controller.abort(Error('synthetic-one'));
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.outcomes.map(value => value.status), ['may_have_saved', 'not_attempted']);
  assert.equal(f.stored.has('openai'), true);
  assert.equal(f.stored.has('opencode'), false);
  assert.ok(!JSON.stringify(result).includes('synthetic-'));
});

test('canonical login that ignores cancellation remains uncertain and cannot start the next import', async t => {
  const f = await fixture(t); f.content('OPENAI_API_KEY=synthetic-one\nOPENCODE_API_KEY=synthetic-two');
  const original = f.runtime.getProvider('openai')!;
  let entered!: () => void;
  let release!: () => void;
  // ES2023 baseline: Promise.withResolvers is unavailable.
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.runtime.registerNativeProvider({ ...original, auth: { ...original.auth, apiKey: {
    ...original.auth.apiKey!,
    async login(interaction) {
      const key = await interaction.prompt({ type: 'secret', message: 'API key' });
      entered();
      await gate;
      return { type: 'api_key', key };
    },
  } } });
  const controller = new AbortController();
  const pending = importProviderEnvironment(f.file, f.runtime, controller.signal);
  await started;
  controller.abort();
  try {
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(result.outcomes.map(value => value.status), ['may_have_saved', 'not_attempted']);
    assert.equal(f.stored.has('opencode'), false);
  } finally { release(); }
});
