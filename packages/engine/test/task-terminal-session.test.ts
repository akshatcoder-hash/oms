import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createHarnessSession, type HarnessSession } from '../src/runtime/session.ts';
import { acquireTaskLease } from '../src/workspace/index.ts';
import { createHarnessFixture } from '../test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const binary = process.env.SURFPOOL_BINARY;
const image = process.env.OMS_SANDBOX_IMAGE;
const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE ?? image;

test(
  'one session shares editor, agent and terminal; verification requires explicit stop, restart is explicit and quit releases ownership',
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
    let harness: HarnessSession | undefined;
    try {
      harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
      const session = harness.session;
      const budget = harness.budget;
      const terminal = await harness.startTerminal(80, 24);
      const unsubscribe = terminal.subscribe(() => {});
      assert.equal(await harness.startTerminal(80, 24), terminal, 'presentation changes do not replace terminal');
      const [first, second] = await Promise.all([harness.files.read('amount.mjs'), harness.files.read('package.json')]);
      assert.match(Buffer.from(first.bytes).toString(), /amount = 0/);
      assert.match(Buffer.from(second.bytes).toString(), /module/);
      const cancelledRead = new AbortController();
      cancelledRead.abort(new Error('cancelled before queued execution'));
      await assert.rejects(harness.files.read('amount.mjs', cancelledRead.signal), /cancelled/i);
      assert.equal(
        await harness.startTerminal(80, 24),
        terminal,
        'unstarted helper cancellation must not close the terminal',
      );
      await harness.files.write('amount.mjs', Buffer.from('export const amount = 5;\n'), first.revision);
      f.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall('edit', { path: 'amount.mjs', edits: [{ oldText: 'amount = 5', newText: 'amount = 10' }] }),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Edited in the same running task.'),
      ]);
      await session.prompt('Change amount to 10. Do not verify yet.');
      assert.match(Buffer.from((await harness.files.read('amount.mjs')).bytes).toString(), /amount = 10/);
      assert.equal((await harness.runCommand('printf shared-terminal')).stdout, 'shared-terminal');
      assert.equal(harness.session, session);
      assert.equal(harness.budget, budget);
      assert.equal(await harness.startTerminal(90, 25), terminal);
      await assert.rejects(harness.verify(), /stop terminal before verification/i);
      await assert.rejects(harness.evaluator.evaluate('fixture'), /stop terminal before verification/i);
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall('propose_done', { itemId: 'fixture' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Stop the terminal before requesting verification.'),
      ]);
      await session.prompt('Propose the fixture for verification.');
      assert.ok(
        session.messages.some(
          (message) =>
            message.role === 'toolResult' &&
            message.toolName === 'propose_done' &&
            message.content.some(
              (part) => part.type === 'text' && /stop terminal before verification/i.test(part.text),
            ),
        ),
      );
      await terminal.close();
      unsubscribe();
      const verified = await harness.verify();
      assert.equal(verified.result.closed, true);
      const restarted = await harness.startTerminal(80, 24);
      restarted.subscribe(() => {});
      assert.notEqual(restarted, terminal);
      await harness.close();
      const result = await restarted.exited;
      assert.equal(result.cancelled, true);
      const lease = acquireTaskLease(f.workspace, f.task.id);
      lease.release();
    } finally {
      await harness?.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  },
);
