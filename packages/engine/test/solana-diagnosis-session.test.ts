import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ToolResultEvent,
  ToolResultEventResult,
} from '@earendil-works/pi-coding-agent';
import { createDiagnosisExtension } from '../src/runtime/solana-diagnosis.ts';
import { createHarnessSession } from '../src/runtime/session.ts';
import { createHarnessFixture } from '../test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const binary = process.env.SURFPOOL_BINARY;
const image = process.env.OMS_SANDBOX_IMAGE;
const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE ?? image;
const PROGRAM = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';

const text = (message: { content: Array<{ type: string; text?: string }> }) =>
  message.content.map((p) => (p.type === 'text' ? p.text : '')).join('');

test('a deployment note is shown once per conversation and again after the conversation is cleared', async () => {
  const event = {
    type: 'tool_result',
    toolName: 'bash',
    toolCallId: 'simulation',
    input: {},
    isError: true,
    content: [
      {
        type: 'text',
        text: 'Transaction simulation failed\nProgram whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc failed: custom program error: 0x7d3',
      },
    ],
  } as ToolResultEvent;
  let handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult> | undefined;
  await createDiagnosisExtension({ codeRoot: '/nonexistent', rpcUrl: 'http://127.0.0.1:0' })({
    on(name: string, registered: unknown) {
      if (name === 'tool_result') handler = registered as typeof handler;
    },
    registerTool() {},
  } as unknown as ExtensionAPI);
  assert.ok(handler);
  let branch: unknown[] = [];
  const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  const run = async (id: string) => {
    const result = await handler!({ ...event, toolCallId: id }, ctx);
    assert.ok(result?.content);
    branch.push({ type: 'message', message: { role: 'toolResult', content: result.content } });
    return text({ content: result.content });
  };
  for (let conversation = 0; conversation < 2; conversation++) {
    assert.match(await run(`first-${conversation}`), /Note for Orca Whirlpools: On existing pools/);
    const second = await run(`second-${conversation}`);
    assert.match(second, /Solana failure diagnosis/);
    assert.doesNotMatch(second, /Note for /);
    branch = [];
  }
});

test('a failing sandbox command with a Solana failure reaches the model as a diagnosis, and raw_output returns the raw log', async (t) => {
  if (
    (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
    !binary ||
    !image ||
    !forwarderImage
  )
    return;
  const f = await createHarnessFixture({ binary, image, forwarderImage });
  const harness = await createHarnessSession({
    ...f.options,
    modelRuntime: f.modelRuntime,
    model: f.model,
    outputMode: 'head-tail',
  });
  try {
    const log = [
      `Program ${PROGRAM} invoke [1]`,
      `Program ${PROGRAM} consumed 900 of 200000 compute units`,
      `Program ${PROGRAM} failed: custom program error: 0x1771`,
      'RAW-MARKER',
    ].join('\\n');
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('bash', { command: `printf '${log}\\n'; exit 1` }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Seen.'),
    ]);
    await harness.session.prompt('Run it.');
    const result = harness.session.messages.find((m) => m.role === 'toolResult' && m.toolName === 'bash');
    assert.ok(result && result.role === 'toolResult' && result.isError);
    const shown = text(result);
    assert.match(shown, /Solana failure diagnosis/);
    assert.match(shown, /custom program error 0x1771 \(6001\)/);
    assert.match(shown, /RAW-MARKER/);
    assert.match(shown, /That is the whole output/);
    const callId = /raw_output call_id=(\S+)/.exec(shown)?.[1];
    assert.ok(callId);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('raw_output', { call_id: callId }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Read.'),
    ]);
    await harness.session.prompt('Read the raw log.');
    const raw = harness.session.messages.find((m) => m.role === 'toolResult' && m.toolName === 'raw_output');
    assert.ok(raw && raw.role === 'toolResult' && !raw.isError);
    assert.match(text(raw), /RAW-MARKER/);
  } finally {
    await harness.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});
