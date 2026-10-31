import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createDeepRedactor, scanForSecret, secretForms } from '../src/redact/secrets.ts';
import {
  createTraceWriter,
  parseTrace,
  readTraceFile,
  replayTrace,
  type TraceEvent,
} from '../src/trace/trace.ts';

const SECRET = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index));

function workDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'oms-core-trace-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function fixedClock(start = Date.UTC(2025, 9, 29, 1, 2, 3)): () => number {
  let now = start;
  return () => {
    const current = now;
    now += 1000;
    return current;
  };
}

test('writer appends monotonic seq and ISO time from the injected clock', (t) => {
  const dir = workDir(t);
  const path = join(dir, 'trace.jsonl');
  const writer = createTraceWriter({ path, clock: fixedClock() });

  assert.equal(writer.nextSeq, 1);
  assert.deepEqual(writer.append({ type: 'turn', turn: 1, agent: 'lead' }), { ok: true, seq: 1 });
  assert.deepEqual(writer.append({ type: 'tool_call', tool: 'getBalance' }), { ok: true, seq: 2 });
  assert.deepEqual(writer.close(), { ok: true });

  const parsed = readTraceFile(path);
  assert.equal(parsed.issues.length, 0);
  assert.equal(parsed.tornLastLine, null);
  assert.deepEqual(
    parsed.events.map((event) => event.seq),
    [1, 2],
  );
  assert.deepEqual(
    parsed.events.map((event) => event.type),
    ['turn', 'tool_call'],
  );
  const first = parsed.events[0];
  assert.equal(first?.time, '2025-10-29T01:02:03.000Z');
  assert.equal(first?.turn, 1);
  assert.equal(parsed.events[1]?.time, '2025-10-29T01:02:04.000Z');
  assert.ok(Date.parse(String(parsed.events[0]?.time)) > 0);
});

test('writer owns seq and time even if the payload tries to set them', (t) => {
  const dir = workDir(t);
  const path = join(dir, 'trace.jsonl');
  const writer = createTraceWriter({ path, clock: fixedClock() });
  const result = writer.append({ type: 'route', seq: 99, time: '1999-01-01T00:00:00.000Z' });
  writer.close();
  assert.deepEqual(result, { ok: true, seq: 1 });
  const parsed = readTraceFile(path);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0]?.seq, 1);
  assert.notEqual(parsed.events[0]?.time, '1999-01-01T00:00:00.000Z');
});

test('torn last line is reported, not fatal', (t) => {
  const dir = workDir(t);
  const path = join(dir, 'trace.jsonl');
  const writer = createTraceWriter({ path, clock: fixedClock() });
  writer.append({ type: 'turn', turn: 1 });
  writer.append({ type: 'budget', tokens: 10 });
  writer.close();

  const torn = '{"seq":3,"time":"2025-10-29T01:02:0';
  appendFileSync(path, torn);

  const parsed = readTraceFile(path);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.tornLastLine, torn);
  assert.deepEqual(parsed.issues, []);
});

test('strict reader reports bad middle lines and keeps reading', (t) => {
  const dir = workDir(t);
  const path = join(dir, 'trace.jsonl');
  const writer = createTraceWriter({ path, clock: fixedClock() });
  writer.append({ type: 'turn', turn: 1 });
  writer.append({ type: 'turn', turn: 2 });
  writer.close();

  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
  const corrupted = [lines[0], 'not json at all', lines[1]].join('\n') + '\n';
  const parsed = parseTrace(corrupted);
  assert.deepEqual(
    parsed.issues.map((issue) => [issue.line, issue.code]),
    [[2, 'invalid_json']],
  );
  assert.deepEqual(
    parsed.events.map((event) => event.seq),
    [1, 2],
  );
});

test('seq, time, type and shape are validated per line', () => {
  const line = (overrides: Record<string, unknown>): string =>
    JSON.stringify({ seq: 1, time: '2025-10-29T01:02:03.000Z', type: 'turn', ...overrides });
  const cases: Array<{ name: string; raw: string; code: string }> = [
    { name: 'array payload', raw: JSON.stringify([1, 2]), code: 'not_object' },
    { name: 'string payload', raw: JSON.stringify('hello'), code: 'not_object' },
    { name: 'bad seq', raw: line({ seq: 5 }), code: 'bad_seq' },
    { name: 'bad time', raw: line({ time: 'the day before' }), code: 'bad_time' },
    { name: 'bad type', raw: line({ type: 'nope' }), code: 'bad_type' },
  ];
  for (const { name, raw, code } of cases) {
    const parsed = parseTrace(`${raw}\n`);
    assert.deepEqual(
      parsed.issues.map((issue) => issue.code),
      [code],
      name,
    );
    assert.equal(parsed.events.length, 0, name);
  }
});

test('missing trace file is a read error result, not a throw', (t) => {
  const dir = workDir(t);
  const parsed = readTraceFile(join(dir, 'does-not-exist.jsonl'));
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.issues[0]?.code, 'read_error');
});

test('empty trace parses cleanly', () => {
  assert.deepEqual(parseTrace(''), { events: [], issues: [], tornLastLine: null, lineCount: 0 });
});

test('writer never contains a planted secret in any encoding', (t) => {
  const dir = workDir(t);
  const path = join(dir, 'trace.jsonl');
  const forms = secretForms(SECRET);
  assert.ok(forms.length >= 4);
  const redact = createDeepRedactor<TraceEvent>([SECRET]);
  const writer = createTraceWriter({ path, clock: fixedClock(), redact });

  const payloads: Array<Record<string, unknown>> = [
    { hex: forms.find((form) => form.encoding === 'hex')?.text },
    { base58: forms.find((form) => form.encoding === 'base58')?.text },
    { base64: forms.find((form) => form.encoding === 'base64')?.text },
    { base64url: forms.find((form) => form.encoding === 'base64url')?.text },
    { json: `key=${forms.find((form) => form.encoding === 'json_array')?.text ?? ''}` },
    { note: `sign_request payload ${forms.find((form) => form.encoding === 'csv')?.text ?? ''}` },
    { [forms.find((form) => form.encoding === 'base58')?.text ?? 'x']: 'secret in a key' },
    { bytes: Array.from(SECRET) },
    { typed: new Uint8Array(SECRET) },
    { buffer: Buffer.from(SECRET) },
    { serializedBuffer: Buffer.from(SECRET).toJSON() },
  ];
  for (const payload of payloads) writer.append({ type: 'sign_request', ...payload });
  writer.close();

  const contents = readFileSync(path, 'utf8');
  assert.ok(contents.includes('[REDACTED]'), 'redaction must have happened');
  for (const form of forms) {
    assert.equal(contents.includes(form.text), false, `${form.encoding} survived redaction`);
  }
  assert.deepEqual(scanForSecret(contents, SECRET).found, false);
  assert.equal(readTraceFile(path).events.length, payloads.length);
});

test('negative control: without the redactor the scanner finds the secret', (t) => {
  const dir = workDir(t);
  const path = join(dir, 'trace.jsonl');
  const writer = createTraceWriter({ path, clock: fixedClock() });
  const hex = secretForms(SECRET).find((form) => form.encoding === 'hex')?.text ?? '';
  writer.append({ type: 'sign_request', blob: hex });
  writer.close();

  const contents = readFileSync(path, 'utf8');
  const scan = scanForSecret(contents, SECRET);
  assert.equal(scan.found, true);
  assert.ok(scan.hits.some((hit) => hit.encoding === 'hex'));
});

test('writer returns results instead of throwing', (t) => {
  const dir = workDir(t);

  const unwritable = createTraceWriter({ path: join(dir, 'missing-dir', 'trace.jsonl'), clock: fixedClock() });
  const openFailure = unwritable.append({ type: 'turn' });
  assert.equal(openFailure.ok, false);
  assert.equal(openFailure.ok === false ? openFailure.code : '', 'E_OPEN');

  const serializePath = join(dir, 'serialize.jsonl');
  const serializeWriter = createTraceWriter({ path: serializePath, clock: fixedClock() });
  const circular: Record<string, unknown> = { type: 'turn' };
  circular.self = circular;
  const circularResult = serializeWriter.append(circular as never);
  assert.equal(circularResult.ok, false);
  assert.equal(circularResult.ok === false ? circularResult.code : '', 'E_SERIALIZE');

  const bigintResult = serializeWriter.append({ type: 'budget', spend: 1n });
  assert.equal(bigintResult.ok === false ? bigintResult.code : '', 'E_SERIALIZE');
  assert.equal(readFileSync(serializePath, 'utf8'), '', 'nothing may be written for a failed event');

  const afterFailure = serializeWriter.append({ type: 'turn', turn: 1 });
  assert.deepEqual(afterFailure, { ok: true, seq: 1 }, 'seq does not advance on a failed write');
  serializeWriter.close();

  const redactPath = join(dir, 'redact.jsonl');
  const throwingWriter = createTraceWriter({
    path: redactPath,
    clock: fixedClock(),
    redact: () => {
      throw new Error('redactor exploded');
    },
  });
  const redactFailure = throwingWriter.append({ type: 'turn' });
  assert.equal(redactFailure.ok === false ? redactFailure.code : '', 'E_REDACT');
  assert.equal(readFileSync(redactPath, 'utf8'), '');

  const badReturn = createTraceWriter({
    path: redactPath,
    clock: fixedClock(),
    redact: () => null as never,
  });
  assert.equal(badReturn.append({ type: 'turn' }).ok, false);
  assert.equal(readFileSync(redactPath, 'utf8'), '');

  const badClock = createTraceWriter({ path: join(dir, 'clock.jsonl'), clock: () => Number.NaN });
  const clockFailure = badClock.append({ type: 'turn' });
  assert.equal(clockFailure.ok === false ? clockFailure.code : '', 'E_CLOCK');

  const closed = createTraceWriter({ path: join(dir, 'closed.jsonl'), clock: fixedClock() });
  assert.deepEqual(closed.close(), { ok: true });
  const closedResult = closed.append({ type: 'turn' });
  assert.equal(closedResult.ok, false);
  assert.deepEqual(closed.close(), { ok: true }, 'close is idempotent');
});

test('writer rejects an unknown event type without writing', (t) => {
  const dir = workDir(t);
  const path = join(dir, 'trace.jsonl');
  const writer = createTraceWriter({ path, clock: fixedClock() });
  const result = writer.append({ type: 'not_a_type' } as never);
  assert.equal(result.ok, false);
  writer.close();
  assert.equal(readFileSync(path, 'utf8'), '');
});

test('fsync mode still writes parseable lines', (t) => {
  const dir = workDir(t);
  const path = join(dir, 'trace.jsonl');
  const writer = createTraceWriter({ path, clock: fixedClock(), fsync: true });
  writer.append({ type: 'verify', status: 'pass' });
  writer.append({ type: 'settle', action: 'allow' });
  writer.close();
  const parsed = readTraceFile(path);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.issues.length, 0);
});

test('replay iterates the readable prefix, optionally filtered', (t) => {
  const dir = workDir(t);
  const path = join(dir, 'trace.jsonl');
  const writer = createTraceWriter({ path, clock: fixedClock() });
  writer.append({ type: 'turn', turn: 1 });
  writer.append({ type: 'tool_call', tool: 'getBalance' });
  writer.append({ type: 'turn', turn: 2 });
  writer.append({ type: 'cache_bust', segment: 'tool_schemas' });
  writer.close();
  appendFileSync(path, '{"seq":5,"ty');

  const parsed = readTraceFile(path);
  const all = [...replayTrace(parsed)];
  assert.deepEqual(
    all.map((event) => event.seq),
    [1, 2, 3, 4],
  );
  const turns = [...replayTrace(parsed, { types: ['turn'] })];
  assert.deepEqual(
    turns.map((event) => event.turn),
    [1, 2],
  );
  assert.equal(all.every((event) => typeof event.time === 'string'), true);
});

test('same input and clock produce identical bytes', (t) => {
  const dir = workDir(t);
  const events = [
    { type: 'turn' as const, turn: 1, agent: 'lead' },
    { type: 'route' as const, phase: 'plan', toolClass: 'edit', role: 'lead' },
    { type: 'settle' as const, action: 'continue', reason: 'verifier_failed' },
  ];
  const write = (name: string): string => {
    const path = join(dir, name);
    const writer = createTraceWriter({ path, clock: fixedClock() });
    for (const event of events) writer.append(event);
    writer.close();
    return readFileSync(path, 'utf8');
  };
  assert.equal(write('a.jsonl'), write('b.jsonl'));
});

test('close and reopen continues the validated sequence', (t) => {
  const path = join(workDir(t), 'resume.jsonl');
  const first = createTraceWriter({ path, clock: fixedClock() });
  assert.deepEqual(first.append({ type: 'turn' }), { ok: true, seq: 1 });
  first.close();
  const second = createTraceWriter({ path, clock: fixedClock() });
  assert.equal(second.nextSeq, 2);
  assert.deepEqual(second.append({ type: 'budget' }), { ok: true, seq: 2 });
  second.close();
  assert.deepEqual(readTraceFile(path).events.map((event) => event.seq), [1, 2]);
  assert.deepEqual(readTraceFile(path).issues, []);
});

test('reopen refuses torn, unterminated and corrupt tails without truncating data', (t) => {
  for (const tail of [
    '{"seq":2',
    JSON.stringify({ seq: 2, time: '2025-10-29T01:02:03.000Z', type: 'turn' }),
    'unrelated user data\n',
    '{"seq":99,"type":"turn","time":"2025-10-29T01:02:03.000Z"}\n',
  ]) {
    const path = join(workDir(t), 'torn.jsonl');
    const first = createTraceWriter({ path, clock: fixedClock() });
    first.append({ type: 'turn' });
    first.close();
    appendFileSync(path, tail);
    const before = readFileSync(path);
    const writer = createTraceWriter({ path, clock: fixedClock() });
    const result = writer.append({ type: 'turn' });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.code, 'E_OPEN');
    writer.close();
    assert.deepEqual(readFileSync(path), before);
  }
});

test('an unterminated complete JSON record is still a torn final line', () => {
  const line = JSON.stringify({ seq: 1, time: '2025-10-29T01:02:03.000Z', type: 'turn' });
  const parsed = parseTrace(line);
  assert.deepEqual(parsed.events, []);
  assert.equal(parsed.tornLastLine, line);
});

test('redactor cannot corrupt sequence or event metadata', (t) => {
  const writer = createTraceWriter({
    path: join(workDir(t), 'bad-redaction.jsonl'),
    clock: fixedClock(),
    redact: (event) => ({ ...event, seq: 9 }),
  });
  const result = writer.append({ type: 'turn' });
  assert.equal(result.ok, false);
  assert.equal(writer.nextSeq, 1);
  writer.close();
});
