import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from '@earendil-works/pi-coding-agent';
import type { RuntimeEnvironment } from '../src/runtime/session-environment.ts';
import { createSessionHooks } from '../src/runtime/session-hooks.ts';
import type { SessionLifecycle } from '../src/runtime/session-lifecycle.ts';
import type { SessionTools } from '../src/runtime/session-tools.ts';
import type { CommonSessionOptions } from '../src/runtime/session-types.ts';
import { CLAUDE_DEPLOYMENT_KNOWLEDGE, CLAUDE_GUIDANCE } from '../src/runtime/system-prompt.ts';

async function beforeStart(contract: boolean) {
  const hooks = createSessionHooks(
    {} as CommonSessionOptions,
    {} as SessionLifecycle,
    { executionMode: 'bounded', ...(contract ? { contract: {} } : {}) } as RuntimeEnvironment,
    { taskRoot: '/work', toolchainSummary: 'ok' } as SessionTools,
  );
  let handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> | undefined;
  await hooks.policy({
    on(name: string, registered: unknown) {
      if (name === 'before_agent_start') handler = registered as typeof handler;
      return () => {};
    },
    registerTool() {},
  } as unknown as ExtensionAPI);
  const before = handler;
  assert.ok(before);
  return async (provider: string | undefined, systemPrompt = hooks.promptFor(undefined)) => {
    const event = {
      type: 'before_agent_start',
      messageType: 'user',
      prompt: 'Complete the selected task',
      systemPrompt,
      systemPromptOptions: { cwd: '/original' },
    } as BeforeAgentStartEvent;
    const result = await before(event, { model: provider ? { provider } : undefined } as ExtensionContext);
    assert.equal(event.systemPromptOptions.cwd, '/work');
    return result?.systemPrompt ?? systemPrompt;
  };
}

for (const contract of [false, true]) {
  for (const provider of ['claude-code', 'anthropic', 'openai', undefined]) {
    test(`capped-work guidance is ${contract && provider === 'claude-code' ? 'present' : 'absent'} for ${provider ?? 'no model'} with contract=${contract}`, async () => {
      const start = await beforeStart(contract);
      const text = await start(provider);
      assert.equal(text.includes('Capped Solana work procedure:'), contract && provider === 'claude-code');
      assert.equal(text.includes('Solana deployment knowledge:'), contract && provider === 'claude-code');
      assert.equal(text.includes('Work that multiplies:'), contract && provider === 'claude-code');
      if (contract && provider === 'claude-code') {
        assert.match(text, /1\. Before the first capped action, write a ledger file/);
        assert.match(text, /at least five candidate families/);
        assert.match(text, /at least one family that repeats across program ids/);
        assert.match(text, /5\. If the cap would run out/);
      }
    });
  }
}

test('capped-work guidance is appended once across turns and follows the current provider', async () => {
  const start = await beforeStart(true);
  const first = await start('claude-code', 'Trusted prompt');
  assert.ok(first.startsWith('Trusted prompt\n\nCapped Solana work procedure:'));
  assert.equal(await start('claude-code', first), first);
  assert.equal(first.split(CLAUDE_DEPLOYMENT_KNOWLEDGE).length - 1, 1);
  assert.equal(await start('claude-code', 'Trusted prompt'), first);
  assert.equal(await start('openai', 'Trusted prompt'), 'Trusted prompt');
  assert.equal(
    await start('claude-code', 'Updated trusted prompt'),
    first.replace('Trusted prompt', 'Updated trusted prompt'),
  );
});

test('each Claude guidance block is appended once when another block is already present', async () => {
  const start = await beforeStart(true);
  for (const existing of CLAUDE_GUIDANCE) {
    const text = await start('claude-code', `Trusted prompt\n\n${existing}`);
    for (const block of CLAUDE_GUIDANCE) assert.equal(text.split(block).length - 1, 1);
    assert.equal(await start('claude-code', text), text);
  }
});
