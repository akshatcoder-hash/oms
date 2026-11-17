import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import {
  createFauxCore,
  fauxAssistantMessage,
  normalizeContext,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { streamSimple as anthropicStreamSimple } from '@earendil-works/pi-ai/api/anthropic-messages';
import { createBudgetLedger } from '@oms/core';
import { createMeteredStream } from '../src/runtime/usage.ts';
import { createDispatchAllocator } from '@oms/core/dispatch';
import {
  createHarnessSettings,
  createHarnessSettingsControls,
  flushHarnessSettings,
} from '../src/runtime/settings-controls.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oms-settings-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  mkdirSync(join(cwd, '.pi'));
  writeFileSync(
    join(cwd, '.pi', 'settings.json'),
    JSON.stringify({
      defaultProvider: 'untrusted',
      defaultModel: 'untrusted',
      steeringMode: 'all',
      followUpMode: 'all',
      defaultThinkingLevel: 'high',
      deviceId: 'untrusted-device',
      extensions: ['./untrusted.ts'],
      packages: ['untrusted-package'],
      enableAnalytics: true,
    }),
  );
  mkdirSync(join(cwd, '.pi', 'extensions'));
  writeFileSync(
    join(cwd, '.pi', 'extensions', 'untrusted.ts'),
    `import {writeFileSync} from 'node:fs'; export default () => writeFileSync(${JSON.stringify(join(root, 'executed'))}, 'must not run');`,
  );
  return { root, agentDir, cwd };
}

test('private canonical settings persist preferences and device identity without adopting project settings', async () => {
  const f = fixture();
  try {
    const first = createHarnessSettings(f.agentDir);
    assert.equal(first.isProjectTrusted(), false);
    assert.deepEqual(first.getProjectSettings(), {});
    first.setDefaultModelAndProvider('synthetic', 'saved-model');
    first.setDefaultThinkingLevel('low');
    first.setSteeringMode('all');
    first.setFollowUpMode('one-at-a-time');
    first.setHttpIdleTimeoutMs(60_000);
    const deviceId = first.getOrCreateDeviceId();
    await flushHarnessSettings(first);
    const second = createHarnessSettings(f.agentDir);
    assert.equal(second.getDefaultProvider(), 'synthetic');
    assert.equal(second.getDefaultModel(), 'saved-model');
    assert.equal(second.getDefaultThinkingLevel(), 'low');
    assert.equal(second.getSteeringMode(), 'all');
    assert.equal(second.getFollowUpMode(), 'one-at-a-time');
    assert.equal(second.getHttpIdleTimeoutMs(), 60_000);
    assert.equal(second.getOrCreateDeviceId(), deviceId);
    assert.notEqual(deviceId, 'untrusted-device');
    assert.equal(statSync(join(f.agentDir, 'settings.json')).mode & 0o077, 0);
    assert.equal(existsSync(join(f.agentDir, 'auth.json')), false);
    assert.equal(readFileSync(join(f.agentDir, 'settings.json'), 'utf8').includes('untrusted'), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('policy remains effective across canonical setters and reload even with unsafe saved preferences', async () => {
  const f = fixture();
  try {
    mkdirSync(f.agentDir, { mode: 0o700 });
    writeFileSync(
      join(f.agentDir, 'settings.json'),
      JSON.stringify({
        compaction: { enabled: true },
        cacheWarming: 'idle',
        retry: { enabled: true, maxRetries: 4, provider: { maxRetries: 8 } },
        transport: 'websocket',
        packages: ['untrusted-package'],
        extensions: ['./untrusted.ts'],
        skills: ['./skill'],
        prompts: ['./prompt'],
        themes: ['./theme'],
        enableInstallTelemetry: true,
        enableAnalytics: true,
        defaultProjectTrust: 'always',
        images: { blockImages: false },
        defaultTools: ['bash'],
        codemode: { mode: 'only' },
      }),
      { mode: 0o600 },
    );
    const manager = createHarnessSettings(f.agentDir);
    const assertPolicy = () => {
      assert.equal(manager.getCompactionEnabled(), false);
      assert.equal(manager.getCacheWarmingMode(), 'off');
      assert.equal(manager.getRetryEnabled(), true);
      assert.equal(manager.getRetrySettings().maxRetries, 3);
      assert.equal(manager.getProviderRetrySettings().maxRetries, 0);
      assert.equal(manager.getTransport(), 'sse');
      assert.equal(manager.getEnableInstallTelemetry(), false);
      assert.equal(manager.getEnableAnalytics(), false);
      assert.equal(manager.getBlockImages(), true);
      assert.equal(manager.getDefaultProjectTrust(), 'never');
      assert.deepEqual(manager.getPackages(), []);
      assert.deepEqual(manager.getExtensionPaths(), []);
      assert.deepEqual(manager.getSkillPaths(), []);
      assert.deepEqual(manager.getPromptTemplatePaths(), []);
      assert.deepEqual(manager.getThemePaths(), []);
      assert.deepEqual(manager.getDefaultTools(), []);
      assert.equal(manager.getSettings().codemode, undefined);
    };
    assertPolicy();
    manager.setSteeringMode('all');
    manager.setDefaultModelAndProvider('synthetic', 'saved-model');
    manager.getOrCreateDeviceId();
    assertPolicy();
    await flushHarnessSettings(manager);
    await manager.reload();
    assertPolicy();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('actual session settings use capability-aware setters, retain queues, and survive a new session without model calls', async () => {
  const f = fixture();
  const sessions: AgentSession[] = [];
  try {
    const faux = createFauxCore({
      api: 'openai-completions',
      provider: 'oms-settings',
      models: [
        {
          id: 'reasoning',
          reasoning: true,
          contextWindow: 4096,
          maxTokens: 128,
          cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
        },
      ],
    });
    const runtime = await ModelRuntime.create({
      authPath: join(f.root, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider('oms-settings', {
      api: faux.api,
      apiKey: 'synthetic-offline',
      baseUrl: 'http://127.0.0.1:1',
      streamSimple: faux.streamSimple,
      models: faux.models.map((model) => ({
        type: 'chat' as const,
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    });
    const settingsManager = createHarnessSettings(f.agentDir);
    const resources = new DefaultResourceLoader({
      cwd: f.cwd,
      agentDir: f.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: [],
      systemPrompt: 'Synthetic settings test.',
    });
    await resources.reload();
    const { session } = await createAgentSession({
      cwd: f.cwd,
      agentDir: f.agentDir,
      modelRuntime: runtime,
      model: runtime.getModel('oms-settings', 'reasoning')!,
      settingsManager,
      resourceLoader: resources,
      sessionManager: SessionManager.inMemory(f.cwd),
      noTools: 'all',
    });
    sessions.push(session);
    await session.bindExtensions({});
    const controls = createHarnessSettingsControls({ session, withUserOperation: (action) => action() });
    await session.steer('preserve steering');
    await session.followUp('preserve followup');
    const model = session.model!;
    const sessionId = session.sessionManager.getSessionId();
    await session.setModel(model, { persist: true });
    await controls.setSteeringMode('all');
    await controls.setFollowUpMode('all');
    await controls.setHttpIdleTimeoutMs(60_000);
    assert.ok(controls.snapshot().availableThinkingLevels.includes('low'));
    await controls.setThinkingLevel('low');
    assert.equal(session.thinkingLevel, 'low');
    assert.equal(session.agent.steeringMode, 'all');
    assert.equal(session.agent.followUpMode, 'all');
    assert.deepEqual(session.getSteeringMessages(), ['preserve steering']);
    assert.deepEqual(session.getFollowUpMessages(), ['preserve followup']);
    assert.equal(session.sessionManager.getSessionId(), sessionId);
    assert.equal(session.model, model);
    assert.equal(faux.state.callCount, 0);
    await assert.rejects(controls.setHttpIdleTimeoutMs(-1), /nonnegative/);
    await session.setModel({ ...model, reasoning: false });
    assert.equal(controls.snapshot().supportsThinking, false);
    assert.deepEqual(controls.snapshot().availableThinkingLevels, []);
    await assert.rejects(controls.setThinkingLevel('low'), /does not support/);
    await session.setModel(model);
    assert.equal(existsSync(join(f.root, 'executed')), false);
    const saved = createHarnessSettings(f.agentDir);
    const restored = await createAgentSession({
      cwd: f.cwd,
      agentDir: f.agentDir,
      modelRuntime: runtime,
      settingsManager: saved,
      resourceLoader: resources,
      sessionManager: SessionManager.inMemory(f.cwd),
      noTools: 'all',
    });
    sessions.push(restored.session);
    await restored.session.bindExtensions({});
    assert.equal(restored.session.model?.id, model.id);
    assert.equal(restored.session.thinkingLevel, 'low');
    assert.equal(restored.session.agent.steeringMode, 'all');
    assert.equal(restored.session.agent.followUpMode, 'all');
    assert.equal(faux.state.callCount, 0);
    faux.setResponses([fauxAssistantMessage('only after explicit prompt')]);
    await restored.session.prompt('explicit synthetic request');
    assert.equal(faux.state.callCount, 1);
  } finally {
    for (const session of sessions) session.dispose();
    rmSync(f.root, { recursive: true, force: true });
  }
});

async function meteredSettingsFixture(wallClockMs = 60_000) {
  const f = fixture();
  const manager = createHarnessSettings(f.agentDir);
  const runtime = await ModelRuntime.create({
    authPath: join(f.root, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const seen: SimpleStreamOptions[] = [];
  runtime.registerProvider('oms-metered-settings', {
    api: 'anthropic-messages',
    apiKey: 'synthetic-offline',
    baseUrl: 'http://127.0.0.1:1',
    models: [
      {
        type: 'chat',
        id: 'synthetic-thinking',
        name: 'Synthetic',
        reasoning: true,
        input: ['text'],
        contextWindow: 32_768,
        maxTokens: 16_384,
        cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
      },
    ],
    streamSimple: (model, context, options) => {
      seen.push(options ?? {});
      return anthropicStreamSimple({ ...model, api: 'anthropic-messages', compat: undefined }, context, options);
    },
  });
  const resources = new DefaultResourceLoader({
    cwd: f.cwd,
    agentDir: f.agentDir,
    settingsManager: manager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: [],
    systemPrompt: 'Synthetic metering test.',
  });
  await resources.reload();
  const { session } = await createAgentSession({
    cwd: f.cwd,
    agentDir: f.agentDir,
    modelRuntime: runtime,
    model: runtime.getModel('oms-metered-settings', 'synthetic-thinking')!,
    settingsManager: manager,
    resourceLoader: resources,
    sessionManager: SessionManager.inMemory(f.cwd),
    noTools: 'all',
  });
  // Isolate request deadline duration from fixture setup and preference persistence time.
  const ledger = createBudgetLedger({
    caps: { tokens: 1_000_000, spendMicroUsd: 10_000_000, wallClockMs },
    clock: () => 0,
    persist: () => {},
  });
  const stream = createMeteredStream({
    streamFunction: session.agent.streamFunction,
    ledger,
    maxOutputTokens: 2048,
    allocate: createDispatchAllocator(),
    logicalTurnId: () => 'settings-request',
  });
  const request = async (fetch: typeof globalThis.fetch) => {
    const source = await stream(
      session.model!,
      normalizeContext({ messages: [{ role: 'user', content: 'synthetic', timestamp: 0 }] }),
      {
        reasoning: session.thinkingLevel === 'off' ? undefined : session.thinkingLevel,
        apiKey: 'synthetic-offline',
        fetch,
      },
    );
    return source.result();
  };
  return {
    ...f,
    session,
    manager,
    ledger,
    seen,
    request,
    controls: createHarnessSettingsControls({ session, withUserOperation: (action) => action() }),
    close: () => {
      session.dispose();
      rmSync(f.root, { recursive: true, force: true });
    },
  };
}

test('metered SDK requests read canonical saved HTTP timeout per request and preserve fresh default thinking', async () => {
  const f = await meteredSettingsFixture();
  try {
    assert.equal(f.session.thinkingLevel, 'medium');
    for (const timeout of [60_000, 0, 25_000]) {
      await f.controls.setHttpIdleTimeoutMs(timeout);
      assert.equal(createHarnessSettings(f.agentDir).getHttpIdleTimeoutMs(), timeout);
      const result = await f.request(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.max_tokens, 2048);
        assert.equal(body.thinking.type, 'enabled');
        const events = [
          {
            type: 'message_start',
            message: {
              id: 'synthetic',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 5 },
          },
          { type: 'message_stop' },
        ];
        return new Response(
          events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      });
      assert.equal(result.stopReason, 'stop');
      assert.equal(f.seen.at(-1)?.timeoutMs, timeout === 0 ? 2_147_483_647 : timeout);
    }
  } finally {
    f.close();
  }
});

test('saved HTTP timeout reaches actual adapter fetch cancellation without waiting for the wall deadline', async () => {
  const f = await meteredSettingsFixture(10_000);
  try {
    await f.controls.setThinkingLevel('off');
    await f.controls.setHttpIdleTimeoutMs(20);
    // Real SDK/platform timer integration: prove its abort signal survives the fetch wrapper.
    // ES2023 is the package baseline, so Promise.withResolvers is unavailable.
    let fetchAborted = false;
    const result = await f.request(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const fallback = setTimeout(() => reject(new Error('synthetic timeout fallback')), 1000);
          init!.signal!.addEventListener(
            'abort',
            () => {
              clearTimeout(fallback);
              fetchAborted = true;
              reject(new Error('synthetic fetch aborted'));
            },
            { once: true },
          );
        }),
    );
    assert.equal(result.stopReason, 'error');
    assert.equal(fetchAborted, true);
    // A timed-out request is a transport failure: settled at its reserved bound, not left unknown.
    assert.equal(f.ledger.snapshot().accounting, 'known');
  } finally {
    f.close();
  }
});

test('disabled saved HTTP timeout does not disable the independent OMS wall deadline', async () => {
  const f = await meteredSettingsFixture(100);
  try {
    await f.controls.setThinkingLevel('off');
    await f.controls.setHttpIdleTimeoutMs(0);
    // Exercise the independent monotonic wall timer against an actual pending adapter request.
    let fetchAborted = false;
    const result = await f.request(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => {
              fetchAborted = true;
              reject(new Error('synthetic fetch aborted'));
            },
            { once: true },
          );
        }),
    );
    assert.equal(result.stopReason, 'aborted');
    assert.equal(fetchAborted, true);
    assert.equal(f.ledger.snapshot().accounting, 'unknown');
  } finally {
    f.close();
  }
});
