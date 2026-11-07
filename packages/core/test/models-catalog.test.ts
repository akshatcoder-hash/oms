import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_CATALOG, MODEL_POLICY_VERSION, MIMO_BINDINGS, resolveMimoWorker } from '../src/models/catalog.ts';

test('dated immutable catalog binds exact paid models, rates and conservative windows', () => {
  assert.equal(MODEL_POLICY_VERSION, '2026-11-07.1');
  const expected = {
    sol: ['openai', 'gpt-6.1-sol', 2, 10, 0.1, 2.5],
    terra: ['openai', 'gpt-6.1-terra', 1, 5, 0.05, 1.25],
    astra: ['openai', 'gpt-6-astra', 10, 50, 1, 12.5],
    sonnet: ['anthropic', 'claude-sonnet-5-5', 2, 10, 0.1, 2.5],
    opus: ['anthropic', 'claude-opus-5-5', 4, 20, 0.2, 5],
    haiku: ['anthropic', 'claude-haiku-5-5', 0.1, 0.5, 0.01, 0.125],
    'mimo-pro': ['xiaomi', 'mimo-v2.6-pro', 0.435, 0.87, 0.0036, 0],
    'mimo-flash': ['xiaomi', 'mimo-v2.6-flash', 0.14, 0.28, 0.0028, 0],
    'deepseek-pro': ['opencode', 'deepseek-v4-pro', 1.74, 3.48, 0.145, null],
    'deepseek-flash': ['opencode', 'deepseek-v4.1-flash', 0.3, 1.2, 0.006, null],
    grok: ['opencode', 'grok-4.7', 2, 6, 0.5, null],
    'grok-build': ['opencode', 'grok-build-0.1', 1, 2, 0.2, null],
    'muse-spark': ['opencode', 'muse-spark-1.3', 1.25, 4.25, 0.15, null],
    'muse-wonder': ['opencode', 'muse-wonder-1.0', 4, 20, 0.2, null],
  };
  assert.deepEqual(Object.keys(MODEL_CATALOG).sort(), Object.keys(expected).sort());
  for (const worker of Object.values(MODEL_CATALOG)) {
    assert.deepEqual([worker.provider, worker.modelId, worker.cost.input, worker.cost.output,
      worker.cost.cacheRead, worker.cost.cacheWrite], expected[worker.key]);
    assert.ok(worker.effectiveContextWindow <= worker.publishedContextWindow);
    assert.ok(worker.maxOutputTokens > 0);
    assert.equal(worker.verifiedAt, '2026-11-01');
    assert.match(worker.sourceUrl, /^https:\/\//);
    assert.equal(worker.lifecycle, 'active');
    assert.equal(worker.credentialClass, 'payg');
    if (worker.provider === 'openai') {
      assert.equal(worker.effectiveContextWindow, 272_000);
      assert.equal(worker.publishedContextWindow, 1_050_000);
      assert.deepEqual(worker.cachePolicy.writeTtlSeconds, [1800]);
    }
    if (worker.provider === 'opencode') {
      assert.equal(worker.baseUrl, 'https://opencode.ai/inference/openai/v1');
      assert.equal(worker.api, worker.key.startsWith('deepseek') ? 'openai-completions' : 'openai-responses');
      assert.equal(worker.cachePolicy.write, 'unsupported');
    }
  }
  const frozen = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true);
    for (const nested of Object.values(value)) frozen(nested);
  };
  frozen(MODEL_CATALOG);
  frozen(MIMO_BINDINGS);
  assert.equal(Reflect.set(MODEL_CATALOG.sol.cost, 'input', 0), false);
});
test('cache tiers distinguish unsupported writes, documented temporary free writes and long retention', () => {
  assert.deepEqual(MODEL_CATALOG.haiku.cost.tiers, [{ inputTokensAbove: 100_000,
    input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWriteLong: 1 }]);
  assert.equal(MODEL_CATALOG.sonnet.cost.cacheWriteLong, 4);
  assert.equal(MODEL_CATALOG.opus.cost.cacheWriteLong, 8);
  assert.deepEqual(MODEL_CATALOG.grok.cost.tiers, [{ inputTokensAbove: 200_000,
    input: 4, output: 12, cacheRead: 1, cacheWrite: null }]);
  assert.equal(MODEL_CATALOG['mimo-pro'].cachePolicy.write, 'temporary-free');
  assert.equal(MODEL_CATALOG['mimo-flash'].cachePolicy.write, 'temporary-free');
});

test('MiMo requires an explicit local source and never infers a TP region or PAYG fallback', () => {
  assert.throws(() => resolveMimoWorker('mimo-pro', null), /configuration required/i);
  for (const provider of Object.keys(MIMO_BINDINGS) as (keyof typeof MIMO_BINDINGS)[]) {
    const worker = resolveMimoWorker('mimo-pro', provider);
    assert.equal(worker.provider, provider);
    assert.equal(worker.baseUrl, MIMO_BINDINGS[provider].baseUrl);
    assert.deepEqual(worker.cost, MODEL_CATALOG['mimo-pro'].cost);
    assert.equal(worker.credentialClass, provider === 'xiaomi' ? 'payg' : 'token-plan');
    assert.match(MIMO_BINDINGS[provider].admissionDisclosure, /PAYG-equivalent/i);
    assert.equal(Object.isFrozen(worker), true);
  }
});
