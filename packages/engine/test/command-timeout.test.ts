import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createHarnessSession, type HarnessSession } from '../src/runtime/session.ts';
import { createHarnessFixture } from '../test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const binary = process.env.SURFPOOL_BINARY;
const image = process.env.OMS_SANDBOX_IMAGE;
const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE ?? image;

test('command timeout numeric and caller cases', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks', '--test', '--test-reporter=tap',
    new URL('../test-support/command-timeout-cases.ts', import.meta.url).pathname,
  ], { env, encoding: 'utf8', timeout: 30_000 });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass 8\b/);
  assert.match(result.stdout, /# skipped 0\b/);
});

test('production agent bash completes real Docker sleep 75 with timeout 120 seconds', { timeout: 180_000 }, async t => {
  if (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary }) || !binary || !image || !forwarderImage) return;
  const f = await createHarnessFixture({ binary, image, forwarderImage });
  let harness: HarnessSession | undefined;
  try {
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: 'sleep 75; echo done', timeout: 120 }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Command finished.'),
    ]);
    harness = await createHarnessSession({ ...f.options, caps: { ...f.options.caps, wallClockMs: 180_000 },
      modelRuntime: f.modelRuntime, model: f.model });
    await harness.session.prompt('Run the requested long command.');
    const output = harness.session.messages.find(message => message.role === 'toolResult' && message.toolName === 'bash');
    assert.ok(output && output.role === 'toolResult');
    assert.equal(output.isError, false, JSON.stringify(output));
    assert.ok(output.content.some(part => part.type === 'text' && part.text.trim() === 'done'), JSON.stringify(output));
    process.stdout.write('Docker command exit 0: done\n');
  } finally {
    await harness?.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});
