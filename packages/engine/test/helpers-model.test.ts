import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHelpers } from '../src/runtime/helpers/index.ts';
import { SUBAGENT_PROMPT } from '../src/runtime/helpers/prompt.ts';

function setup(provider: string) {
  const helpers = createHelpers({
    dirs: { personal: '/nonexistent/personal', project: '/nonexistent/project' },
    trust: { yolo: false, allowed: new Set() },
  });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let active = ['read', 'bash', 'agent'];
  helpers.extension({
    registerTool: (tool: never) => tools.push(tool),
    on: (name: string, handler: never) => handlers.set(name, handler),
    getActiveTools: () => active,
    setActiveTools: (next: string[]) => (active = next),
  } as never);
  helpers.bind({
    env: { manager: { getEntries: () => [] } },
    model: { session: { model: { provider } } },
  } as never);
  const start = (model: string, systemPrompt: string) =>
    handlers.get('before_agent_start')!({ systemPrompt, messageType: 'user' }, { model: { provider: model } }) as
      { systemPrompt: string } | undefined;
  return { helpers, tools, start, active: () => active };
}

test('with Claude Code selected the agent tool is not offered, says why, and adds nothing to the prompt', async () => {
  const s = setup('claude-code');
  assert.equal(s.helpers.api.available().ok, false);
  assert.match(JSON.stringify(s.helpers.api.available()), /Helpers need a direct model/);
  assert.equal(s.start('claude-code', 'base'), undefined);
  assert.deepEqual(s.active(), ['read', 'bash']);
  await assert.rejects(s.tools[0]!.execute('call', { agent: 'explore', task: 'x' }), /Helpers need a direct model/);
});

test('with a direct model the tool and its prompt section are offered, once, and removed when Claude Code is chosen', () => {
  const s = setup('xai');
  assert.deepEqual(s.helpers.api.available(), { ok: true });
  const first = s.start('xai', 'base')!;
  assert.ok(first.systemPrompt.startsWith('base') && first.systemPrompt.includes(SUBAGENT_PROMPT));
  assert.equal(s.start('xai', first.systemPrompt), undefined);
  assert.equal(s.start('claude-code', first.systemPrompt)!.systemPrompt, 'base');
  assert.ok(!s.active().includes('agent'));
  const again = s.start('xai', 'base')!;
  assert.ok(again.systemPrompt.includes(SUBAGENT_PROMPT));
  assert.ok(s.active().includes('agent'));
});
