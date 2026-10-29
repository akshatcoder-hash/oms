import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import {
  createDeepRedactor,
  createTraceWriter,
  parseTrace,
  readTraceFile,
  scanForSecrets,
  secretForms,
  type TraceEventInput,
  type TraceWriteResult,
} from '@oms/core';
import { createHarness, type Harness } from '../test-support/harness.ts';
import { createTraceExtension, type TraceSink, type TraceWriteFailure } from '../src/trace-extension.ts';

const temporary: string[] = [];

function tempDir(prefix = 'oms-trace-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

function cleanup(): void {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
}

// A failed assertion must not leave temp dirs behind.
process.on('exit', cleanup);

function transcriptText(h: Harness): string {
  return JSON.stringify(h.session.messages);
}

test('the trace file holds the session in order with monotonic seq', async () => {
  const dir = tempDir();
  const tracePath = join(dir, 'trace.jsonl');
  const writer = createTraceWriter({ path: tracePath, clock: () => 1_700_000_000_000 });

  const h = await createHarness({
    extensions: [createTraceExtension({ writer })],
    responses: [
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo traced-output' })),
      fauxAssistantMessage(fauxText('finished')),
    ],
    tools: ['bash'],
  });
  try {
    await h.session.prompt('run something');
    assert.equal(writer.close().ok, true);
  } finally {
    h.dispose();
  }

  const parsed = readTraceFile(tracePath);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.tornLastLine, null);
  // One turn per model request: the tool-calling turn, then the turn that answers.
  assert.deepEqual(
    parsed.events.map((event) => event.type),
    ['tool_call', 'tool_result', 'turn', 'turn', 'settle'],
  );

  parsed.events.forEach((event, index) => {
    assert.equal(event.seq, index + 1, 'seq is 1-based and contiguous');
    assert.equal(typeof event.time, 'string');
  });

  const call = parsed.events[0];
  const result = parsed.events[1];
  const toolTurn = parsed.events[2];
  const answerTurn = parsed.events[3];
  const settle = parsed.events[4];
  assert.equal(call?.['toolName'], 'bash');
  assert.deepEqual(call?.['input'], { command: 'echo traced-output' });
  assert.equal(result?.['toolName'], 'bash');
  assert.equal(result?.['isError'], false);
  assert.match(JSON.stringify(result?.['content']), /traced-output/);
  assert.equal((result?.['structuredContent'] as Record<string, unknown> | undefined)?.['exit_code'], 0);
  assert.equal(toolTurn?.['turnIndex'], 0);
  assert.deepEqual(toolTurn?.['toolCalls'], ['bash']);
  assert.equal(answerTurn?.['turnIndex'], 1);
  assert.match(String(answerTurn?.['text']), /finished/);
  assert.equal(settle?.['outcome'], 'completed');

  // The same run is readable through the injected clock.
  assert.equal(call?.time, '2023-11-14T22:13:20.000Z');
  cleanup();
});

test('a planted 32-byte secret never reaches the trace file or, with redactModelView, the transcript', async () => {
  const dir = tempDir();
  const secret = Uint8Array.from(randomBytes(32));
  const forms = secretForms(secret);
  const hex = forms.find((form) => form.encoding === 'hex')?.text ?? '';
  const base58 = forms.find((form) => form.encoding === 'base58')?.text ?? '';
  const base64 = forms.find((form) => form.encoding === 'base64')?.text ?? '';
  assert.ok(hex.length === 64 && base58.length > 0 && base64.length > 0);

  const run = async (
    redactModelView: boolean,
    withRedactor = true,
  ): Promise<{ traceText: string; transcript: string }> => {
    const suffix = withRedactor ? (redactModelView ? 'redacted' : 'raw') : 'unredacted';
    const tracePath = join(dir, `trace-${suffix}.jsonl`);
    const writer = createTraceWriter({ path: tracePath, clock: () => 1_700_000_000_000 });
    const h = await createHarness({
      extensions: [
        createTraceExtension({
          writer,
          ...(withRedactor ? { redact: createDeepRedactor([secret]) } : {}),
          redactModelView,
        }),
      ],
      responses: [fauxAssistantMessage(fauxToolCall('read', { path: 'key-material.txt' })), fauxAssistantMessage(fauxText('done'))],
      tools: ['read'],
    });
    try {
      writeFileSync(join(h.cwd, 'key-material.txt'), `hex=${hex}\nbase58=${base58}\nbase64=${base64}\n`);
      await h.session.prompt('read the key file');
      const transcript = transcriptText(h);
      assert.equal(writer.close().ok, true);
      return { traceText: readFileSync(tracePath, 'utf8'), transcript };
    } finally {
      h.dispose();
    }
  };

  const redacted = await run(true);
  assert.deepEqual(scanForSecrets(redacted.traceText, [secret]).hits, [], 'trace leaked the secret');
  assert.deepEqual(scanForSecrets(redacted.transcript, [secret]).hits, [], 'the model saw the secret');
  assert.match(redacted.traceText, /hex=\[REDACTED\]/, 'the tool result was traced and rewritten');
  assert.match(redacted.transcript, /\[REDACTED\]/);

  const raw = await run(false);
  assert.deepEqual(scanForSecrets(raw.traceText, [secret]).hits, [], 'trace leaked the secret without redactModelView');
  assert.match(raw.traceText, /hex=\[REDACTED\]/);
  assert.ok(scanForSecrets(raw.transcript, [secret]).found, 'without the flag the model view is untouched');

  // Negative control: with no redactor at all the same run does leak, so the checks
  // above are not passing because the file simply holds no secret.
  const unredacted = await run(false, false);
  assert.ok(scanForSecrets(unredacted.traceText, [secret]).found, 'the planted secret is really in the tool result');

  cleanup();
});

test('an unwritable trace path does not break the session', async () => {
  const dir = tempDir();
  const failures: TraceWriteFailure[] = [];
  const writer = createTraceWriter({ path: join(dir, 'missing-directory', 'trace.jsonl'), clock: () => 0 });
  assert.equal(writer.append({ type: 'turn' }).ok, false, 'the writer reports the failure as a result');

  const h = await createHarness({
    extensions: [createTraceExtension({ writer, onWriteError: (failure) => failures.push(failure) })],
    responses: [
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo still-running' })),
      fauxAssistantMessage(fauxText('session survived')),
    ],
    tools: ['bash'],
  });
  try {
    await h.session.prompt('go');
    assert.equal(h.faux.state.callCount, 2);
    assert.match(h.session.getLastAssistantText() ?? '', /session survived/);
  } finally {
    h.dispose();
  }
  assert.ok(failures.length > 0);
  assert.equal(failures[0]?.code, 'E_OPEN');
  cleanup();
});

test('a sink that throws does not break the session', async () => {
  const failures: TraceWriteFailure[] = [];
  const throwing: TraceSink = {
    append(_event: TraceEventInput): TraceWriteResult {
      throw new Error('sink exploded');
    },
  };
  const h = await createHarness({
    extensions: [createTraceExtension({ writer: throwing, onWriteError: (failure) => failures.push(failure) })],
    responses: [fauxAssistantMessage(fauxText('no trace needed'))],
  });
  try {
    await h.session.prompt('hi');
    assert.match(h.session.getLastAssistantText() ?? '', /no trace needed/);
  } finally {
    h.dispose();
  }
  assert.ok(failures.length > 0);
  assert.equal(failures[0]?.code, 'E_TRACE');
  assert.match(failures[0]?.message ?? '', /sink exploded/);
});

test('trace events parse strictly even when a redactor is injected', async () => {
  const dir = tempDir();
  const tracePath = join(dir, 'trace.jsonl');
  const writer = createTraceWriter({ path: tracePath, clock: () => 1_700_000_000_000 });
  const h = await createHarness({
    extensions: [createTraceExtension({ writer, redact: createDeepRedactor([new Uint8Array(32).fill(7)]) })],
    responses: [fauxAssistantMessage(fauxText('plain turn'))],
  });
  try {
    await h.session.prompt('go');
    writer.close();
  } finally {
    h.dispose();
  }
  const parsed = parseTrace(readFileSync(tracePath, 'utf8'));
  assert.deepEqual(parsed.issues, []);
  assert.ok(parsed.events.some((event) => event.type === 'turn'));
  cleanup();
});
