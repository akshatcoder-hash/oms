import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { runHarnessCommand } from '../src/harness.ts';
import { createHarnessFixture } from '../../engine/test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const binary = process.env.SURFPOOL_BINARY;
const image = process.env.OMS_SANDBOX_IMAGE;
const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE ?? image;

test('headless --edge-check records the edge-case pass summary; without it the record has none', { timeout: 240_000 }, async t => {
  if (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary }) || !binary || !image || !forwarderImage) return;
  const f = await createHarnessFixture({ binary, image, forwarderImage });
  try {
    const run = async (flag: string[], name: string) => {
      f.faux.setResponses([fauxAssistantMessage('Unable to complete.')]);
      const jsonOut = join(f.base, name);
      await runHarnessCommand('run', ['--headless', '--sandbox', 'docker', '--workspace', f.repo, '--state-root', join(f.base, 'state'),
        '--task', f.task.id, '--provider', f.model.provider, '--model', f.model.id, '--minutes', '40', '--spend-usd', '4',
        '--output-tokens', '128', '--surfpool-binary', binary, '--json-out', jsonOut, ...flag], { modelRuntime: f.modelRuntime });
      return JSON.parse(readFileSync(jsonOut, 'utf8'));
    };
    assert.deepEqual((await run(['--edge-check'], 'on.json')).edgeCheck, { triggered: false, turns: 0, ms: 0, result: 'none' });
    assert.equal((await run([], 'off.json')).edgeCheck, undefined);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
