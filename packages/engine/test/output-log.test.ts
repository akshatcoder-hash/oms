import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { buildMounts } from '@oms/sandbox';
import { dockerBackend } from '../src/runtime/execution-backend.ts';
import { createSandboxTools } from '../src/runtime/sandbox-tools.ts';
import { createHarnessSession } from '../src/runtime/session.ts';
import { createHarnessFixture } from '../test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const binary = process.env.SURFPOOL_BINARY;
const image = process.env.OMS_SANDBOX_IMAGE;
const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE ?? image;
const HEAD = 32 * 1024,
  TAIL = 96 * 1024,
  CAP = 16 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const command = (script: string) => ['node', '-e', script];
const sh = (argv: string[]) => argv.map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');

function hostLog(id: string): string {
  const matches = readdirSync(tmpdir())
    .filter((name) => name.startsWith('oms-command-logs-'))
    .map((name) => join(tmpdir(), name, id))
    .filter(existsSync);
  assert.equal(matches.length, 1);
  return matches[0]!;
}

async function fixture(t: TestContext, outputMode?: 'head-tail') {
  if (
    (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
    !binary ||
    !image ||
    !forwarderImage
  )
    return;
  const f = await createHarnessFixture({ binary, image, forwarderImage });
  const tools = createSandboxTools({
    taskName: 'output-log',
    mounts: buildMounts({ projectRoot: f.task.codeRoot, taskName: 'output-log', heavyDirs: [] }),
    backend: dockerBackend({ image, forwarderImage }),
    leaseDir: join(f.base, 'leases'),
    sourceControlDir: join(f.base, 'control'),
    surfnetPort: 8899,
    signal: new AbortController().signal,
    outputMode,
  });
  t.after(async () => {
    await tools.dispose();
    rmSync(f.base, { recursive: true, force: true });
  });
  return { ...f, tools };
}

test('default command evidence keeps exact head-only stdout/stderr bytes and no host log', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const result = await f.tools.execute(
    command("process.stdout.write('x'.repeat(200000)); process.stderr.write('y'.repeat(90000))"),
  );
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: 'x'.repeat(128 * 1024),
    stderr: 'y'.repeat(64 * 1024),
    truncated: true,
    timedOut: false,
    cancelled: false,
  });
});

test('opt-in seeded 1MiB output retains exact head/tail and pages the private host stream', async (t) => {
  const f = await fixture(t, 'head-tail');
  if (!f) return;
  const nonce = randomUUID();
  const script = `let s=123456789; const b=Buffer.alloc(1024*1024); for(let i=0;i<b.length;i++){s^=s<<13;s^=s>>>17;s^=s<<5;b[i]=65+((s>>>0)%26)} process.stdout.write('HEAD-${nonce}\\n'); process.stdout.write(b); process.stdout.write('\\nTAIL-${nonce}');`;
  const result = await f.tools.execute(command(script));
  assert.equal(result.exitCode, 0);
  assert.ok(result.logId);
  assert.match(result.logId, /^[a-f0-9-]{36}$/);
  const file = hostLog(result.logId);
  const full = readFileSync(file);
  assert.equal(full.length, 1024 * 1024 + 2 * nonce.length + 12);
  assert.ok(relative(f.task.codeRoot, file).startsWith('..'));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(file, '..')).mode & 0o777, 0o700);
  assert.ok(result.stdout.startsWith(full.subarray(0, HEAD).toString()));
  assert.ok(result.stdout.endsWith(full.subarray(-TAIL).toString()));
  assert.equal(result.stderr, '');
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.includes(`${full.length - HEAD - TAIL} bytes omitted`));
  assert.ok(result.stdout.includes(`read_log`));
  assert.ok(result.stdout.includes(result.logId));
  assert.ok(!result.stdout.includes(file));
  const pages: Buffer[] = [];
  let offset = 0;
  while (offset < full.length) {
    const page = await f.tools.readLog(result.logId, offset, 16_000);
    const bytes = Buffer.from(page.data, 'base64');
    assert.ok(bytes.length <= 16_000 && bytes.length > 0);
    assert.equal(page.offset, offset);
    assert.equal(page.next_offset, offset + bytes.length);
    pages.push(bytes);
    offset = page.next_offset;
  }
  assert.equal(hash(Buffer.concat(pages)), hash(full));
  assert.equal((await f.tools.readLog(result.logId, offset, 1)).eof, true);
  for (const args of [
    ['/etc/passwd', 0, 1],
    ['../' + result.logId, 0, 1],
    [randomUUID(), 0, 1],
    [result.logId, -1, 1],
    [result.logId, 0.5, 1],
    [result.logId, Number.MAX_SAFE_INTEGER + 1, 1],
    [result.logId, full.length + 1, 1],
    [result.logId, 0, 16_001],
    [result.logId, 0, 0],
  ] as const)
    await assert.rejects(async () => f.tools.readLog(...args));
  const peer = await fixture(t, 'head-tail');
  assert.ok(peer);
  await assert.rejects(async () => peer.tools.readLog(result.logId!, 0, 1));
  // File tools must retain their raw protocol even in head/tail sessions.
  await f.tools.files.write('/work/note.txt', Buffer.from('regular task file'));
  assert.equal((await f.tools.files.read('/work/note.txt')).bytes.toString(), 'regular task file');
  await f.tools.dispose();
  assert.equal(existsSync(file), false);
  await assert.rejects(async () => f.tools.readLog(result.logId!, 0, 1));
});

test('session host log storage caps stdout plus stderr at 16MiB without losing the live nonce tail', async (t) => {
  const f = await fixture(t, 'head-tail');
  if (!f) return;
  const nonce = randomUUID();
  const result = await f.tools.execute(
    command(`process.stdout.write(Buffer.alloc(${CAP + 1000},65),()=>process.stderr.write('TAIL-${nonce}'))`),
  );
  assert.ok(result.logId);
  const file = hostLog(result.logId);
  assert.equal(statSync(file).size, CAP);
  assert.ok(result.stdout.endsWith(`TAIL-${nonce}`));
  const page = await f.tools.readLog(result.logId, CAP - 5, 16_000);
  assert.equal(Buffer.from(page.data, 'base64').toString(), 'AAAAA');
  assert.equal(page.captured_bytes, CAP);
  assert.equal(page.total_bytes, CAP + 1000 + 5 + nonce.length);
  assert.equal(page.truncated, true);
  assert.equal(page.eof, true);
  const again = await f.tools.execute(command("process.stdout.write('next command')"));
  assert.ok(again.logId);
  assert.equal(statSync(hostLog(again.logId)).size, 0);
  assert.equal(statSync(file).size, CAP);
  assert.equal((await f.tools.readLog(again.logId, 0, 1)).truncated, true);
});

test('commands in the owned terminal use the same opt-in output and host-log boundary', async (t) => {
  const f = await fixture(t, 'head-tail');
  if (!f) return;
  const terminal = await f.tools.startTerminal(80, 24);
  terminal.subscribe(() => {});
  const nonce = randomUUID();
  const result = await f.tools.execute(command(`process.stdout.write('HEAD\\n'+'a'.repeat(200000)+'TAIL-${nonce}')`));
  assert.ok(result.logId);
  assert.ok(result.stdout.startsWith('HEAD\n'));
  assert.ok(result.stdout.endsWith(`TAIL-${nonce}`));
  assert.equal(
    hash(readFileSync(hostLog(result.logId))),
    hash(Buffer.from('HEAD\n' + 'a'.repeat(200000) + `TAIL-${nonce}`)),
  );
  await terminal.close();
});

test('production model bash bypasses secondary truncation and exposes read_log only when opted in', async (t) => {
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
    const nonce = randomUUID();
    f.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('bash', {
          command: sh(command(`process.stdout.write('HEAD-${nonce}\\n'+'a'.repeat(1024*1024)+'TAIL-${nonce}')`)),
        }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Output captured.'),
    ]);
    await harness.session.prompt('Run the command.');
    const output = harness.session.messages.find((m) => m.role === 'toolResult' && m.toolName === 'bash');
    assert.ok(output && output.role === 'toolResult' && !output.isError);
    const text = output.content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    assert.ok(text.startsWith(`HEAD-${nonce}`));
    assert.ok(text.endsWith(`TAIL-${nonce}`));
    assert.ok(Buffer.byteLength(text) > HEAD + TAIL);
    const id = /read_log.*?([a-f0-9-]{36})/.exec(text)?.[1];
    assert.ok(id, text.slice(HEAD, HEAD + 200));
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('read_log', { id, offset: 0, max_bytes: 100 }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Log read.'),
    ]);
    await harness.session.prompt('Read the first page.');
    const read = harness.session.messages.find((m) => m.role === 'toolResult' && m.toolName === 'read_log');
    assert.ok(read && read.role === 'toolResult' && !read.isError, JSON.stringify(read));
    const page = JSON.parse(
      read.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join(''),
    );
    assert.ok(Buffer.from(page.data, 'base64').toString().startsWith(`HEAD-${nonce}`));
    const file = hostLog(id);
    await harness.close();
    assert.equal(existsSync(file), false);
  } finally {
    await harness.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});
