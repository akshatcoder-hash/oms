import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createHarnessFixture } from '../test-support/runtime-fixture.ts';
import { createHarnessSession, type HarnessSession } from '../src/runtime/session.ts';

test(
  'production host session edits managed worktree and closes only through real offline verifier',
  { timeout: 30_000 },
  async () => {
    const f = await createHarnessFixture({
      backend: 'host',
      binary: process.env.SURFPOOL_BINARY ?? join(homedir(), '.local/bin/surfpool'),
      image: '',
      forwarderImage: '',
    });
    let harness: HarnessSession | undefined;
    try {
      f.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall('edit', {
            path: join(f.task.codeRoot, 'amount.mjs'),
            edits: [{ oldText: 'amount = 0', newText: 'amount = 10' }],
          }),
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage(fauxToolCall('propose_done', { itemId: 'fixture' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('Requested independent verification.'),
      ]);
      harness = await createHarnessSession({
        ...f.options,
        hostApprovalPolicy: 'allow',
        modelRuntime: f.modelRuntime,
        model: f.model,
      });
      await harness.session.prompt('Set amount to ten and verify.');
      assert.equal(readFileSync(join(f.task.codeRoot, 'amount.mjs'), 'utf8'), 'export const amount = 10;\n');
      assert.equal(existsSync(f.extensionSentinel), false);
      const result = harness.evaluator.read();
      assert.ok(result.ok);
      assert.equal(result.value.items[0]?.status, 'closed');
      assert.equal(result.value.items[0]?.evidence?.mode, 'offline-snapshot');
      assert.equal(harness.settings.snapshot().executionBackend, 'host');
    } finally {
      await harness?.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  },
);

test('host verifier refuses closure after managed Git control bytes change', { timeout: 30_000 }, async () => {
  const f = await createHarnessFixture({
    backend: 'host',
    binary: process.env.SURFPOOL_BINARY ?? join(homedir(), '.local/bin/surfpool'),
    image: '',
    forwarderImage: '',
  });
  let harness: HarnessSession | undefined;
  try {
    harness = await createHarnessSession({
      ...f.options,
      hostApprovalPolicy: 'allow',
      modelRuntime: f.modelRuntime,
      model: f.model,
    });
    const { writeFileSync } = await import('node:fs');
    const git = join(f.task.codeRoot, '.git');
    writeFileSync(git, readFileSync(git, 'utf8') + '\n');
    await assert.rejects(harness.verify('fixture'), /Git control file changed/);
    const state = harness.evaluator.read();
    assert.ok(state.ok);
    assert.notEqual(state.value.items[0]?.status, 'closed');
  } finally {
    await harness?.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('host verifier rejects a FIFO Git control file without blocking', { timeout: 10_000 }, async () => {
  const f = await createHarnessFixture({
    backend: 'host',
    binary: process.env.SURFPOOL_BINARY ?? join(homedir(), '.local/bin/surfpool'),
    image: '',
    forwarderImage: '',
  });
  let harness: HarnessSession | undefined;
  try {
    harness = await createHarnessSession({
      ...f.options,
      hostApprovalPolicy: 'allow',
      modelRuntime: f.modelRuntime,
      model: f.model,
    });
    const { execFileSync } = await import('node:child_process');
    const git = join(f.task.codeRoot, '.git');
    rmSync(git);
    execFileSync('mkfifo', [git], { env: { PATH: process.env.PATH } });
    await assert.rejects(harness.verify('fixture'), /Invalid managed Git control file/);
  } finally {
    await harness?.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});
