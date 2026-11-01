import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertOwnedContainer, LatestResizeQueue, resolveDockerSocket, TerminalStoppedError, TerminalOutput } from '../src/runtime/task-terminal.ts';

const id = 'a'.repeat(64);
const labels = { 'oms.component': 'sandbox', 'oms.task': 'r01-test', 'oms.execution': 'execution-1', 'oms.phase': 'run' };
const metadata = () => ({ Id: id, Name: '/oms-r01-test-run-uuid', Config: { Labels: { ...labels }, Tty: true, OpenStdin: true }, State: { Running: true } });

test('immutable container identity, exact ownership labels and confirmed running TTY are mandatory', () => {
  assert.doesNotThrow(() => assertOwnedContainer(metadata(), id, labels));
  for (const value of [
    { ...metadata(), Id: 'b'.repeat(64) },
    { ...metadata(), Config: { ...metadata().Config, Labels: { ...labels, 'oms.execution': 'foreign' } } },
    { ...metadata(), State: { Running: false } },
    { ...metadata(), Config: { ...metadata().Config, Tty: false } },
  ]) assert.throws(() => assertOwnedContainer(value, id, labels), /ownership|running|identity|TTY/i);
  assert.throws(() => assertOwnedContainer(metadata(), 'oms-r01-test', labels), /identity|immutable/i);
});

test('Docker endpoint resolution follows CLI context override and DOCKER_HOST, refusing remote transports', async () => {
  const contexts: string[] = [];
  const out = async (args: string[]) => {
    contexts.push(args.join(' '));
    return args[0] === 'context' && args[1] === 'show' ? 'selected\n' : 'unix:///private/test/docker.sock\n';
  };
  assert.equal(await resolveDockerSocket(out, { DOCKER_HOST: 'unix:///host.sock' }), '/host.sock');
  assert.equal(contexts.length, 0);
  assert.equal(await resolveDockerSocket(out, { DOCKER_CONTEXT: 'chosen', DOCKER_HOST: 'tcp://ignored:2375' }), '/private/test/docker.sock');
  assert.match(contexts.pop()!, /context inspect chosen/);
  assert.equal(await resolveDockerSocket(out, {}), '/private/test/docker.sock');
  assert.ok(contexts.some(s => s === 'context show'));
  await assert.rejects(resolveDockerSocket(out, { DOCKER_HOST: 'tcp://remote:2375' }), /unsupported|local Unix/i);
});

test('resize queue retains only latest dimensions, serializes requests and close waits for in-flight resize', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: Array<[number, number]> = [];
  const queue = new LatestResizeQueue(async (columns, rows) => {
    calls.push([columns, rows]);
    if (calls.length === 1) await gate;
  });
  queue.resize(80, 24);
  await Promise.resolve();
  queue.resize(90, 25);
  queue.resize(100, 30);
  queue.resize(110, 40);
  release();
  await queue.idle();
  assert.deepEqual(calls, [[80, 24], [110, 40]]);
  const closing = queue.close();
  assert.throws(() => queue.resize(120, 40), /clos/i);
  await closing;
});

test('resize failure remains observable through close rather than silently succeeding', async () => {
  const queue = new LatestResizeQueue(async () => { throw new Error('daemon resize uncertain'); });
  queue.resize(80, 24);
  await assert.rejects(queue.idle(), /uncertain/);
  await assert.rejects(queue.close(), /uncertain/);
});

test('close refuses new resize immediately but cannot settle before the active request', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queue = new LatestResizeQueue(async () => { await gate; });
  queue.resize(80, 24);
  await Promise.resolve();
  let settled = false;
  const closing = queue.close().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.throws(() => queue.resize(90, 30), /clos/i);
  release();
  await closing;
  assert.equal(settled, true);
});

test('close discards unsent dimensions while joining the already-started resize', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sent: Array<[number, number]> = [];
  const queue = new LatestResizeQueue(async (columns, rows) => {
    sent.push([columns, rows]);
    await gate;
  });
  queue.resize(80, 24);
  await Promise.resolve();
  queue.resize(90, 30);
  queue.resize(100, 40);
  const closing = queue.close();
  release();
  await closing;
  assert.deepEqual(sent, [[80, 24]], 'queued work must not start after close');
});

test('a confirmed stopped terminal reports unapplied resize to idle but is not a cleanup failure', async () => {
  const queue = new LatestResizeQueue(async () => { throw new TerminalStoppedError(); });
  queue.resize(80, 24);
  await assert.rejects(queue.idle(), TerminalStoppedError);
  await queue.close();
  assert.throws(() => queue.resize(90, 30), /clos/i);
});

test('raw output preserves bounded startup bytes and awaits the subscribed parser in order', async () => {
  const failures: unknown[] = [];
  const output = new TerminalOutput(error => { failures.push(error); });
  let received = '';
  let release!: () => void;
  // ES2023 is the declared library baseline.
  const parser = new Promise<void>(resolve => { release = resolve; });
  await output.write(Buffer.from('startup'));
  assert.equal(received, '');
  const unsubscribe = output.subscribe(async bytes => { received += Buffer.from(bytes).toString(); await parser; });
  await Promise.resolve();
  assert.equal(received, 'startup');
  let delivered = false;
  const second = output.write(Buffer.from('next')).then(() => { delivered = true; });
  await Promise.resolve();
  assert.equal(delivered, false);
  release();
  await second;
  assert.equal(received, 'startupnext');
  unsubscribe();
  await assert.rejects(output.write(Buffer.alloc(256 * 1024 + 1)), /limit/i);
  const waiting = output.write(Buffer.from('unsubscribed'));
  output.close();
  await waiting;
  assert.deepEqual(failures, []);
});

test('parser failure on buffered startup bytes is reported even though the pipe already advanced', async () => {
  let failure: unknown;
  const output = new TerminalOutput(error => { failure = error; });
  await output.write(Buffer.from('startup'));
  const expected = new Error('parser refused output');
  output.subscribe(() => { throw expected; });
  await Promise.resolve();
  assert.equal(failure, expected);
  assert.throws(() => output.subscribe(() => {}), /closed/);
});
