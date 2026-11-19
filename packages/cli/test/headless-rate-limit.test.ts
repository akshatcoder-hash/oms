import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
} from '@earendil-works/pi-ai';
import { MAX_RATE_LIMIT_RETRIES, parseRunRecord } from '@oms/engine';
import { runHarnessCommand } from '../src/harness.ts';
import { createHarnessFixture } from '../../engine/test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const binary = process.env.SURFPOOL_BINARY;
const image = process.env.OMS_SANDBOX_IMAGE;
const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE ?? image;

const progress = [
  fauxAssistantMessage(fauxToolCall('write', { path: 'amount.mjs', content: 'export const amount = 10;\n' }), {
    stopReason: 'toolUse',
  }),
  fauxAssistantMessage(fauxToolCall('propose_done', { itemId: 'fixture' }), { stopReason: 'toolUse' }),
];

const expected = {
  'is throttled once, then makes progress': {
    throttled: 1,
    body: 'slow down',
    status: 'closed',
    reason: null,
    calls: 1 + progress.length,
    exit: 0,
  },
  'in bench mode stays throttled past the retry cap, then makes progress': {
    bench: true,
    throttled: MAX_RATE_LIMIT_RETRIES + 2,
    body: 'slow down',
    status: 'closed',
    reason: null,
    calls: MAX_RATE_LIMIT_RETRIES + 2 + progress.length,
    exit: 0,
  },
  'stays throttled past every retry': {
    throttled: Infinity,
    body: 'slow down',
    status: 'infra',
    reason: 'rate-limited',
    calls: 1 + MAX_RATE_LIMIT_RETRIES,
    exit: 1,
  },
  'reaches an account usage limit': {
    throttled: Infinity,
    body: JSON.stringify({ type: 'error', error: { type: 'GoUsageLimitError', message: 'Usage limit reached' } }),
    status: 'infra',
    reason: 'usage-limit',
    calls: 1,
    exit: 1,
  },
} as const;

for (const [scenario, want] of Object.entries(expected)) {
  test(`headless run that ${scenario} ends as ${want.reason ?? want.status}`, { timeout: 180_000 }, async (t) => {
    if (
      (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
      !binary ||
      !image ||
      !forwarderImage
    )
      return;
    // The provider endpoint: a real HTTP 429 with Retry-After: 0, so every wait OMS takes is zero.
    let refusals = 0;
    const server = createServer((_request, response) => {
      refusals++;
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' }).end(want.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
    const f = await createHarnessFixture({ binary, image, forwarderImage });
    const jsonOut = join(f.base, 'record.json');
    let calls = 0;
    try {
      f.modelRuntime.registerProvider(f.model.provider, {
        api: f.model.api,
        apiKey: 'synthetic-fixture-not-a-provider-key',
        baseUrl: f.model.baseUrl,
        models: [
          {
            type: 'chat',
            id: f.model.id,
            name: f.model.name,
            reasoning: f.model.reasoning,
            input: f.model.input,
            cost: f.model.cost,
            contextWindow: f.model.contextWindow,
            maxTokens: f.model.maxTokens,
          },
        ],
        streamSimple: (model, _context, options) => {
          const stream = createAssistantMessageEventStream();
          const call = ++calls;
          const stamp = (message: AssistantMessage): AssistantMessage => ({
            ...message,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.01 },
            },
          });
          const fail = (error: unknown) => {
            const message = stamp({ ...fauxAssistantMessage(''), stopReason: 'error', errorMessage: String(error) });
            stream.push({ type: 'error', reason: 'error', error: message });
            stream.end(message);
          };
          void (async () => {
            if (call <= want.throttled) {
              // Like a real adapter: the payload passes OMS's input cap before the one HTTP request it may send.
              await options!.onPayload!({ model: model.id }, model);
              const response = await options!.fetch!(url, { method: 'POST', body: '{}' });
              const message = stamp({
                ...fauxAssistantMessage(''),
                stopReason: 'error',
                errorMessage: `${response.status} ${await response.text()}`,
              });
              stream.push({ type: 'error', reason: 'error', error: message });
              stream.end(message);
              return;
            }
            const message = stamp(progress[call - 1 - refusals]!);
            stream.push({ type: 'done', reason: 'toolUse', message });
            stream.end(message);
          })().catch(fail);
          return stream;
        },
      });
      const exitCode = await runHarnessCommand(
        'run',
        [
          '--headless',
          '--sandbox',
          'docker',
          '--workspace',
          f.repo,
          '--state-root',
          join(f.base, 'state'),
          '--task',
          f.task.id,
          '--provider',
          f.model.provider,
          '--model',
          f.model.id,
          '--minutes',
          '40',
          '--spend-usd',
          '4',
          '--output-tokens',
          '128',
          '--surfpool-binary',
          binary,
          '--json-out',
          jsonOut,
          ...('bench' in want ? ['--retry-rate-limits-until-deadline'] : []),
        ],
        { modelRuntime: f.modelRuntime },
      );
      const record = parseRunRecord(JSON.parse(readFileSync(jsonOut, 'utf8')));
      assert.equal(record.status, want.status, String(record.reason));
      assert.equal(record.reason, want.reason);
      assert.equal(exitCode, want.exit);
      assert.equal(calls, want.calls);
      // Each refusal is its own dispatch, released uncharged: the waits cost wall time, never tokens.
      const outcomes = record.dispatches.map((dispatch) => dispatch.outcome);
      assert.deepEqual(outcomes.slice(0, refusals), Array(refusals).fill('not_dispatched'));
      assert.ok(outcomes.slice(refusals).every((outcome) => outcome === 'known'));
      const assistant = readFileSync(record.transcriptPath!, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === 'message' && entry.message.role === 'assistant');
      // A throttle that clears never reaches the transcript; only the final provider stop does.
      assert.equal(assistant.filter((entry) => entry.message.stopReason === 'error').length, want.reason ? 1 : 0);
    } finally {
      server.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  });
}
