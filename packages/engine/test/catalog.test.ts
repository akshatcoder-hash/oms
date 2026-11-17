import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { MODEL_CATALOG, MIMO_BINDINGS } from '@oms/core/catalog';
import { registerOmsCatalog } from '../src/runtime/catalog.ts';

async function runtimeFixture() {
  const credentials: CredentialStore = {
    async read() {
      return undefined;
    },
    async list() {
      return [];
    },
    async modify() {
      throw new Error('catalog registration must not write credentials');
    },
    async delete() {},
  };
  return ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
}

test('trusted overlays preserve every canonical model and auth method while correcting curated bindings', async () => {
  const runtime = await runtimeFixture();
  const originals = new Map(runtime.getProviders().map((provider) => [provider.id, provider]));
  const models = runtime.getModels().map((model) => [model.provider, model.id] as const);
  const classifiers = runtime.getModelsOfType('classifier', 'opencode');
  registerOmsCatalog(runtime);
  for (const [provider, id] of models) assert.ok(runtime.getPhysicalModel(provider, id), `${provider}/${id}`);
  for (const spec of Object.values(MODEL_CATALOG)) {
    const model = runtime.getPhysicalModel(spec.provider, spec.modelId)!;
    assert.ok(model, spec.key);
    assert.equal(model.api, spec.api);
    assert.equal(model.baseUrl, spec.baseUrl);
    assert.equal(model.contextWindow, spec.effectiveContextWindow);
    assert.equal(model.maxTokens, spec.maxOutputTokens);
    assert.equal(model.cost.input, spec.cost.input);
    assert.equal(model.cost.output, spec.cost.output);
    assert.equal(model.reasoning, true);
    const original = originals.get(spec.provider)!;
    const previous = original.getModels().find((entry) => entry.id === spec.modelId);
    if (previous) {
      assert.deepEqual(model.thinkingLevelMap, previous.thinkingLevelMap);
      assert.deepEqual(model.compat, previous.compat);
      assert.deepEqual(model.inputLimits, previous.inputLimits);
    }
  }
  for (const classifier of classifiers) {
    assert.equal(runtime.getModelOfType('classifier', 'opencode', classifier.id)?.baseUrl, classifier.baseUrl);
  }
  const terra = runtime.getPhysicalModel('openai', 'gpt-6.1-terra')!;
  assert.equal(terra.thinkingLevelMap?.off, 'none');
  assert.equal(terra.thinkingLevelMap?.minimal, null);
  assert.ok(terra.compat && 'supportsStrictMode' in terra.compat && terra.compat.supportsStrictMode);
  assert.deepEqual(terra.input, ['text', 'image']);
  const count = runtime.getModels().length;
  registerOmsCatalog(runtime);
  assert.equal(runtime.getModels().length, count);
});

test('catalog overlays cannot replace explicitly registered native provider authentication', async () => {
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      async read() {
        return undefined;
      },
      async list() {
        return [];
      },
      async modify(_id, update) {
        return update(undefined);
      },
      async delete() {},
    },
  });
  const original = runtime.getProvider('openai')!;
  let nativeLogin = false;
  runtime.registerNativeProvider({
    ...original,
    auth: {
      apiKey: {
        ...original.auth.apiKey!,
        async login() {
          nativeLogin = true;
          throw new Error('controlled native login refusal');
        },
      },
    },
  });
  registerOmsCatalog(runtime);
  await assert.rejects(
    runtime.login('openai', 'api_key', {
      async prompt() {
        return 'synthetic';
      },
      notify() {},
    }),
    /controlled native login refusal/,
  );
  assert.equal(nativeLogin, true);
});

test('regional TP models keep canonical subscription authentication and explicit admission prices', async () => {
  const runtime = await runtimeFixture();
  registerOmsCatalog(runtime);
  for (const [provider, binding] of Object.entries(MIMO_BINDINGS)) {
    for (const key of ['mimo-pro', 'mimo-flash'] as const) {
      const model = runtime.getPhysicalModel(provider, MODEL_CATALOG[key].modelId)!;
      assert.equal(model.baseUrl, binding.baseUrl);
      assert.equal(model.cost.input, MODEL_CATALOG[key].cost.input);
      assert.equal(model.cost.output, MODEL_CATALOG[key].cost.output);
    }
  }
});

test('real OpenCode provider wrapper keeps the conversation header and exact corrected transport', async () => {
  const runtime = await runtimeFixture();
  registerOmsCatalog(runtime);
  for (const key of ['grok', 'deepseek-flash'] as const) {
    const model = runtime.getPhysicalModel('opencode', MODEL_CATALOG[key].modelId)!;
    let calls = 0;
    const result = await runtime.completeSimple(
      model,
      { messages: [{ role: 'user', content: 'offline catalog transport probe', timestamp: 0 }] },
      {
        apiKey: 'synthetic-offline-key',
        sessionId: 'catalog-session',
        maxTokens: 16,
        maxRetries: 0,
        fetch: async (url, init) => {
          calls++;
          assert.equal(String(url), `${model.baseUrl}/${key === 'grok' ? 'responses' : 'chat/completions'}`);
          assert.equal(new Headers(init?.headers).get('x-opencode-session'), 'catalog-session');
          assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-offline-key');
          assert.equal(JSON.parse(String(init?.body)).model, model.id);
          return new Response('offline probe complete', { status: 400 });
        },
      },
    );
    assert.equal(result.stopReason, 'error');
    assert.equal(calls, 1);
  }
});
