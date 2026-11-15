import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildMounts } from '../src/mounts.ts';
import { runInSandbox } from '../src/exec.ts';
import { createSandboxSession, type SandboxSessionOptions } from '../src/session.ts';
import { SandboxError } from '../src/errors.ts';
import { makeScratchDir, removeScratchDir } from '../src/docker.ts';
import { abortable, Daemon, deferred, IMAGE, values } from '../test-support/daemon.ts';

function fixture(t: TestContext, overrides: Partial<SandboxSessionOptions> = {}) {
  const root = makeScratchDir('oms-sandbox-session-');
  t.after(() => removeScratchDir(root));
  const project = path.join(root, 'project');
  mkdirSync(project);
  const options: SandboxSessionOptions = {
    taskName: 'test-task', image: IMAGE, forwarderImage: IMAGE, leaseDir: path.join(root, 'leases'),
    sourceControlDir: path.join(root, 'source-control'),
    mounts: buildMounts({ taskName: 'test-task', projectRoot: project }),
    surfnet: { port: 8899 }, env: { HOME: '/tmp', SOLANA_RPC_URL: 'http://host.docker.internal:8899' }, cwd: '/work',
    ...overrides,
  };
  const daemon = new Daemon();
  const session = createSandboxSession(options, daemon);
  t.after(() => session.close().catch(() => {}));
  return { options, daemon, session, install: () => runInSandbox({
    ...options, backend: 'docker', phase: 'install', argv: ['true'], timeoutMs: 5000, installAllowlist: ['registry.npmjs.org:443'],
  }, daemon) };
}
const exec = { timeoutMs: 5000 };

test('the container, network and forwarder are created once and every command is an exec', async t => {
  const { daemon, session } = fixture(t);
  for (const word of ['one', 'two', 'three']) assert.equal((await session.exec(['echo', word], exec)).exitCode, 0);
  const created = daemon.calls.filter(args => args[0] === 'create').map(args => values(args, '--name')[0]!);
  assert.equal(created.filter(name => name.endsWith('-fwd')).length, 1);
  assert.equal(created.filter(name => name.endsWith('-volumes')).length, 1);
  assert.equal(created.filter(name => !name.endsWith('-fwd') && !name.endsWith('-volumes')).length, 1);
  assert.equal(daemon.calls.filter(args => args[0] === 'network' && args[1] === 'create').length, 1);
  assert.equal(daemon.execs.length, 3);
  assert.equal(new Set(daemon.execs.map(entry => entry.container.Id)).size, 1);
  assert.deepEqual(daemon.execs.map(entry => entry.argv), [['echo', 'one'], ['echo', 'two'], ['echo', 'three']]);
  assert.equal(daemon.executions.length, 0, 'no per-command attach');
});

test('the session container carries the per-command hardening, mounts, env, network and ownership labels', async t => {
  const { options, daemon, session } = fixture(t);
  await session.exec(['true'], exec);
  const [container] = daemon.execs.map(entry => entry.container);
  const args = container!.args;
  const flags = (flag: string) => values(args, flag);
  assert.ok(args.includes('--read-only') && args.includes('--init') && !args.includes('--rm'));
  assert.deepEqual(flags('--cap-drop'), ['ALL']);
  assert.deepEqual(flags('--security-opt'), ['no-new-privileges']);
  assert.match(flags('--user')[0]!, /^[1-9]\d*:[1-9]\d*$/);
  assert.deepEqual([flags('--pids-limit'), flags('--memory'), flags('--cpus')], [['256'], ['2048m'], ['2']]);
  assert.deepEqual(flags('-w'), ['/work']);
  assert.deepEqual(flags('--env'), ['HOME=/tmp', 'SOLANA_RPC_URL=http://host.docker.internal:8899']);
  assert.ok(flags('--tmpfs').includes('/tmp'));
  assert.deepEqual(flags('--network'), [container!.network]);
  assert.ok(container!.network.endsWith('-net') && daemon.networks.has(container!.network));
  assert.deepEqual(flags('-v').slice(0, 1), [`${options.mounts.projectMount.hostPath}:/work:rw`]);
  assert.ok(options.mounts.readOnlyMounts.every(mount => flags('-v').includes(`${mount.hostPath}:${mount.containerPath}:ro`)));
  assert.equal(args[args.indexOf(IMAGE) + 1], 'sleep');
  const labels = container!.Config.Labels;
  assert.equal(labels['oms.component'], 'sandbox');
  assert.equal(labels['oms.task'], 'test-task');
  assert.equal(labels['oms.phase'], 'run');
  assert.match(labels['oms.execution']!, /^[0-9a-f-]{36}$/);
  assert.ok(container!.Name.startsWith('oms-test-task-run-'));
  const forwarder = [...daemon.containers.values()].find(c => c.Name.endsWith('-fwd'))!;
  assert.deepEqual(forwarder.Config.Labels, labels);
});

test('a timeout kills the exec tree and keeps the container for the next command', async t => {
  const { daemon, session } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred<void>();
  daemon.onExec = async (_container, _argv, capture) => { capture.stdout(Buffer.from('partial')); started.resolve(); return abortable(capture); };
  const running = session.exec(['sleep', '999'], { timeoutMs: 20 });
  await started.promise;
  t.mock.timers.tick(20);
  const result = await running;
  assert.deepEqual([result.exitCode, result.timedOut, result.cancelled, result.stdout], [124, true, false, 'partial']);
  assert.equal(daemon.sweeps.length, 1);
  const survivor = daemon.execs[0]!.container;
  assert.ok(daemon.containers.has(survivor.Name) && survivor.running);
  daemon.onExec = undefined;
  assert.equal((await session.exec(['true'], exec)).exitCode, 0);
  assert.equal(daemon.execs[1]!.container, survivor);
  assert.equal(daemon.containers.size, 2);
});

test('cancelling a command sweeps it and keeps the session usable', async t => {
  const { daemon, session } = fixture(t);
  const controller = new AbortController();
  const started = deferred<void>();
  daemon.onExec = async (_container, _argv, capture) => { started.resolve(); return abortable(capture); };
  const running = session.exec(['sleep', '999'], { ...exec, signal: controller.signal });
  await started.promise;
  controller.abort();
  const result = await running;
  assert.deepEqual([result.exitCode, result.cancelled, result.timedOut], [130, true, false]);
  assert.equal(daemon.sweeps.length, 1);
  daemon.onExec = undefined;
  assert.equal((await session.exec(['true'], exec)).exitCode, 0);
  assert.equal(daemon.execs[1]!.container, daemon.execs[0]!.container);
});

test('only signalled exits are swept after a command; ordinary exits rely on the wrapper', async t => {
  const { daemon, session } = fixture(t);
  daemon.onExec = async () => 3;
  assert.equal((await session.exec(['false'], exec)).exitCode, 3);
  assert.equal(daemon.sweeps.length, 0);
  daemon.onExec = async () => 137;
  assert.equal((await session.exec(['pkill', '-9', '-f', '.'], exec)).exitCode, 137);
  assert.equal(daemon.sweeps.length, 1);
});

test('a container killed by a command is replaced before the next command', async t => {
  const { daemon, session } = fixture(t);
  await session.exec(['true'], exec);
  const first = daemon.execs[0]!.container;
  daemon.onExec = async container => { container.running = false; return 137; };
  assert.equal((await session.exec(['kill-everything'], exec)).exitCode, 137);
  daemon.onExec = undefined;
  assert.equal((await session.exec(['true'], exec)).exitCode, 0);
  const second = daemon.execs.at(-1)!.container;
  assert.notEqual(second.Id, first.Id);
  assert.ok(second.running);
  assert.ok(!daemon.containers.has(first.Name), 'the dead container is removed, not leaked');
  assert.equal(daemon.networks.size, 1, 'the old egress network is replaced, not accumulated');
  assert.equal(daemon.containers.size, 2);
});

test('a container removed from under the session is rebuilt', async t => {
  const { daemon, session } = fixture(t);
  await session.exec(['true'], exec);
  const first = daemon.execs[0]!.container;
  daemon.containers.delete(first.Name);
  assert.equal((await session.exec(['true'], exec)).exitCode, 0);
  assert.notEqual(daemon.execs.at(-1)!.container.Id, first.Id);
});

test('an unconfirmed sweep removes the container so nothing outlives the command', async t => {
  const { daemon, session } = fixture(t);
  daemon.onExec = async () => 137;
  daemon.fail = args => { if (args.includes('oms-sweep')) throw new SandboxError('E_DOCKER', 'pids limit'); };
  assert.equal((await session.exec(['forkbomb'], exec)).exitCode, 137);
  assert.equal(daemon.containers.size, 0);
  assert.equal(daemon.networks.size, 0);
  daemon.fail = undefined;
  daemon.onExec = undefined;
  assert.equal((await session.exec(['true'], exec)).exitCode, 0);
  assert.equal(daemon.containers.size, 2);
});

test('close removes the container and network, is idempotent and refuses further commands', async t => {
  const { daemon, session } = fixture(t);
  await session.exec(['true'], exec);
  await session.close();
  await session.close();
  assert.equal(daemon.containers.size, 0);
  assert.equal(daemon.networks.size, 0);
  await assert.rejects(session.exec(['true'], exec), /closed/);
});

test('the lifetime signal tears the session down, including a running command', async t => {
  const lifetime = new AbortController();
  const { daemon, session } = fixture(t, { signal: lifetime.signal });
  const started = deferred<void>();
  daemon.onExec = async (_container, _argv, capture) => { started.resolve(); return abortable(capture); };
  const running = session.exec(['sleep', '999'], exec);
  await started.promise;
  lifetime.abort();
  assert.equal((await running).cancelled, true);
  await session.close();
  assert.equal(daemon.containers.size, 0);
  assert.equal(daemon.networks.size, 0);
});

test('a second command while one runs is refused without disturbing it', async t => {
  const { daemon, session } = fixture(t);
  const release = deferred<void>();
  const started = deferred<void>();
  daemon.onExec = async () => { started.resolve(); await release.promise; return 0; };
  const first = session.exec(['sleep', '1'], exec);
  await started.promise;
  await assert.rejects(session.exec(['true'], exec), { code: 'E_RESOURCE_BUSY' });
  release.resolve();
  assert.equal((await first).exitCode, 0);
});

test('host exclusion is held only while a command runs, so installs and captures are not blocked by an idle session', async t => {
  const { daemon, session, install } = fixture(t);
  const release = deferred<void>();
  const started = deferred<void>();
  daemon.onExec = async () => { started.resolve(); await release.promise; return 0; };
  const running = session.exec(['sleep', '1'], exec);
  await started.promise;
  await assert.rejects(install(), { code: 'E_RESOURCE_BUSY' });
  release.resolve();
  await running;
  daemon.onExec = undefined;
  assert.equal((await install()).exitCode, 0);
  assert.equal((await session.exec(['true'], exec)).exitCode, 0);
});

test('a failed removal is surfaced and retains exclusion for explicit recovery', async t => {
  const { daemon, session, install } = fixture(t);
  daemon.onExec = async () => 137;
  daemon.fail = args => { if (args.includes('oms-sweep') || args[0] === 'rm') throw new SandboxError('E_DOCKER', 'daemon unavailable'); };
  await assert.rejects(session.exec(['x'], exec), /cleanup/i);
  daemon.fail = undefined;
  await assert.rejects(install(), { code: 'E_RESOURCE_BUSY' });
});

test('setup that fails midway removes what it created and the next command starts clean', async t => {
  const { daemon, session } = fixture(t);
  daemon.fail = args => { if (args[0] === 'start' && !args.includes('--attach') && daemon.containers.size === 2) throw new SandboxError('E_DOCKER', 'start failed'); };
  await assert.rejects(session.exec(['true'], exec), { code: 'E_DOCKER' });
  assert.equal(daemon.containers.size, 0);
  assert.equal(daemon.networks.size, 0);
  daemon.fail = undefined;
  assert.equal((await session.exec(['true'], exec)).exitCode, 0);
});

test('invalid commands and timeouts are refused before any Docker call', async t => {
  const { daemon, session } = fixture(t);
  await assert.rejects(session.exec([], exec), { code: 'E_BAD_ARGUMENT' });
  await assert.rejects(session.exec(['a\0b'], exec), { code: 'E_BAD_ARGUMENT' });
  await assert.rejects(session.exec(['true'], { timeoutMs: 0 }), { code: 'E_BAD_ARGUMENT' });
  assert.equal(daemon.calls.length, 0);
});

test('captured streams keep the configured byte limits per command', async t => {
  const { daemon, session } = fixture(t, { stdoutLimitBytes: 4, stderrLimitBytes: 0 });
  daemon.onExec = async (_container, _argv, capture) => { capture.stdout(Buffer.from('abcdefgh')); capture.stderr(Buffer.from('xyz')); return 0; };
  const result = await session.exec(['true'], exec);
  assert.deepEqual([result.stdout, result.stderr, result.truncated], ['abcd', '', true]);
});
