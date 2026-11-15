import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createEvaluator, createProposer, EMPTY_SNAPSHOT_DIGEST, type RunnerContext } from '@oms/contract';
import type { RunInSandboxOptions } from '@oms/sandbox';
import { createSurfnet, type Surfnet, type SurfnetOptions } from '@oms/surfnet';
import { createVerifierRunner } from '../src/verifier.ts';
import { createVerifierBackend, type VerifierBackend, type VerifierBackendDependencies } from '../src/runtime/verifier-backend.ts';
import { makeProject } from '../../contract/test-support/fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';
import { exportSnapshot } from '../../surfnet/test-support/snapshot.ts';

const IMAGE = `node@sha256:${'1'.repeat(64)}`;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oms-verifier-backend-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'surfpool');
  writeFileSync(binary, '#!/bin/sh\nexit 1\n');
  chmodSync(binary, 0o700);
  for (const name of ['work', 'leases', 'code']) mkdirSync(join(root, name), { mode: 0o700 });
  const options = { taskName: 'proof-test', binary, image: IMAGE, forwarderImage: IMAGE, workDir: join(root, 'work'), leaseDir: join(root, 'leases'), sourceControlDir: join(root, 'source-control') };
  const starts: SurfnetOptions[] = [];
  const runs: RunInSandboxOptions[] = [];
  let stops = 0;
  let onStart: (options: SurfnetOptions) => Promise<void> = async () => {};
  let onRun: (options: RunInSandboxOptions) => Promise<void> = async () => {};
  let onRpc: () => Promise<unknown> = async () => ({ value: { lamports: 7 } });
  const dependencies: VerifierBackendDependencies = {
    createSurfnet(options): Surfnet {
      starts.push(options);
      let running = false;
      return {
        mode: 'offline-snapshot',
        start: async () => { await onStart(options); running = true; },
        stop: async () => { stops++; running = false; },
        ports: () => running ? { rpc: 18899, ws: 18900 } : undefined,
        rpcUrl: () => running ? 'http://127.0.0.1:18899' : undefined,
        pid: () => running ? 123 : undefined,
        rpc: { url: 'http://127.0.0.1:18899', call: () => onRpc() },
        rewindToStart: async () => { throw new Error('not used'); },
        health: async () => ({ ok: running }),
      };
    },
    async runInSandbox(options) {
      runs.push(options);
      await onRun(options);
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, cancelled: false, truncated: false };
    },
  };
  return { root, options, dependencies, starts, runs, stops: () => stops, onStart: (fn: typeof onStart) => { onStart = fn; }, onRun: (fn: typeof onRun) => { onRun = fn; }, onRpc: (fn: typeof onRpc) => { onRpc = fn; } };
}

test('execution identity derives from binary bytes and immutable images, not caller expectations', async (t) => {
  const f = fixture(t);
  const first = await createVerifierBackend(f.options, f.dependencies);
  const again = await createVerifierBackend(f.options, f.dependencies);
  assert.equal(first.executionIdentity, again.executionIdentity);
  writeFileSync(f.options.binary, '#!/bin/sh\nexit 2\n');
  const changed = await createVerifierBackend(f.options, f.dependencies);
  assert.notEqual(first.executionIdentity, changed.executionIdentity);
  const imageChanged = await createVerifierBackend({ ...f.options, image: `node@sha256:${'2'.repeat(64)}` }, f.dependencies);
  assert.notEqual(changed.executionIdentity, imageChanged.executionIdentity);
  await assert.rejects(first.surfnets.start(undefined), /binary.*changed/i);
  assert.equal(f.starts.length, 0);
  const runner = createVerifierRunner(changed);
  const context = { evaluatorConfig: { executionIdentity: first.executionIdentity } } as RunnerContext;
  await assert.rejects(runner({ id: 'one', title: 'proof', status: 'proposed', reopenCount: 0, done: [] }, context), /execution identity/);
  assert.equal(f.starts.length, 0);
});

test('each offline start consumes its own snapshot bytes and reports their observed digest', async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'code', 'snapshot.json');
  const bytes = '{"account":{"lamports":7}}';
  writeFileSync(path, bytes);
  const backend = await createVerifierBackend(f.options, f.dependencies);
  const session = await backend.surfnets.start(path);
  assert.equal(session.snapshotDigest, hash(bytes));
  assert.equal(session.mode, 'offline-snapshot');
  assert.notEqual(f.starts[0]!.snapshot, path);
  assert.equal(readFileSync(f.starts[0]!.snapshot!, 'utf8'), bytes);
  writeFileSync(path, '{}');
  assert.equal(readFileSync(f.starts[0]!.snapshot!, 'utf8'), bytes);
  await session.stop();
  assert.equal(existsSync(f.starts[0]!.workDir), false);
  const empty = await backend.surfnets.start(undefined);
  assert.equal(empty.snapshotDigest, EMPTY_SNAPSHOT_DIGEST);
  assert.equal(f.starts[1]!.snapshot, undefined);
  await backend.dispose();
  assert.equal(f.stops(), 2);
});

test('verifier mounts only immutable inputs read-only and fresh writable outputs, never build caches', async (t) => {
  const f = fixture(t);
  const backend = await createVerifierBackend(f.options, f.dependencies);
  const session = await backend.surfnets.start(undefined);
  f.onRun(async (options) => {
    assert.equal(options.mounts.projectMount.mode, 'ro');
    assert.equal(options.sourceControlDir, f.options.sourceControlDir);
    assert.equal(options.mounts.projectMount.hostPath, join(f.root, 'code'));
    assert.equal(options.mounts.projectMount.containerPath, '/work');
    assert.deepEqual(options.mounts.volumes, []);
    assert.equal(options.mounts.extraMounts.length, 1);
    const output = options.mounts.extraMounts[0]!;
    assert.equal(output.mode, 'rw');
    assert.equal(output.containerPath, '/output');
    assert.ok(output.hostPath.startsWith(`${f.options.workDir}/`));
    assert.equal(options.cwd, '/work');
    assert.equal(options.env?.OMS_OUTPUT_DIR, '/output');
    assert.equal(options.env?.SOLANA_RPC_URL, `http://host.docker.internal:${session.port}`);
    assert.equal(options.timeoutMs, 1234);
  });
  await backend.sandbox.run(['node', 'verify.js'], { codeRoot: join(f.root, 'code'), surfnetPort: session.port, timeoutMs: 1234 });
  assert.equal(existsSync(f.runs[0]!.mounts.extraMounts[0]!.hostPath), false);
  await backend.dispose();
});

test('locked dependencies and the trusted in-container Surfpool stay read-only beside the writable output', async t => {
  if (process.platform !== 'linux') { t.skip('the in-container Surfpool needs the Linux loader and libraries'); return; }
  const f = fixture(t);
  const dependencies = join(f.root, 'dependencies');
  mkdirSync(join(dependencies, 'node_modules'), { recursive: true });
  writeFileSync(join(dependencies, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const backend = await createVerifierBackend({ ...f.options, dependencies }, f.dependencies);
  const session = await backend.surfnets.start(undefined);
  await backend.sandbox.run(['node', '--test', 'visible.test.ts'], {
    codeRoot: join(f.root, 'code'), surfnetPort: session.port, timeoutMs: 120_000,
  });
  const mounts = f.runs[0]!.mounts.extraMounts;
  const byTarget = new Map(mounts.map(mount => [mount.containerPath, mount]));
  assert.equal(byTarget.get('/work/node_modules')?.hostPath, join(dependencies, 'node_modules'));
  assert.equal(byTarget.get('/work/node_modules')?.mode, 'ro');
  assert.equal(byTarget.get('/trusted/surfpool')?.hostPath, f.options.binary);
  assert.equal(byTarget.get('/trusted/surfpool')?.mode, 'ro');
  for (const path of ['/lib64/ld-linux-x86-64.so.2', '/lib/x86_64-linux-gnu/libc.so.6',
    '/lib/x86_64-linux-gnu/libm.so.6', '/lib/x86_64-linux-gnu/libgcc_s.so.1']) {
    assert.equal(byTarget.get(path)?.hostPath, path);
    assert.equal(byTarget.get(path)?.mode, 'ro');
  }
  assert.equal(byTarget.get('/output')?.mode, 'rw');
  assert.equal(mounts.length, 7);
  assert.deepEqual(f.runs[0]!.mounts.volumes, []);
  await backend.dispose();
});

test('an execution timeout cancels verification without disposing its lifetime owner', async t => {
  const f = fixture(t);
  const owner = new AbortController();
  let operation = new AbortController();
  const backend = await createVerifierBackend({ ...f.options, signal: owner.signal, operationSignal: () => operation.signal }, f.dependencies);
  try {
    const first = await backend.surfnets.start(undefined);
    f.onRun(async options => {
      operation.abort(new Error('execution deadline'));
      assert.equal(options.signal?.aborted, true);
      options.signal!.throwIfAborted();
    });
    await assert.rejects(backend.sandbox.run(['node', 'verify.js'], {
      codeRoot: join(f.root, 'code'), surfnetPort: first.port, timeoutMs: 1234,
    }), /execution deadline/);
    await first.stop();
    assert.equal(owner.signal.aborted, false);
    operation = new AbortController();
    f.onRun(async () => {});
    const second = await backend.surfnets.start(undefined);
    const result = await backend.sandbox.run(['node', 'verify.js'], {
      codeRoot: join(f.root, 'code'), surfnetPort: second.port, timeoutMs: 1234,
    });
    assert.equal(result.exitCode, 0);
    await second.stop();
  } finally { await backend.dispose(); }
});

test('startup failure and modified consumed snapshot clean up the child and temporary directories', async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'code', 'snapshot.json');
  writeFileSync(path, '{}');
  const backend = await createVerifierBackend(f.options, f.dependencies);
  f.onStart(async () => { throw new Error('startup rejected'); });
  await assert.rejects(backend.surfnets.start(path), /startup rejected/);
  assert.equal(f.stops(), 1);
  assert.equal(existsSync(f.starts[0]!.workDir), false);
  f.onStart(async (options) => { chmodSync(options.snapshot!, 0o600); writeFileSync(options.snapshot!, '{"changed":true}'); });
  await assert.rejects(backend.surfnets.start(path), /snapshot.*changed/i);
  assert.equal(f.stops(), 2);
  assert.equal(existsSync(f.starts[1]!.workDir), false);
});

test('invalid paths/images and pre-aborted requests fail before spawning', async (t) => {
  const f = fixture(t);
  await assert.rejects(createVerifierBackend({ ...f.options, binary: join(f.root, 'missing') }, f.dependencies), /ENOENT/);
  await assert.rejects(createVerifierBackend({ ...f.options, image: 'node:latest' }, f.dependencies), /immutable|sha256/);
  const controller = new AbortController();
  controller.abort(new Error('user cancelled'));
  await assert.rejects(createVerifierBackend({ ...f.options, signal: controller.signal }, f.dependencies), /user cancelled/);
  const backend = await createVerifierBackend(f.options, f.dependencies);
  await assert.rejects(backend.surfnets.start(join(f.root, 'missing')), /ENOENT/);
  await assert.rejects(backend.surfnets.start(f.options.workDir), /regular file/);
  assert.equal(f.starts.length, 0);
});

test('cancellation reaches sandbox execution and stops the active process before disposal resolves', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const backend = await createVerifierBackend({ ...f.options, signal: controller.signal }, f.dependencies);
  const session = await backend.surfnets.start(undefined);
  f.onRun(async (options) => {
    assert.equal(options.signal?.aborted, false);
    controller.abort(new Error('cancel proof'));
    assert.equal(options.signal?.aborted, true);
    options.signal!.throwIfAborted();
  });
  await assert.rejects(backend.sandbox.run(['node', 'verify.js'], { codeRoot: join(f.root, 'code'), surfnetPort: session.port, timeoutMs: 1000 }), /cancel proof/);
  await backend.dispose();
  assert.equal(f.stops(), 1);
  assert.equal(existsSync(f.starts[0]!.workDir), false);
  assert.equal(existsSync(f.runs[0]!.mounts.extraMounts[0]!.hostPath), false);
});

test('sandbox setup failures remove outputs and do not let foreign ports or overlapping input roots run', async (t) => {
  const f = fixture(t);
  const backend = await createVerifierBackend(f.options, f.dependencies);
  const session = await backend.surfnets.start(undefined);
  await assert.rejects(backend.sandbox.run(['node'], { codeRoot: join(f.root, 'code'), surfnetPort: 9, timeoutMs: 1000 }), /active.*surfnet/);
  await assert.rejects(backend.sandbox.run(['node'], { codeRoot: f.root, surfnetPort: session.port, timeoutMs: 1000 }), /overlap/);
  f.onRun(async () => { throw new Error('Docker setup failed'); });
  await assert.rejects(backend.sandbox.run(['node'], { codeRoot: join(f.root, 'code'), surfnetPort: session.port, timeoutMs: 1000 }), /Docker setup failed/);
  assert.equal(existsSync(f.runs[0]!.mounts.extraMounts[0]!.hostPath), false);
  await backend.dispose();
});

test('timeout results remain failures and ambiguous sandbox cleanup preserves its outputs for recovery', async (t) => {
  const f = fixture(t);
  const dependencies: VerifierBackendDependencies = {
    ...f.dependencies,
    async runInSandbox(options) {
      f.runs.push(options);
      return { exitCode: 124, stdout: '', stderr: 'timeout', timedOut: true, cancelled: false, truncated: false };
    },
  };
  const backend = await createVerifierBackend(f.options, dependencies);
  const session = await backend.surfnets.start(undefined);
  const result = await backend.sandbox.run(['node'], { codeRoot: join(f.root, 'code'), surfnetPort: session.port, timeoutMs: 1 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  await backend.dispose();

  f.onRun(async () => { throw new AggregateError([new Error('daemon unavailable')], 'sandbox cleanup failed'); });
  const failed = await createVerifierBackend(f.options, f.dependencies);
  const failedSession = await failed.surfnets.start(undefined);
  await assert.rejects(failed.sandbox.run(['node'], { codeRoot: join(f.root, 'code'), surfnetPort: failedSession.port, timeoutMs: 1000 }), /sandbox cleanup failed/);
  assert.equal(existsSync(f.runs[1]!.mounts.extraMounts[0]!.hostPath), true);
  await failed.dispose();
});

test('abort interrupts an outstanding account read rather than waiting for the RPC deadline', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const backend = await createVerifierBackend({ ...f.options, signal: controller.signal }, f.dependencies);
  const session = await backend.surfnets.start(undefined);
  f.onRpc(() => {
    controller.abort(new Error('cancel account read'));
    // ES2023 has no Promise.withResolvers; this models a stalled transport.
    return new Promise(() => {});
  });
  await assert.rejects(session.call('getAccountInfo', ['address']), /cancel account read/);
  await backend.dispose();
  assert.equal(f.stops(), 1);
});

test('real offline verifier closes only after Docker tests and snapshot account evidence pass', { timeout: 120_000 }, async (t) => {
  const binary = process.env.SURFPOOL_BINARY;
  const image = process.env.OMS_SANDBOX_IMAGE;
  const forwarderImage = process.env.OMS_FORWARDER_IMAGE ?? image;
  if (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary }) || !binary || !image || !forwarderImage) return;
  const project = makeProject();
  const workDir = join(project.outside, 'runtime');
  const leaseDir = join(project.outside, 'leases');
  mkdirSync(workDir, { mode: 0o700 });
  mkdirSync(leaseDir, { mode: 0o700 });
  const address = '9jpoP5z8H8u21sSS5etPxS63LL4WXsxVkKsqBBU3c8rL';
  const seed = createSurfnet({ binary, workDir: join(project.outside, 'seed') });
  let backend: VerifierBackend | undefined;
  try {
    await seed.start();
    await seed.rpc.call('surfnet_setAccount', [address, { lamports: 777 }]);
    const snapshot = Buffer.from(await exportSnapshot(seed.rpcUrl()!));
    await seed.stop();
    writeFileSync(join(project.root, '.oms', 'snapshots', 'offline.json'), snapshot);
    writeFileSync(join(project.root, 'tests', 'verifier.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
assert.match(readFileSync('src/main.ts', 'utf8'), /amount = 10/);
assert.throws(() => writeFileSync('src/main.ts', 'mutated'), /EROFS|EACCES/);
writeFileSync(process.env.OMS_OUTPUT_DIR + '/proof.txt', 'writable output');
const response = await fetch(process.env.SOLANA_RPC_URL, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: ['${address}'] }),
});
const account = await response.json();
assert.equal(account.result.value.lamports, 777);
`);
    backend = await createVerifierBackend({ taskName: 'real-verifier', binary, image, forwarderImage, workDir, leaseDir, sourceControlDir: project.roots.sourceControlDir });
    project.config.executionIdentity = backend.executionIdentity;
    project.config.snapshotDigest = hash(snapshot);
    const pin = project.pin({ verifierPaths: ['tests/verifier.mjs'] });
    assert.equal(pin.ok, true, JSON.stringify(pin));
    project.setContract({
      version: 0, template: 'spl-token',
      items: [{
        id: 'real-proof', title: 'actual readonly Docker tests and offline account evidence',
        status: 'active', reopenCount: 0,
        done: [
          { kind: 'tests', command: ['node', 'tests/verifier.mjs'], expect: 'pass' },
          { kind: 'account', address, field: 'lamports', equals: '777' },
        ],
      }],
    });
    const proposer = createProposer({ ...project.roots, pinFile: project.pinFile });
    const evaluator = createEvaluator({ ...project.roots, pinFile: project.pinFile, runner: createVerifierRunner(backend) });
    assert.equal(proposer.propose('real-proof').ok, true);
    const verdict = await evaluator.evaluate('real-proof');
    assert.equal(verdict.closed, true, JSON.stringify(verdict));
    const state = evaluator.read();
    assert.equal(state.ok, true);
    if (state.ok) assert.equal(state.value.items[0]?.status, 'closed');

    project.setContract({
      version: 0, template: 'spl-token',
      items: [{
        id: 'real-failure', title: 'a nonzero test exit cannot close',
        status: 'active', reopenCount: 0,
        done: [{ kind: 'tests', command: ['node', '-e', 'process.exit(9)'], expect: 'pass' }],
      }],
    });
    const failingProposer = createProposer({ ...project.roots, pinFile: project.pinFile });
    const failingEvaluator = createEvaluator({ ...project.roots, pinFile: project.pinFile, runner: createVerifierRunner(backend) });
    assert.equal(failingProposer.propose('real-failure').ok, true);
    const failed = await failingEvaluator.evaluate('real-failure');
    assert.equal(failed.closed, false, JSON.stringify(failed));
    assert.equal('reason' in failed && failed.reason, 'failed', JSON.stringify(failed));
  } finally {
    await seed.stop();
    await backend?.dispose();
    project.cleanup();
  }
});
