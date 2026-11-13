/**
 * Real-daemon checks of the long-lived session container: it must hold every
 * isolation property the per-command container holds, survive hung and
 * hostile commands, be found by recovery, and be faster per command.
 * Skips without a daemon and pinned images; OMS_REQUIRE_DOCKER=1 makes the
 * absence a failure.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { dockerOut, removeScratchDir } from '../src/docker.ts';
import { buildMounts } from '../src/mounts.ts';
import { hasLeftovers, recoverTaskExecutionResources, removeTaskResources } from '../src/cleanup.ts';
import { runInSandbox } from '../src/exec.ts';
import { createSandboxSession, type SandboxSession } from '../src/session.ts';
import { skipUnavailable } from '../test-support/infrastructure.ts';

const TASK = `sbxsession-${process.pid}`;
const IMAGE = process.env.OMS_SANDBOX_IMAGE;
const FORWARDER_IMAGE = process.env.OMS_SANDBOX_FORWARDER_IMAGE;
const SECRET_NAME = 'OMS_SESSION_TEST_SECRET';

interface Fixture {
  base: string;
  project: string;
  tokenFile: string;
  servers: http.Server[];
  surfnetPort: number;
  secondPort: number;
  options: Parameters<typeof createSandboxSession>[0];
}

let fixture: Fixture | undefined;

function startServer(reply: string): Promise<{ server: http.Server; port: number }> {
  return new Promise(resolve => {
    const server = http.createServer((_req, res) => { res.end(reply); });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

async function makeFixture(): Promise<Fixture> {
  if (fixture) return fixture;
  // Colima shares only $HOME into its VM, so the scratch space lives in the package.
  const root = path.join(import.meta.dirname, '..', '.tmp');
  mkdirSync(root, { recursive: true });
  const base = mkdtempSync(path.join(root, 'session-'));
  const project = path.join(base, 'project');
  const signerDir = path.join(base, 'signerdir');
  const stateDir = path.join(base, 'oms-state');
  mkdirSync(project, { recursive: true });
  mkdirSync(signerDir, { mode: 0o700 });
  mkdirSync(stateDir, { mode: 0o700 });
  const tokenFile = path.join(signerDir, 'channel.token');
  writeFileSync(tokenFile, 'FAKE-TOKEN-NOT-REAL\n', { mode: 0o600 });
  const innerSigner = path.join(project, '.oms-signer');
  mkdirSync(innerSigner, { mode: 0o700 });
  writeFileSync(path.join(innerSigner, 'tui.token'), 'SHADOW-TOKEN\n', { mode: 0o600 });
  const verifyDir = path.join(project, '.oms', 'verify');
  mkdirSync(verifyDir, { recursive: true });
  writeFileSync(path.join(verifyDir, 'verifier.test.ts'), 'assert.ok(true);\n');
  const surfnet = await startServer('SURFNET-OK\n');
  const second = await startServer('SECOND-OK\n');
  fixture = {
    base, project, tokenFile, servers: [surfnet.server, second.server], surfnetPort: surfnet.port, secondPort: second.port,
    options: {
      taskName: TASK, image: IMAGE!, forwarderImage: FORWARDER_IMAGE!,
      mounts: buildMounts({ projectRoot: project, taskName: TASK,
        forbidden: { signerDir: innerSigner, stateDir, extra: [signerDir] }, readOnlyPaths: [verifyDir] }),
      leaseDir: path.join(base, 'leases'), sourceControlDir: path.join(base, 'source-control'),
      surfnet: { port: surfnet.port }, cwd: '/work', env: { HOME: '/tmp', TMPDIR: '/tmp' },
    },
  };
  return fixture;
}

async function withSession(t: TestContext, action: (session: SandboxSession, f: Fixture) => Promise<void>): Promise<void> {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER_IMAGE] })) return;
  const f = await makeFixture();
  const session = createSandboxSession(f.options);
  try { await action(session, f); }
  finally { await session.close(); }
}

const sh = (script: string) => ['/bin/sh', '-c', script];
const exec = { timeoutMs: 120_000 };
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const containerNames = async () => (await dockerOut(['ps', '-a', '--filter', `label=oms.task=${TASK}`, '--format', '{{.Names}}']))
  .split('\n').filter(name => name && !name.endsWith('-fwd'));

before(async () => {
  process.env[SECRET_NAME] = 'host-secret-value';
  if (IMAGE && FORWARDER_IMAGE) await removeTaskResources(TASK).catch(() => {});
});

after(async () => {
  delete process.env[SECRET_NAME];
  if (IMAGE && FORWARDER_IMAGE && fixture) await removeTaskResources(TASK).catch(() => {});
  for (const server of fixture?.servers ?? []) server.close();
  if (fixture) removeScratchDir(fixture.base);
  fixture = undefined;
});

test('session: signer files are unreadable and the host environment does not leak', t => withSession(t, async (session, f) => {
  const r = await session.exec(sh(`cat ${f.tokenFile}; cat /work/../signerdir/channel.token; ls /work/.oms-signer/; cat /work/.oms-signer/tui.token; env`), exec);
  assert.ok(!r.stdout.includes('FAKE-TOKEN') && !r.stdout.includes('SHADOW-TOKEN') && !r.stdout.includes('tui.token'), r.stdout);
  assert.ok(!r.stdout.includes(SECRET_NAME) && !r.stdout.includes('host-secret-value'), 'host environment leaked into the session');
  assert.ok(!/^[A-Z_]*(?:KEY|TOKEN|SECRET)[A-Z_]*=/m.test(r.stdout), 'a credential-looking variable is set');
  assert.ok(r.stdout.includes('HOME=/tmp'));
}));

test('session: only the surfnet port is reachable', t => withSession(t, async (session, f) => {
  const script = `
    const checks = [['surfnet', 'http://host.docker.internal:${f.surfnetPort}/'], ['second', 'http://host.docker.internal:${f.secondPort}/'],
      ['hostDirect', 'http://192.168.5.2:${f.surfnetPort}/'], ['external', 'http://1.1.1.1/']];
    (async () => {
      const out = {};
      for (const [k, u] of checks) {
        try { const r = await fetch(u, { signal: AbortSignal.timeout(5000) }); out[k] = 'status:' + (await r.text()).trim(); }
        catch (e) { out[k] = 'blocked'; }
      }
      console.log('RESULT' + JSON.stringify(out));
    })();`;
  const r = await session.exec(['node', '-e', script], exec);
  const out = JSON.parse(r.stdout.match(/RESULT(\{.*\})/)?.[1] ?? '{}') as Record<string, string>;
  assert.equal(out['surfnet'], 'status:SURFNET-OK');
  assert.deepEqual([out['second'], out['hostDirect'], out['external']], ['blocked', 'blocked', 'blocked']);
}));

test('session: read-only paths stay read-only, project writes keep host ownership, root is read-only', t => withSession(t, async (session, f) => {
  const r = await session.exec(sh('echo hi > /work/written.txt && cat /work/written.txt; (echo evil > /work/.oms/verify/evil.ts) 2>&1; (touch /etc/oms-root) 2>&1; (touch /work/node_modules/x) 2>&1'), exec);
  assert.ok(r.stdout.includes('hi'));
  assert.ok((r.stdout.match(/Read-only/gi) ?? []).length >= 2, r.stdout);
  assert.equal(statSync(path.join(f.project, 'written.txt')).uid, process.getuid!());
}));

test('session: commands share /tmp but no process outlives its command', t => withSession(t, async (session) => {
  await session.exec(sh('echo kept > /tmp/marker; (sleep 3001 &) ; (setsid sleep 3002 >/dev/null 2>&1 &) ; true'), exec);
  const after = await session.exec(['node', '-e', `
    const fs = require('node:fs');
    const live = fs.readdirSync('/proc').filter(n => /^[0-9]+$/.test(n)).map(n => { try { return fs.readFileSync('/proc/' + n + '/cmdline', 'utf8'); } catch { return ''; } });
    console.log(JSON.stringify({ leaked: live.filter(c => c.includes('30' + '01') || c.includes('30' + '02')).length, marker: fs.readFileSync('/tmp/marker', 'utf8').trim() }));`], exec);
  assert.deepEqual(JSON.parse(after.stdout), { leaked: 0, marker: 'kept' });
}));

test('session: one container serves every command, and a respawning background loop is swept', t => withSession(t, async (session) => {
  const host = (await session.exec(sh('cat /etc/hostname'), exec)).stdout.trim();
  await session.exec(sh('(while :; do sleep 3006; done &); (while :; do (sleep 3007 &); sleep 0.01; done &); true'), exec);
  const count = `for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done | grep -c "sleep 300[67]"`;
  const next = await session.exec(sh(`cat /etc/hostname; ${count}`), exec);
  assert.deepEqual(next.stdout.trim().split('\n'), [host, '0']);
  assert.equal((await containerNames()).length, 1);
}));

test('session: a hung command is killed by its timeout, not the container, and nothing keeps running', t => withSession(t, async (session) => {
  const host = (await session.exec(sh('cat /etc/hostname'), exec)).stdout.trim();
  const hung = await session.exec(sh('(sleep 3003 &); sleep 3004'), { timeoutMs: 3000 });
  assert.deepEqual([hung.timedOut, hung.exitCode], [true, 124]);
  const next = await session.exec(sh('cat /etc/hostname; for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null; echo; done | grep -c "sleep 300[34]"'), exec);
  const [sameHost, leaked] = next.stdout.trim().split('\n');
  assert.equal(sameHost, host, 'the container must survive a command timeout');
  assert.equal(leaked, '0');
}));

test('session: a command that kills everything or the container leads to a working next call', t => withSession(t, async (session) => {
  const before = (await session.exec(sh('cat /etc/hostname'), exec)).stdout.trim();
  await session.exec(sh('kill -9 -1; sleep 5'), exec);
  assert.equal((await session.exec(sh('echo alive'), exec)).stdout.trim(), 'alive');
  const [name] = await containerNames();
  assert.ok(name);
  await dockerOut(['kill', name!]);
  const rebuilt = await session.exec(sh('cat /etc/hostname'), exec);
  assert.equal(rebuilt.exitCode, 0);
  assert.notEqual(rebuilt.stdout.trim(), before, 'a killed container must be replaced by a fresh one');
  assert.equal((await containerNames()).length, 1, 'the dead container must not leak');
}));

test('session: recovery finds and removes the labelled session resources, and the session rebuilds', t => withSession(t, async (session) => {
  await session.exec(sh('true'), exec);
  assert.equal((await containerNames()).length, 1);
  const removed = await recoverTaskExecutionResources(TASK, () => {});
  assert.equal(removed.containers.length, 2, 'session container and forwarder');
  assert.equal(removed.networks.length, 1);
  assert.equal((await session.exec(sh('echo again'), exec)).stdout.trim(), 'again');
}));

test('session: close leaves no containers or networks, and a cancelled command leaves the session usable', t => withSession(t, async (session) => {
  const controller = new AbortController();
  const running = session.exec(sh('sleep 3005'), { ...exec, signal: controller.signal });
  setTimeout(() => controller.abort(), 2000);
  assert.equal((await running).cancelled, true);
  assert.equal((await session.exec(sh('echo ok'), exec)).stdout.trim(), 'ok');
  await session.close();
  assert.deepEqual(await hasLeftovers(TASK).then(r => r.detail.filter(name => !/-(?:node_modules|target)$/.test(name))), []);
}));

test('session: median exec latency over 20 trivial commands beats the per-command container', async t => {
  if (await skipUnavailable(t, { docker: [IMAGE, FORWARDER_IMAGE] })) return;
  const f = await makeFixture();
  const session = createSandboxSession(f.options);
  try {
    await session.exec(sh('true'), exec);
    const timed: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      assert.equal((await session.exec(['ls', '/work'], exec)).exitCode, 0);
      timed.push(performance.now() - started);
    }
    const perCommand: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const r = await runInSandbox({ ...f.options, phase: 'run', argv: ['ls', '/work'], timeoutMs: 120_000 });
      assert.equal(r.exitCode, 0);
      perCommand.push(performance.now() - started);
    }
    const [session50, command50] = [median(timed), median(perCommand)];
    const report = `trivial ls median over 20 session execs: ${session50.toFixed(0)} ms; per-command container median over 5: ${command50.toFixed(0)} ms`;
    t.diagnostic(report);
    console.log(report);
    assert.ok(session50 < command50 && session50 < 300, report);
  } finally { await session.close(); }
});
