import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';
import { createHarnessFixture } from '../test-support/runtime-fixture.ts';
import { createHarnessSession, type HarnessSession } from '../src/runtime/session.ts';
import { memoryPath, readLessons } from '../../memory/src/store.ts';

test('real offline failure and closure persist one project lesson with no summarizer call', { timeout: 180_000 }, async t => {
  const binary = process.env.SURFPOOL_BINARY;
  const image = process.env.OMS_SANDBOX_IMAGE;
  const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE ?? image;
  if (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary }) || !binary || !image || !forwarderImage) return;
  const f = await createHarnessFixture({ binary, image, forwarderImage });
  const home = join(f.base, 'memory-home');
  const vocabulary = new Set('error assertionerror actual expected incompatible argument types in check the pinned requirements and reproduce passing offline checks earlier independent verification failed'.split(' '));
  let harness: HarnessSession | undefined;
  try {
    harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model,
      localMemory: { home, installSalt: 's'.repeat(32), vocabulary, secretForms: [],
        runtime: { surfpool: '1.7.0', agave: null, rustc: null, node: null },
      } });
    const path = memoryPath(home, f.workspace.root);
    assert.equal((await harness.verify()).result.closed, false);
    assert.deepEqual(readLessons(path), []);
    await harness.runCommand("printf 'export const amount = 10;\\n' > amount.mjs");
    assert.equal((await harness.verify()).result.closed, true);
    const rows = readLessons(path);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tier, 'quarantined');
    assert.equal(rows[0]!.evidence[0]!.mode, 'offline-snapshot');
    await harness.evaluator.evaluate('fixture');
    assert.equal(readLessons(path)[0]!.confirmations.closed, 1);
    assert.equal(f.faux.state.callCount, 0);
  } finally { await harness?.close(); rmSync(f.base, { recursive: true, force: true }); }
});
