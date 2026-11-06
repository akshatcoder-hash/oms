import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { acquireMutationLease, inspectMutationLease, stopMutationLeaseOwner, recoverStaleLeaseWithCleanup } from '../src/workspace/index.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'oms-owner-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'mutation.lease');
}

async function owner(t: TestContext, file: string, cooperative: boolean | 'exit-without-cleanup' = true) {
  const module = new URL('../src/workspace/lease.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireMutationLease } from ${JSON.stringify(module)};
    const lease = acquireMutationLease(${JSON.stringify(file)});
    const close = () => { try { lease.release(); } finally { process.exit(0); } };
    process.on('SIGTERM', () => { ${cooperative === 'exit-without-cleanup' ? 'process.exit(0);' : cooperative ? 'close();' : "process.stdout.write('signal\\n');"} });
    process.stdin.on('data', close);
    process.stdout.write('ready\\n');
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end('close');
    await exited;
  });
  while (!output.includes('ready')) {
    await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('owner exited before readiness'); })]);
  }
  return { child, exited, output: () => output };
}

test('inspection reports ownership without signaling or acquiring a live lease', async t => {
  const file = fixture(t);
  const running = await owner(t, file, false);
  const state = inspectMutationLease(file);
  assert.equal(state.status, 'live');
  assert.throws(() => acquireMutationLease(file), { code: 'LEASE_BUSY' });
  assert.equal(running.output(), 'ready\n');
  assert.equal(running.child.exitCode, null);
});

test('a changed token or identity is refused before any stop signal', async t => {
  const file = fixture(t);
  const running = await owner(t, file, false);
  const state = inspectMutationLease(file);
  assert.equal(state.status, 'live');
  if (state.status !== 'live') throw new Error('live fixture required');
  await assert.rejects(stopMutationLeaseOwner(file, { ...state.owner, token: 'old-token' }), { code: 'LEASE_OWNERSHIP_LOST' });
  await assert.rejects(stopMutationLeaseOwner(file, { ...state.owner, start: 'old-start' }), { code: 'LEASE_OWNERSHIP_LOST' });
  assert.equal(running.output(), 'ready\n');
});

test('explicit graceful stop waits for cooperative cleanup without removing the lease itself', async t => {
  const file = fixture(t);
  const running = await owner(t, file);
  const state = inspectMutationLease(file);
  if (state.status !== 'live') throw new Error('live fixture required');
  assert.equal(await stopMutationLeaseOwner(file, state.owner), 'released');
  await running.exited;
  assert.equal(existsSync(file), false);
  acquireMutationLease(file).release();
});

test('process exit without lease release is stale, not verified cleanup', async t => {
  const file = fixture(t);
  const running = await owner(t, file, 'exit-without-cleanup');
  const state = inspectMutationLease(file);
  if (state.status !== 'live') throw new Error('live fixture required');
  assert.equal(await stopMutationLeaseOwner(file, state.owner), 'stale');
  await running.exited;
  assert.equal(existsSync(file), true);
  assert.equal(inspectMutationLease(file).status, 'stale');
});

test('an uncooperative owner times out without escalation and retains its lease', async t => {
  const file = fixture(t);
  const running = await owner(t, file, false);
  const state = inspectMutationLease(file);
  if (state.status !== 'live') throw new Error('live fixture required');
  // This boundary exercises the real process timeout; readiness is observed through its pipe.
  assert.equal(await stopMutationLeaseOwner(file, state.owner, 120), 'timed-out');
  assert.equal(inspectMutationLease(file).status, 'live');
  assert.equal(running.child.exitCode, null);
  assert.equal(running.output().split('signal').length - 1, 1);
});

test('stale, foreign and malformed leases are distinct from released ownership', async t => {
  const file = fixture(t);
  assert.deepEqual(inspectMutationLease(file), { status: 'absent' });
  const lease = acquireMutationLease(file);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  lease.release();
  writeFileSync(file, JSON.stringify({ ...record, start: 'exited-owner' }), { mode: 0o600 });
  const stale = inspectMutationLease(file);
  assert.equal(stale.status, 'stale');
  if (stale.status !== 'stale') throw new Error('stale fixture required');
  assert.equal(await stopMutationLeaseOwner(file, stale.owner), 'stale');
  assert.equal(existsSync(file), true);
  writeFileSync(file, JSON.stringify({ ...record, host: 'not-this-host' }));
  assert.deepEqual(inspectMutationLease(file), { status: 'unverifiable', reason: 'foreign-host' });
  await assert.rejects(stopMutationLeaseOwner(file, record), { code: 'LEASE_UNVERIFIABLE' });
  await assert.rejects(recoverStaleLeaseWithCleanup(file, { ...record, host: 'not-this-host' }, async () => assert.fail('foreign cleanup')), { code: 'LEASE_UNVERIFIABLE' });
  writeFileSync(file, '{}');
  assert.deepEqual(inspectMutationLease(file), { status: 'unverifiable', reason: 'invalid-owner' });
  await assert.rejects(recoverStaleLeaseWithCleanup(file, record, async () => assert.fail('malformed cleanup')), { code: 'LEASE_UNVERIFIABLE' });
});

test('an in-progress recovery is never presented as safely available', t => {
  const file = fixture(t);
  const recovery = acquireMutationLease(`${file}.recovery`);
  try { assert.deepEqual(inspectMutationLease(file), { status: 'unverifiable', reason: 'recovery-in-progress' }); }
  finally { recovery.release(); }
});

test('stale recovery holds exclusion through cleanup and revalidates the exact owner', async t => {
  const file = fixture(t);
  const running = await owner(t, file, 'exit-without-cleanup');
  const state = inspectMutationLease(file);
  if (state.status !== 'live') throw new Error('live fixture required');
  running.child.kill('SIGTERM');
  await running.exited;
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  const finish = deferred();
  const entered = deferred();
  const pending = recoverStaleLeaseWithCleanup(file, state.owner, async assertOwner => {
    assertOwner();
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  assert.throws(() => acquireMutationLease(file), { code: 'LEASE_BUSY' });
  await assert.rejects(recoverStaleLeaseWithCleanup(file, state.owner, async () => assert.fail('competing cleanup')), { code: 'LEASE_BUSY' });
  writeFileSync(file, JSON.stringify({ ...state.owner, token: 'replacement' }));
  finish.resolve();
  await assert.rejects(pending, { code: 'LEASE_OWNERSHIP_LOST' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, 'replacement');
});

test('recovery cannot clean live, foreign, changed or malformed ownership', async t => {
  const file = fixture(t);
  const running = await owner(t, file, false);
  const state = inspectMutationLease(file);
  if (state.status !== 'live') throw new Error('live fixture required');
  const cleanup = async () => assert.fail('unsafe cleanup');
  await assert.rejects(recoverStaleLeaseWithCleanup(file, state.owner, cleanup), { code: 'LEASE_BUSY' });
  await assert.rejects(recoverStaleLeaseWithCleanup(file, { ...state.owner, token: 'old' }, cleanup), { code: 'LEASE_OWNERSHIP_LOST' });
  assert.equal(running.output(), 'ready\n');
});
