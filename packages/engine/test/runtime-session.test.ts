import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { on } from 'node:events';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { acquireTaskLease } from '../src/workspace/index.ts';
import { createHarnessSession, type HarnessSession } from '../src/runtime/session.ts';
import { createHarnessFixture } from '../test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const binary = process.env.SURFPOOL_BINARY;
const image = process.env.OMS_SANDBOX_IMAGE;
const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE ?? image;

test(
  'interactive prompts survive idle lifetime and keep the same conversation and cumulative accounting',
  { timeout: 120_000 },
  async (t) => {
    if (
      (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
      !binary ||
      !image ||
      !forwarderImage
    )
      return;
    const f = await createHarnessFixture({ binary, image, forwarderImage });
    let now = Date.now();
    let harness: HarnessSession | undefined;
    try {
      f.faux.setResponses([fauxAssistantMessage('First turn.'), fauxAssistantMessage('Next turn.')]);
      harness = await createHarnessSession({
        ...f.options,
        executionMode: 'interactive',
        clock: () => now,
        modelRuntime: f.modelRuntime,
        model: f.model,
      });
      const id = harness.session.sessionManager.getSessionId();
      now += 31 * 60_000;
      await harness.session.prompt('hello');
      const used = harness.budget.snapshot().used;
      assert.equal(harness.budget.snapshot().activeOperationId, null);
      now += 31 * 60_000;
      assert.equal(harness.budget.snapshot().remaining.wallClockMs, f.options.caps.wallClockMs);
      await harness.session.prompt('hello again');
      assert.equal(f.faux.state.callCount, 2);
      assert.equal(harness.session.sessionManager.getSessionId(), id);
      assert.ok(harness.budget.snapshot().used.tokens > used.tokens);
      assert.ok(harness.budget.snapshot().used.spendMicroUsd >= used.spendMicroUsd);
      await harness.runCommand('printf usable');
    } finally {
      await harness?.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  },
);

test(
  'interactive tool continuations cannot renew a turn deadline and a later turn keeps the owner usable',
  { timeout: 120_000 },
  async (t) => {
    if (
      (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
      !binary ||
      !image ||
      !forwarderImage
    )
      return;
    const f = await createHarnessFixture({ binary, image, forwarderImage });
    let now = Date.now();
    let harness: HarnessSession | undefined;
    try {
      f.faux.setResponses([fauxAssistantMessage(fauxToolCall('task_status', {}), { stopReason: 'toolUse' })]);
      harness = await createHarnessSession({
        ...f.options,
        executionMode: 'interactive',
        clock: () => now,
        modelRuntime: f.modelRuntime,
        model: f.model,
      });
      const unsubscribe = harness.session.subscribe((event) => {
        if (event.type === 'tool_execution_end') now += f.options.caps.wallClockMs;
      });
      await harness.session.prompt('Read the task status.');
      unsubscribe();
      assert.equal(f.faux.state.callCount, 1, 'the expired continuation never reaches the provider');
      assert.ok(
        harness.session.messages.some((message) => message.role === 'assistant' && message.stopReason === 'error'),
      );
      assert.equal(harness.budget.snapshot().accounting, 'known');
      assert.equal(harness.budget.snapshot().activeOperationId, null);
      f.faux.setResponses([fauxAssistantMessage('The next turn is available.')]);
      await harness.session.prompt('hello after timeout');
      assert.ok(
        harness.session.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.content.some((part) => part.type === 'text' && part.text === 'The next turn is available.'),
        ),
      );
      assert.ok(harness.listProviders().length > 0);
    } finally {
      await harness?.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  },
);

test(
  'operator configures and uses another model without replacing the live session or resetting accounting',
  { timeout: 120_000 },
  async (t) => {
    if (
      (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
      !binary ||
      !image ||
      !forwarderImage
    )
      return;
    const f = await createHarnessFixture({ binary, image, forwarderImage });
    const alternate = createFauxCore({
      api: 'openai-completions',
      provider: 'oms-alternate',
      models: [
        {
          id: 'alternate',
          contextWindow: 4_096,
          maxTokens: 128,
          cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
        },
      ],
    });
    f.modelRuntime.registerProvider('oms-alternate', {
      api: alternate.api,
      baseUrl: 'http://127.0.0.1:1',
      streamSimple: alternate.streamSimple,
      models: alternate.models.map((model) => ({
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
    let harness: HarnessSession | undefined;
    try {
      f.faux.setResponses([fauxAssistantMessage('First model response.')]);
      alternate.setResponses([fauxAssistantMessage('Second model response.')]);
      harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
      const session = harness.session;
      const sessionId = session.sessionManager.getSessionId();
      await session.prompt('Keep this conversation when I select another model.');
      const used = harness.budget.snapshot().used;
      assert.ok(
        harness
          .listModels()
          .some((model) => model.provider === 'oms-alternate' && model.id === 'alternate' && !model.configured),
      );
      assert.ok(
        harness
          .listProviders()
          .some((provider) => provider.id === 'oms-alternate' && provider.apiKey && !provider.configured),
      );
      await assert.rejects(harness.selectModel('oms-alternate', 'alternate'), /configured/i);
      await harness.connectProvider('oms-alternate', 'synthetic-operator-key-no-network');
      await harness.selectModel('oms-alternate', 'alternate');
      assert.ok(
        harness
          .listModels()
          .some((model) => model.provider === 'oms-alternate' && model.id === 'alternate' && model.configured),
      );
      assert.ok(harness.listProviders().some((provider) => provider.id === 'oms-alternate' && provider.configured));
      assert.equal(harness.session, session);
      assert.equal(session.sessionManager.getSessionId(), sessionId);
      assert.equal(harness.budget.snapshot().used.tokens, used.tokens);
      assert.equal(harness.budget.snapshot().used.spendMicroUsd, used.spendMicroUsd);
      await session.prompt('Continue the same conversation.');
      assert.equal(f.faux.state.callCount, 1);
      assert.equal(alternate.state.callCount, 1);
      assert.ok(
        session.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.content.some((part) => part.type === 'text' && part.text === 'First model response.'),
        ),
      );
      assert.ok(harness.budget.snapshot().used.tokens > used.tokens);
      assert.equal(JSON.stringify(session.messages).includes('synthetic-operator-key-no-network'), false);
      assert.equal(
        readFileSync(join(f.base, 'model-auth.json'), 'utf8').includes('synthetic-operator-key-no-network'),
        true,
      );
      assert.equal(statSync(join(f.base, 'model-auth.json')).mode & 0o077, 0);
    } finally {
      await harness?.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  },
);

test(
  'operator model controls reject unsafe credentials, unsupported models and competing or closed mutations without exposing keys',
  { timeout: 120_000 },
  async (t) => {
    if (
      (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
      !binary ||
      !image ||
      !forwarderImage
    )
      return;
    const f = await createHarnessFixture({ binary, image, forwarderImage });
    let harness: HarnessSession | undefined;
    try {
      const provider = f.modelRuntime.getProvider('oms-controlled');
      assert.ok(provider);
      f.modelRuntime.registerNativeProvider({
        ...provider,
        id: 'oms-ambient',
        name: 'Ambient only',
        auth: { apiKey: { name: 'Ambient', resolve: async () => undefined } },
        getModels: () => [{ ...f.model, provider: 'oms-ambient' }],
        getAllModels: () => [{ ...f.model, type: 'chat', provider: 'oms-ambient' }],
      });
      let entered: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let finish: (() => void) | undefined;
      const hold = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const syntheticKey = 'synthetic-key-must-not-appear-in-errors';
      f.modelRuntime.registerNativeProvider({
        ...provider,
        id: 'anthropic',
        name: 'Controlled failure',
        auth: {
          apiKey: {
            name: 'Key',
            async login(interaction) {
              const key = await interaction.prompt({ type: 'secret', message: 'Synthetic key' });
              entered?.();
              await hold;
              throw new Error(`provider included ${key}`, { cause: { key } });
            },
            resolve: async () => undefined,
          },
        },
        getModels: () => [{ ...f.model, provider: 'anthropic' }],
        getAllModels: () => [{ ...f.model, type: 'chat', provider: 'anthropic' }],
      });
      f.modelRuntime.registerNativeProvider({
        ...provider,
        id: 'oms-unpriced',
        name: 'Unknown price',
        getModels: () => [{ ...f.model, provider: 'oms-unpriced', cost: { ...f.model.cost, output: 0 } }],
        getAllModels: () => [
          { ...f.model, type: 'chat', provider: 'oms-unpriced', cost: { ...f.model.cost, output: 0 } },
        ],
      });
      f.modelRuntime.registerNativeProvider({
        ...provider,
        id: 'openai',
        name: 'Controlled synchronization failure',
        auth: {
          apiKey: {
            name: 'Key',
            async login(interaction) {
              return { type: 'api_key', key: await interaction.prompt({ type: 'secret', message: 'Synthetic key' }) };
            },
            async check({ credential }) {
              if (credential?.key) throw new Error('synthetic synchronization failure', { cause: credential });
              return undefined;
            },
            resolve: async () => undefined,
          },
        },
        getModels: () => [{ ...f.model, provider: 'openai' }],
        getAllModels: () => [{ ...f.model, type: 'chat', provider: 'openai' }],
      });
      let closingEntered: (() => void) | undefined;
      const closingStarted = new Promise<void>((resolve) => {
        closingEntered = resolve;
      });
      let releaseLogin: (() => void) | undefined;
      const heldLogin = new Promise<void>((resolve) => {
        releaseLogin = resolve;
      });
      f.modelRuntime.registerNativeProvider({
        ...provider,
        id: 'xai',
        name: 'Cancelled setup',
        auth: {
          apiKey: {
            name: 'Key',
            async login(interaction) {
              const key = await interaction.prompt({ type: 'secret', message: 'Synthetic key' });
              closingEntered?.();
              await heldLogin;
              interaction.signal.throwIfAborted();
              return { type: 'api_key', key };
            },
            resolve: async () => undefined,
          },
        },
        getModels: () => [{ ...f.model, provider: 'xai' }],
        getAllModels: () => [{ ...f.model, type: 'chat', provider: 'xai' }],
      });
      harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
      assert.equal(
        harness.listModels().some((model) => model.provider === 'oms-unpriced'),
        false,
      );
      assert.equal(
        harness.listProviders().some((provider) => provider.id === 'oms-unpriced'),
        false,
      );
      assert.equal(harness.listProviders().find((provider) => provider.id === 'oms-ambient')?.apiKey, false);
      const authPath = join(f.base, 'model-auth.json');
      const authBefore = readFileSync(authPath, 'utf8');
      for (const key of [
        '',
        ' ',
        '!touch synthetic-sentinel',
        '$OMS_KEY',
        '${OMS_KEY}',
        'line\nbreak',
        'escape\u001b',
        'key\u007f',
        'key\u0085',
      ]) {
        await assert.rejects(
          harness.connectProvider('oms-controlled', key),
          (error) =>
            error instanceof Error && (!key.trim() || !error.message.includes(key)) && error.cause === undefined,
        );
      }
      await assert.rejects(harness.connectProvider('unknown-provider', syntheticKey));
      await assert.rejects(harness.connectProvider('oms-ambient', syntheticKey), /API.key/i);
      await assert.rejects(harness.selectModel('oms-unpriced', f.model.id), /supported/i);
      await assert.rejects(harness.selectModel('oms-controlled', 'missing-model'), /supported/i);
      assert.equal(readFileSync(authPath, 'utf8'), authBefore);
      const pending = harness.connectProvider('anthropic', syntheticKey);
      const refused = assert.rejects(
        pending,
        (error) => error instanceof Error && !error.message.includes(syntheticKey) && error.cause === undefined,
      );
      await started;
      await assert.rejects(harness.selectModel(f.model.provider, f.model.id), /finish/i);
      await assert.rejects(harness.connectProvider(f.model.provider, 'another-synthetic-key'), /finish/i);
      finish?.();
      await refused;
      assert.equal(readFileSync(authPath, 'utf8'), authBefore);
      assert.equal(JSON.stringify(harness.session.messages).includes(syntheticKey), false);
      await assert.rejects(
        harness.connectProvider('openai', syntheticKey),
        (error) =>
          error instanceof Error &&
          /may have been saved/.test(error.message) &&
          !error.message.includes(syntheticKey) &&
          error.cause === undefined,
      );
      const savedAuth = readFileSync(authPath, 'utf8');
      assert.equal(JSON.parse(savedAuth)['openai'].key, syntheticKey);
      assert.equal(JSON.stringify(harness.session.messages).includes(syntheticKey), false);
      const closingSetup = harness.connectProvider('xai', syntheticKey);
      const cancelled = assert.rejects(
        closingSetup,
        (error) => error instanceof Error && !error.message.includes(syntheticKey) && error.cause === undefined,
      );
      await closingStarted;
      await harness.close();
      releaseLogin?.();
      await cancelled;
      await assert.rejects(harness.selectModel(f.model.provider, f.model.id));
      await assert.rejects(harness.connectProvider(f.model.provider, syntheticKey));
      assert.equal(readFileSync(authPath, 'utf8'), savedAuth);
    } finally {
      await harness?.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  },
);

test(
  'production Harness edits through the sandbox, closes through real offline verification and resumes its session/accounting',
  { timeout: 120_000 },
  async (t) => {
    if (
      (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
      !binary ||
      !image ||
      !forwarderImage
    )
      return;
    const f = await createHarnessFixture({ binary, image, forwarderImage });
    let harness: HarnessSession | undefined;
    try {
      f.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall('edit', { path: 'amount.mjs', edits: [{ oldText: 'amount = 0', newText: 'amount = 10' }] }),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(fauxToolCall('propose_done', { itemId: 'fixture' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Requested independent verification.'),
      ]);
      harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
      await harness.session.prompt('Change the amount to 10 and propose verification.');
      assert.equal(existsSync(f.extensionSentinel), false);
      assert.equal(
        readFileSync(join(f.task.codeRoot, 'amount.mjs'), 'utf8'),
        'export const amount = 10;\n',
        JSON.stringify(harness.session.messages, null, 2),
      );
      assert.equal(readFileSync(join(f.repo, 'amount.mjs'), 'utf8'), 'export const amount = 0;\n');
      const result = harness.evaluator.read();
      assert.ok(result.ok);
      assert.equal(result.value.items[0]?.status, 'closed');
      assert.equal(result.value.items[0]?.evidence?.mode, 'offline-snapshot');
      const spent = harness.budget.snapshot().used;
      const sessionId = harness.session.sessionManager.getSessionId();
      const history = JSON.stringify(harness.session.messages);
      await harness.close();
      harness = undefined;

      harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model, sessionId });
      assert.equal(harness.session.sessionManager.getSessionId(), sessionId);
      assert.equal(JSON.stringify(harness.session.messages), history);
      assert.equal(harness.budget.snapshot().used.tokens, spent.tokens);
      assert.equal(harness.budget.snapshot().used.spendMicroUsd, spent.spendMicroUsd);
      const tools = harness.session.getActiveToolNames();
      assert.ok(tools.includes('read') && tools.includes('edit') && tools.includes('write') && tools.includes('bash'));
      assert.ok(!tools.some((name) => /sign|secret|confirm|release|exec_host/.test(name)));
    } finally {
      await harness?.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  },
);

test(
  'Harness excludes host prompt discovery and preserves authentication, ownership and cleanup outcomes',
  { timeout: 180_000 },
  async (t) => {
    if (
      (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
      !binary ||
      !image ||
      !forwarderImage
    )
      return;
    const f = await createHarnessFixture({ binary, image, forwarderImage });
    try {
      await t.test('repository append prompts cannot read a host file at startup or reload', async () => {
        const sentinel = 'SYNTHETIC-HOST-PROMPT-MUST-NOT-REACH-MODEL';
        const outside = join(f.base, 'outside-prompt.md');
        const append = join(f.task.codeRoot, '.pi', 'APPEND_SYSTEM.md');
        writeFileSync(outside, sentinel);
        symlinkSync(outside, append);
        const harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
        try {
          assert.equal(harness.session.systemPrompt.includes(sentinel), false);
          await harness.session.reload();
          assert.equal(harness.session.systemPrompt.includes(sentinel), false);
          assert.equal(existsSync(f.extensionSentinel), false);
        } finally {
          await harness.close();
          unlinkSync(append);
        }
      });

      await t.test(
        'reload retains the task lease, working tools and metered admission on the same session',
        async () => {
          const harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
          try {
            const session = harness.session;
            const sessionId = session.sessionManager.getSessionId();
            await session.reload();
            assert.throws(
              () => {
                const competing = acquireTaskLease(f.workspace, f.task.id);
                competing.release();
              },
              { code: 'LEASE_BUSY' },
            );
            f.faux.setResponses([
              fauxAssistantMessage(fauxToolCall('read', { path: 'amount.mjs' }), { stopReason: 'toolUse' }),
              fauxAssistantMessage('Read the sandboxed source after reload.'),
            ]);
            await session.prompt('Read amount.mjs without changing it.');
            assert.equal(harness.session, session);
            assert.equal(session.sessionManager.getSessionId(), sessionId);
            assert.ok(
              session.messages.some(
                (message) =>
                  message.role === 'toolResult' &&
                  message.content.some(
                    (part) => part.type === 'text' && part.text.includes('export const amount = 0;'),
                  ),
              ),
            );
            assert.equal(harness.budget.snapshot().accounting, 'known');
          } finally {
            await harness.close();
          }
        },
      );

      await t.test(
        'offline startup selects configured authentication and restores the saved model without a request',
        async () => {
          const previous = process.env.OPENAI_API_KEY;
          process.env.OPENAI_API_KEY = 'synthetic-environment-key-no-request-permitted';
          const limited = { ...f.options, caps: { ...f.caps, tokens: 1 } };
          let harness: HarnessSession | undefined;
          try {
            harness = await createHarnessSession(limited);
            assert.equal(harness.session.modelRuntime.hasConfiguredAuth('openai'), true);
            assert.ok(harness.session.model);
            const alternatives = harness.session.modelRuntime
              .getAvailableSnapshot()
              .filter((model) => model.provider === 'openai');
            const selected = alternatives.at(-1);
            assert.ok(selected);
            await harness.session.setModel(selected);
            // A real user turn persists the session; the one-token cap refuses any dispatch.
            await harness.session.prompt('Record this admission refusal without sending a provider request.');
            assert.ok(
              harness.session.messages.some(
                (message) => message.role === 'assistant' && message.stopReason === 'error',
              ),
            );
            const sessionId = harness.session.sessionManager.getSessionId();
            assert.equal(harness.budget.snapshot().used.tokens, 0);
            await harness.close();
            harness = undefined;
            harness = await createHarnessSession({ ...limited, sessionId });
            assert.equal(harness.session.model?.provider, selected.provider);
            assert.equal(harness.session.model?.id, selected.id);
            assert.equal(harness.budget.snapshot().used.tokens, 0);
          } finally {
            await harness?.close();
            if (previous === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = previous;
          }
        },
      );

      await t.test('authoritative runtime disposal rejects uncertain cleanup and retains task ownership', async () => {
        const harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
        const abort = harness.session.abort.bind(harness.session);
        harness.session.abort = async () => {
          throw new Error('synthetic cleanup uncertainty');
        };
        try {
          await assert.rejects(harness.runtime.dispose(), /Harness cleanup is uncertain/);
          assert.throws(
            () => {
              const competing = acquireTaskLease(f.workspace, f.task.id);
              competing.release();
            },
            { code: 'LEASE_BUSY' },
          );
        } finally {
          harness.session.abort = abort;
          // This deliberate uncertainty keeps the lease, even after other resources stop.
          await harness.close().catch(() => {});
        }
      });
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  },
);

test(
  'OMS user actions use the sandbox, cancel owned work, and verify without a model dispatch',
  { timeout: 120_000 },
  async (t) => {
    if (
      (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
      !binary ||
      !image ||
      !forwarderImage
    )
      return;
    const f = await createHarnessFixture({ binary, image, forwarderImage });
    const hostSentinel = join(f.base, 'outside-synthetic-state.txt');
    writeFileSync(hostSentinel, 'SYNTHETIC-OUTSIDE-STATE');
    let harness: HarnessSession | undefined;
    try {
      harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
      const cwd = await harness.runCommand('pwd');
      assert.equal(cwd.exitCode, 0);
      assert.equal(cwd.stdout.trim(), '/work');
      const refused = await harness.runCommand(`cat ${JSON.stringify(hostSentinel)}`);
      assert.notEqual(refused.exitCode, 0);
      assert.ok(!refused.stdout.includes('SYNTHETIC-OUTSIDE-STATE'));

      const controller = new AbortController();
      const watcher = watch(f.task.codeRoot);
      const ready = (async () => {
        for await (const [, filename] of on(watcher, 'change', { signal: AbortSignal.timeout(10_000) })) {
          if (String(filename) === 'cancel-ready') return;
        }
      })();
      // The real container stays alive; readiness uses an FS event, not a guessed host delay.
      const running = harness.runCommand("sh -c 'printf ready > /work/cancel-ready; exec sleep 60'", controller.signal);
      try {
        await Promise.race([
          ready,
          running.then((result) => {
            throw new Error(`Cancellation fixture exited before readiness: ${result.exitCode} ${result.stderr}`);
          }),
        ]);
      } finally {
        watcher.close();
      }
      controller.abort();
      const cancelled = await running;
      assert.equal(cancelled.cancelled, true);
      assert.equal(cancelled.exitCode, 130);
      assert.ok(harness.session.messages.some((message) => message.role === 'bashExecution' && message.cancelled));
      unlinkSync(join(f.task.codeRoot, 'cancel-ready'));

      const failed = await harness.verify('fixture');
      assert.equal(failed.itemId, 'fixture');
      assert.equal(failed.result.closed, false);
      assert.equal(failed.result.reason, 'failed');
      await harness.runCommand("printf 'export const amount = 10;\\n' > amount.mjs");
      const passed = await harness.verify('fixture');
      assert.equal(passed.result.closed, true);
      if (passed.result.closed) assert.equal(passed.result.evidence.mode, 'offline-snapshot');
      assert.equal(readFileSync(join(f.repo, 'amount.mjs'), 'utf8'), 'export const amount = 0;\n');
      assert.equal(harness.budget.snapshot().used.tokens, 0);
      await harness.close();
      await assert.rejects(harness.runCommand('pwd'), { name: 'AbortError' });
    } finally {
      await harness?.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  },
);
