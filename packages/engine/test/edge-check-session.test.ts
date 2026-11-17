import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createHarnessSession } from '../src/runtime/session.ts';
import { createHarnessFixture } from '../test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const binary = process.env.SURFPOOL_BINARY;
const image = process.env.OMS_SANDBOX_IMAGE;
const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE ?? image;
const text = (message: { content: Array<{ type: string; text?: string }> }) =>
  message.content.map((p) => (p.type === 'text' ? p.text : '')).join('');

test(
  'with edgeCheck, a program edit gets the edge-case brief before done, and a client edit closes directly',
  { timeout: 180_000 },
  async (t) => {
    if (
      (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
      !binary ||
      !image ||
      !forwarderImage
    )
      return;
    for (const program of [true, false]) {
      const f = await createHarnessFixture({ binary, image, forwarderImage });
      const harness = await createHarnessSession({
        ...f.options,
        modelRuntime: f.modelRuntime,
        model: f.model,
        edgeCheck: true,
      });
      try {
        f.faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall('edit', { path: 'amount.mjs', edits: [{ oldText: 'amount = 0', newText: 'amount = 10' }] }),
            { stopReason: 'toolUse' },
          ),
          ...(program
            ? [
                fauxAssistantMessage(
                  fauxToolCall('write', { path: 'programs/p/src/lib.rs', content: 'pub fn f() {}\n' }),
                  { stopReason: 'toolUse' },
                ),
                fauxAssistantMessage(fauxToolCall('propose_done', { itemId: 'fixture' }), { stopReason: 'toolUse' }),
                fauxAssistantMessage(fauxToolCall('bash', { command: 'true' }), { stopReason: 'toolUse' }),
              ]
            : []),
          fauxAssistantMessage(fauxToolCall('propose_done', { itemId: 'fixture' }), { stopReason: 'toolUse' }),
          fauxAssistantMessage('Proposed.'),
        ]);
        await harness.session.prompt('Change the amount to 10 and propose verification.');
        const proposals = harness.session.messages.filter(
          (m) => m.role === 'toolResult' && m.toolName === 'propose_done',
        );
        assert.equal(proposals.length, program ? 2 : 1);
        if (program) assert.match(text(proposals[0] as any), /edge-case pass/);
        const state = harness.evaluator.read();
        assert.ok(state.ok);
        assert.equal(state.value.items[0]?.status, 'closed');
        assert.deepEqual(
          { ...harness.edgeCheck!.summary(), ms: 0 },
          program
            ? { triggered: true, turns: 1, ms: 0, result: 'pass' }
            : { triggered: false, turns: 0, ms: 0, result: 'none' },
        );
      } finally {
        await harness.close();
        rmSync(f.base, { recursive: true, force: true });
      }
    }
  },
);
