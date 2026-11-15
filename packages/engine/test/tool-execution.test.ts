import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from '@earendil-works/pi-ai';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { createHarness } from '../test-support/harness.ts';
import { READ_ONLY_TOOLS, withToolExecutionModes } from '../src/runtime/tool-execution.ts';

const HOLD_MS = 80;

/** Registers the named tools; each records when it started and ended. */
function probes(names: string[]): { extension: ExtensionFactory; spans: Map<string, { start: number; end: number }> } {
  const spans = new Map<string, { start: number; end: number }>();
  const extension: ExtensionFactory = pi => {
    for (const name of names) {
      pi.registerTool({ name, label: name, description: name, parameters: Type.Object({}),
        async execute() {
          const start = performance.now();
          await new Promise(done => setTimeout(done, HOLD_MS));
          spans.set(name, { start, end: performance.now() });
          return { content: [{ type: 'text', text: 'ok' }], details: undefined };
        } });
    }
  };
  return { extension, spans };
}

async function runBatch(names: string[], registered: string[]) {
  const { extension, spans } = probes(registered);
  const h = await createHarness({
    extensions: [withToolExecutionModes(extension)],
    responses: [
      fauxAssistantMessage(names.map(name => fauxToolCall(name, {})), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('done')),
    ],
  });
  try {
    h.session.agent.toolExecution = 'parallel';
    await h.session.prompt('go');
    return names.map(name => spans.get(name)!);
  } finally { h.dispose(); }
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

test('read-only calls in one turn run at the same time', async () => {
  const [first, second] = await runBatch(['task_status', 'toolchain_check'], ['task_status', 'toolchain_check']);
  assert.ok(overlaps(first!, second!), 'the second read-only call started before the first ended');
});

test('a read-only call beside a write, bash or an unlisted tool keeps the whole turn sequential', async () => {
  for (const other of ['write', 'bash', 'propose_done', 'brand_new_tool']) {
    const [status, mutator] = await runBatch(['task_status', other], ['task_status', other]);
    assert.equal(overlaps(status!, mutator!), false, `task_status overlapped ${other}`);
  }
});

test('only tools that read without shared state are parallel', () => {
  for (const name of ['read', 'task_status', 'toolchain_check', 'search_docs', 'api_lookup']) assert.ok(READ_ONLY_TOOLS.has(name), name);
  for (const name of ['write', 'edit', 'bash', 'propose_done', 'deps_fetch', 'web_fetch', 'source_fetch', 'web_search']) assert.equal(READ_ONLY_TOOLS.has(name), false, name);
});
