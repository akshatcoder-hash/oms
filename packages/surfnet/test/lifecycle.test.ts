import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createSurfnet } from '../src/manager.ts';
import { spawnSurfpool } from '../src/process.ts';

// Protocol fixture for lifecycle tests only; not evidence of Surfpool semantics.
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oms-surfnet-lifecycle-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'rpc-child');
  writeFileSync(binary, `#!${process.execPath}
const http = require('node:http');
const fs = require('node:fs');
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const accounts = args.includes('--snapshot') ? JSON.parse(fs.readFileSync(value('--snapshot'), 'utf8')) : {};
http.createServer(async (req, res) => {
  let text = ''; for await (const part of req) text += part;
  const { method, params = [], id } = JSON.parse(text);
  let result = 'ok';
  if (method === 'getAccountInfo') result = { value: accounts[params[0]] ?? null };
  if (method === 'surfnet_setAccount') { accounts[params[0]] = params[1]; result = null; }
  if (method === 'surfnet_exportSnapshot') result = { value: accounts };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}).listen(Number(value('--port')), '127.0.0.1');
`);
  chmodSync(binary, 0o700);
  const workDir = join(root, 'work');
  mkdirSync(workDir);
  return { root, binary, workDir };
}

test('missing binary emits a handled startup failure even without a child pid', async (t) => {
  const f = fixture(t);
  const child = spawnSurfpool({ binary: join(f.root, 'missing'), rpcPort: 18899, wsPort: 18900, logFile: join(f.root, 'spawn.log'), startTimeoutMs: 500, pollIntervalMs: 5 });
  t.after(() => child.stop());
  await assert.rejects(child.waitUntilHealthy(), /ENOENT|exited before becoming healthy/);
  assert.equal(child.exited(), true);
  assert.deepEqual(await child.waitExited(), { code: -1, signal: null });
});

test('manager rejects missing binary/snapshot before allocating ports and clears stopped ports', async (t) => {
  const f = fixture(t);
  const missing = createSurfnet({ binary: join(f.root, 'missing'), workDir: f.workDir });
  await assert.rejects(missing.start(), /ENOENT/);
  assert.equal(missing.ports(), undefined);
  assert.equal(missing.pid(), undefined);
  const absentSnapshot = createSurfnet({ binary: f.binary, workDir: f.workDir, snapshot: join(f.root, 'missing.json') });
  await assert.rejects(absentSnapshot.start(), /ENOENT/);
  assert.equal(absentSnapshot.ports(), undefined);
  const surf = createSurfnet({ binary: f.binary, workDir: f.workDir });
  t.after(() => surf.stop());
  await surf.start();
  await surf.stop();
  assert.equal(surf.ports(), undefined);
  assert.equal(surf.rpcUrl(), undefined);
});

test('recovery before the first checkpoint reloads the verified original snapshot', async (t) => {
  const f = fixture(t);
  const snapshot = join(f.root, 'original.json');
  writeFileSync(snapshot, JSON.stringify({ seeded: { lamports: 7 } }));
  let exited!: () => void;
  const exit = new Promise<void>(resolve => { exited = resolve; });
  const surf = createSurfnet({ binary: f.binary, workDir: f.workDir, snapshot, onExit: () => exited() });
  t.after(() => surf.stop());
  await surf.start();
  await surf.restoreAccounts([{ address: 'seeded', lamports: 99 }]);
  process.kill(surf.pid()!, 'SIGKILL');
  await exit;
  const recovery = await surf.ensureAlive();
  assert.equal(recovery.restarted, true);
  assert.equal(recovery.fromCheckpoint, undefined);
  assert.deepEqual(await surf.rpc.call('getAccountInfo', ['seeded']), { value: { lamports: 7 } });
});

test('changed original snapshot fails recovery rather than silently seeding different state', async (t) => {
  const f = fixture(t);
  const snapshot = join(f.root, 'original.json');
  writeFileSync(snapshot, '{"seeded":{"lamports":7}}');
  let exited!: () => void;
  const exit = new Promise<void>(resolve => { exited = resolve; });
  const surf = createSurfnet({ binary: f.binary, workDir: f.workDir, snapshot, onExit: () => exited() });
  t.after(() => surf.stop());
  await surf.start();
  process.kill(surf.pid()!, 'SIGKILL');
  await exit;
  writeFileSync(snapshot, '{}');
  await assert.rejects(surf.ensureAlive(), /snapshot.*changed/i);
  assert.equal(surf.ports(), undefined);
  assert.equal(surf.pid(), undefined);
});

test('aborting startup kills the child and releases its reserved ports', async (t) => {
  const f = fixture(t);
  writeFileSync(f.binary, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  const controller = new AbortController();
  const surf = createSurfnet({ binary: f.binary, workDir: f.workDir, signal: controller.signal, startTimeoutMs: 5000 });
  t.after(() => surf.stop());
  const started = surf.start();
  // Exercise actual child/process cancellation; mock timers cannot drive the
  // subprocess or the HTTP readiness deadline in its separate event loop.
  const timer = setTimeout(() => controller.abort(new Error('cancel startup')), 100);
  try { await assert.rejects(started, /cancel startup|abort/i); } finally { clearTimeout(timer); }
  assert.equal(surf.pid(), undefined);
  assert.equal(surf.ports(), undefined);
});

test('readiness timeout cleans up without leaving a process or port registration', async (t) => {
  const f = fixture(t);
  writeFileSync(f.binary, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  // Deliberately uses the platform clock to exercise real readiness teardown.
  const surf = createSurfnet({ binary: f.binary, workDir: f.workDir, startTimeoutMs: 50 });
  t.after(() => surf.stop());
  await assert.rejects(surf.start(), /not healthy/);
  assert.equal(surf.pid(), undefined);
  assert.equal(surf.ports(), undefined);
});

test('host process registration precedes readiness and registration failure stops the child', async t => {
  const f = fixture(t);
  let pid: number | undefined;
  const surf = createSurfnet({
    binary: f.binary, workDir: f.workDir,
    onSpawn(childPid, cwd) {
      pid = childPid;
      assert.equal(cwd, f.workDir);
      assert.doesNotThrow(() => process.kill(childPid, 0));
      throw new Error('identity could not be persisted');
    },
  });
  t.after(() => surf.stop());
  await assert.rejects(surf.start(), /identity could not be persisted/);
  const recordedPid = pid;
  assert.ok(recordedPid);
  assert.throws(() => process.kill(recordedPid, 0), { code: 'ESRCH' });
  assert.equal(surf.pid(), undefined);
  assert.equal(surf.ports(), undefined);
});
