import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { parseRunRecord } from '@oms/engine';
import { runHarnessCommand } from '../src/harness.ts';
import { createHarnessFixture } from '../../engine/test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

for (const scenario of ['preflight', 'settled'] as const) {
  test(`headless USD ${scenario} exit preserves truthful accounting and transcript`, { timeout: 120_000 }, async t => {
    const binary = process.env.SURFPOOL_BINARY;
    const image = process.env.OMS_SANDBOX_IMAGE;
    const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE ?? image;
    if (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary }) || !binary || !image || !forwarderImage) return;
    const f = await createHarnessFixture({ binary, image, forwarderImage });
    let calls = 0;
    try {
      f.modelRuntime.registerProvider(f.model.provider, {
        api: f.model.api, apiKey: 'synthetic-fixture-not-a-provider-key', baseUrl: f.model.baseUrl,
        models: [{ type: 'chat', id: f.model.id, name: f.model.name, reasoning: f.model.reasoning,
          input: f.model.input, cost: f.model.cost, contextWindow: f.model.contextWindow, maxTokens: f.model.maxTokens }],
        streamSimple: model => {
          calls++;
          const stream = createAssistantMessageEventStream();
          const message = { ...fauxAssistantMessage('Unable to complete.'), api: model.api,
            provider: model.provider, model: model.id,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 4, cacheRead: 0, cacheWrite: 0, total: 4 } } };
          stream.push({ type: 'done', reason: 'stop', message });
          stream.end(message);
          return stream;
        },
      });
      const jsonOut = join(f.base, 'record.json');
      const code = await runHarnessCommand('run', ['--headless', '--sandbox', 'docker', '--workspace', f.repo,
        '--state-root', join(f.base, 'state'), '--task', f.task.id,
        '--provider', f.model.provider, '--model', f.model.id, '--minutes', '40',
        '--spend-usd', scenario === 'preflight' ? '0.000001' : '4', '--output-tokens', '128',
        '--surfpool-binary', binary, '--json-out', jsonOut], { modelRuntime: f.modelRuntime });
      assert.equal(code, 2);
      const record = parseRunRecord(JSON.parse(readFileSync(jsonOut, 'utf8')));
      assert.equal(record.status, 'capped');
      assert.equal(record.reason, 'capped:usd');
      assert.equal(record.cap, 'usd');
      assert.equal(calls, scenario === 'preflight' ? 0 : 1);
      assert.equal(record.dispatches.length, calls);
      assert.equal(record.settledMicroUsd, scenario === 'preflight' ? 0 : 4_000_000);
      assert.equal(record.accounting, 'known');
      assert.equal(record.heldMicroUsd, 0);
      assert.ok(record.transcriptPath);
      const transcript = readFileSync(record.transcriptPath, 'utf8');
      if (scenario === 'preflight') {
        assert.equal(statSync(record.transcriptPath).mode & 0o777, 0o600);
        assert.deepEqual(JSON.parse(transcript), {
          type: 'headless_exit', runId: record.runId, taskId: f.task.id, status: 'capped',
          reason: 'capped:usd', cap: 'usd', dispatchCount: 0, wallMs: record.wallMs,
        });
        assert.doesNotMatch(transcript, /"role":|"usage":/);
      } else assert.match(transcript, /Unable to complete/);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });
}
