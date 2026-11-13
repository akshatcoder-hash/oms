import assert from 'node:assert/strict';
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildMounts } from '../src/mounts.ts';
import { runInSandbox, type RunInSandboxOptions } from '../src/exec.ts';
import { SandboxError } from '../src/errors.ts';
import { makeScratchDir, removeScratchDir } from '../src/docker.ts';
import { abortable, Daemon, deferred, IMAGE, values } from '../test-support/daemon.ts';
import { digestCodeInputs, EMPTY_SNAPSHOT_DIGEST } from '@oms/contract';

function fixture(t: TestContext): { options: RunInSandboxOptions; daemon: Daemon } {
  const root = makeScratchDir('oms-sandbox-exec-');
  t.after(() => removeScratchDir(root));
  const project = path.join(root, 'project');
  mkdirSync(project);
  return {
    options: {
      taskName: 'test-task', phase: 'run', argv: ['true'], timeoutMs: 5000,
      image: IMAGE, forwarderImage: IMAGE, leaseDir: path.join(root, 'leases'),
      sourceControlDir: path.join(root, 'source-control'),
      mounts: buildMounts({ taskName: 'test-task', projectRoot: project }),
      surfnet: { port: 8899 },
    },
    daemon: new Daemon(),
  };
}

test('Docker JSON labels preserve owned volume sentinel across repeated install and run', async t => {
  const { options, daemon } = fixture(t);
  daemon.onExecute = async container => {
    const volume = daemon.volumes.get(options.mounts.volumes[0]!.name)!;
    if (container.Config.Labels['oms.phase'] === 'install') volume.sentinel = 'persistent';
    else assert.equal(volume.sentinel, 'persistent');
    return 0;
  };
  await runInSandbox({ ...options, phase: 'install', installAllowlist: ['registry.npmjs.org:443'] }, daemon);
  await runInSandbox(options, daemon);
  await runInSandbox(options, daemon);
  assert.equal(daemon.calls.filter(a => a[0] === 'volume' && a[1] === 'create').length, 2);
  assert.equal(daemon.containers.size, 0);
  assert.equal(daemon.networks.size, 0);
});

test('install initializes owned volume roots without project mounts, network or recursive data edits', async t => {
  const { options, daemon } = fixture(t);
  await runInSandbox({ ...options, phase: 'install', installAllowlist: ['registry.npmjs.org:443'] }, daemon);
  const init = daemon.calls.find(args => args[0] === 'create' && values(args, '--name')[0]?.endsWith('-volumes'));
  assert.ok(init);
  assert.deepEqual(values(init, '--network'), ['none']);
  assert.deepEqual(values(init, '--cap-add'), ['CHOWN']);
  assert.deepEqual(values(init, '--user'), ['0:0']);
  assert.ok(!init.some(value => value.includes(options.mounts.projectMount.hostPath)));
  assert.ok(!init.includes('-R'));
  assert.ok(init.includes('--pull=never'));
  assert.equal(daemon.containers.size, 0);
  assert.equal(daemon.networks.size, 0);
});

test('foreign, unlabeled, wrong-component and misidentified volumes are never deleted or reused', async t => {
  for (const metadata of [
    { Name: 'oms-test-task-node_modules', Labels: { 'oms.task': 'foreign', 'oms.component': 'sandbox' } },
    { Name: 'oms-test-task-node_modules', Labels: { 'oms.task': 'test-task', 'oms.component': 'other' } },
    { Name: 'different-volume', Labels: { 'oms.task': 'test-task', 'oms.component': 'sandbox' } },
    { Name: 'oms-test-task-node_modules', Labels: null },
    { Name: 'oms-test-task-node_modules', Labels: ['oms.task=test-task', 'oms.component=sandbox'] },
  ]) {
    const { options, daemon } = fixture(t);
    daemon.volumes.set(options.mounts.volumes[0]!.name, metadata);
    await assert.rejects(runInSandbox(options, daemon), { code: 'E_RESOURCE_OWNERSHIP' });
    assert.equal(daemon.volumes.get(options.mounts.volumes[0]!.name), metadata);
    assert.equal(daemon.executions.length, 0);
  }
});

test('lookup failures and malformed Docker label JSON do not trigger replacement', async t => {
  for (const kind of ['lookup', 'json']) {
    const { options, daemon } = fixture(t);
    daemon.volumes.set(options.mounts.volumes[0]!.name, { Name: options.mounts.volumes[0]!.name, Labels: {} });
    daemon.fail = args => {
      if (kind === 'lookup' && args[0] === 'volume' && args[1] === 'inspect') throw new SandboxError('E_DOCKER', kind);
    };
    if (kind === 'json') daemon.rawVolumeMetadata = '{invalid-json';
    await assert.rejects(runInSandbox(options, daemon));
    assert.ok(!daemon.calls.some(a => a[0] === 'volume' && ['rm', 'create'].includes(a[1]!)));
  }
});

test('overlapping runs have independent networks and cancelling one leaves its peer alive', async t => {
  const { options, daemon } = fixture(t);
  const peerProject = path.join(path.dirname(options.mounts.projectMount.hostPath), 'peer-project');
  mkdirSync(peerProject);
  const peerMounts = buildMounts({ taskName: options.taskName, projectRoot: peerProject });
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const first = new AbortController();
  const second = new AbortController();
  daemon.onExecute = async (_container, capture) => {
    (daemon.executions.length === 1 ? firstStarted : secondStarted).resolve();
    return abortable(capture);
  };
  const a = runInSandbox({ ...options, signal: first.signal }, daemon);
  await firstStarted.promise;
  const b = runInSandbox({ ...options, mounts: peerMounts, signal: second.signal }, daemon);
  await secondStarted.promise;
  const [one, two] = daemon.executions;
  assert.notEqual(one!.network, two!.network);
  first.abort();
  assert.equal((await a).cancelled, true);
  assert.ok(daemon.containers.has(two!.Name));
  assert.ok(daemon.networks.has(two!.network));
  second.abort();
  assert.equal((await b).exitCode, 130);
  assert.equal(daemon.containers.size, 0);
  assert.equal(daemon.networks.size, 0);
});

test('active run consumers exclude install mutation and release leases after cancellation', async t => {
  const { options, daemon } = fixture(t);
  const started = deferred<void>();
  const controller = new AbortController();
  daemon.onExecute = async (_container, capture) => { started.resolve(); return abortable(capture); };
  const running = runInSandbox({ ...options, signal: controller.signal }, daemon);
  await started.promise;
  const install = { ...options, phase: 'install' as const, installAllowlist: ['registry.npmjs.org:443'] };
  await assert.rejects(runInSandbox(install, daemon), { code: 'E_RESOURCE_BUSY' });
  controller.abort();
  await running;
  daemon.onExecute = undefined;
  assert.equal((await runInSandbox(install, daemon)).exitCode, 0);
});

test('install excludes consumers sharing any volume even under a different task identity', async t => {
  const { options, daemon } = fixture(t);
  const started = deferred<void>();
  const controller = new AbortController();
  daemon.onExecute = async (_container, capture) => { started.resolve(); return abortable(capture); };
  const installing = runInSandbox({ ...options, signal: controller.signal, phase: 'install', installAllowlist: ['registry.npmjs.org:443'] }, daemon);
  await started.promise;
  await assert.rejects(runInSandbox({ ...options, taskName: 'another-task' }, daemon), { code: 'E_RESOURCE_BUSY' });
  controller.abort();
  await installing;
});

test('install and run never share proxy network, even when overlapping without shared volumes', async t => {
  const { options, daemon } = fixture(t);
  options.mounts.volumes = [];
  const peerProject = path.join(path.dirname(options.mounts.projectMount.hostPath), 'peer-project');
  mkdirSync(peerProject);
  const peerMounts = buildMounts({ taskName: options.taskName, projectRoot: peerProject, heavyDirs: [] });
  const started = deferred<void>();
  const controller = new AbortController();
  daemon.onExecute = async (container, capture) => {
    if (container.Config.Labels['oms.phase'] === 'install') { started.resolve(); return abortable(capture); }
    const runForwarder = [...daemon.containers.values()].find(c => c.network === container.network && c.Name.endsWith('-fwd'))!;
    assert.ok(values(runForwarder.args, '--env').includes('FWD_MODE=forward'));
    assert.ok(!values(container.args, '--env').some(v => v.includes('PROXY')));
    const installContainer = daemon.executions[0]!;
    assert.notEqual(container.network, installContainer.network);
    return 0;
  };
  const installing = runInSandbox({ ...options, phase: 'install', installAllowlist: ['registry.npmjs.org:443'], signal: controller.signal }, daemon);
  await started.promise;
  await runInSandbox({ ...options, mounts: peerMounts }, daemon);
  assert.ok(daemon.containers.has(daemon.executions[0]!.Name));
  controller.abort();
  await installing;
});

test('partial setup failure cleans already-created resources and releases leases', async t => {
  for (const operation of ['start', 'connect', 'logs']) {
    const { options, daemon } = fixture(t);
    daemon.fail = args => {
      if (args[0] === operation || (args[0] === 'network' && args[1] === operation)) throw new SandboxError('E_DOCKER', 'setup failed');
    };
    await assert.rejects(runInSandbox(options, daemon), { code: 'E_DOCKER' });
    assert.equal(daemon.containers.size, 0);
    assert.equal(daemon.networks.size, 0);
    daemon.fail = undefined;
    assert.equal((await runInSandbox(options, daemon)).exitCode, 0);
  }
});

test('cancellation during setup cleans only its resources and never starts a task process', async t => {
  const { options, daemon } = fixture(t);
  const controller = new AbortController();
  daemon.fail = args => { if (args[0] === 'network' && args[1] === 'connect') controller.abort(); };
  const result = await runInSandbox({ ...options, signal: controller.signal }, daemon);
  assert.equal(result.cancelled, true);
  assert.equal(daemon.executions.length, 0);
  assert.equal(daemon.containers.size, 0);
  assert.equal(daemon.networks.size, 0);
});

test('timeout tears down owned process and returns captured output', async t => {
  const { options, daemon } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred<void>();
  daemon.onExecute = async (_container, capture) => {
    capture.stdout(Buffer.from('before timeout'));
    started.resolve();
    return abortable(capture);
  };
  const running = runInSandbox({ ...options, timeoutMs: 20 }, daemon);
  await started.promise;
  t.mock.timers.tick(20);
  const result = await running;
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.stdout, 'before timeout');
  assert.equal(daemon.containers.size, 0);
  assert.equal(daemon.networks.size, 0);
});

test('cleanup failure is surfaced and retains mutation exclusion', async t => {
  const { options, daemon } = fixture(t);
  daemon.fail = args => { if (args[0] === 'rm') throw new SandboxError('E_DOCKER', 'daemon unavailable'); };
  await assert.rejects(runInSandbox(options, daemon), /cleanup/i);
  await assert.rejects(runInSandbox({ ...options, phase: 'install', installAllowlist: ['registry.npmjs.org:443'] }, daemon), { code: 'E_RESOURCE_BUSY' });
});

test('immutable image prerequisites and private lease location fail before daemon mutation', async t => {
  const { options, daemon } = fixture(t);
  for (const over of [{ image: '' }, { forwarderImage: 'node:22-alpine' }, { leaseDir: options.mounts.projectMount.hostPath }]) {
    await assert.rejects(runInSandbox({ ...options, ...over }, daemon), { code: 'E_BAD_ARGUMENT' });
  }
  assert.equal(daemon.calls.length, 0);
  await runInSandbox(options, daemon);
  assert.ok(daemon.calls.filter(a => a[0] === 'create').every(a => a.includes('--pull=never')));
});

test('pre-aborted calls allocate no Docker resources', async t => {
  const { options, daemon } = fixture(t);
  const signal = AbortSignal.abort();
  const result = await runInSandbox({ ...options, signal }, daemon);
  assert.equal(result.cancelled, true);
  assert.equal(result.exitCode, 130);
  assert.equal(daemon.calls.length, 0);
});

test('setup cleans a resource created before Docker reports failure', async t => {
  const { options } = fixture(t);
  class InterruptedDaemon extends Daemon {
    override async out(args: string[], signal?: AbortSignal): Promise<string> {
      const result = await super.out(args, signal);
      if (args[0] === 'network' && args[1] === 'create') throw new SandboxError('E_DOCKER', 'lost create response');
      return result;
    }
  }
  const daemon = new InterruptedDaemon();
  await assert.rejects(runInSandbox(options, daemon), { code: 'E_DOCKER' });
  assert.equal(daemon.networks.size, 0);
});

test('setup cleanup refuses a foreign resource even at its proposed name', async t => {
  const { options } = fixture(t);
  class CollisionDaemon extends Daemon {
    override async out(args: string[], signal?: AbortSignal): Promise<string> {
      const result = await super.out(args, signal);
      if (args[0] === 'network' && args[1] === 'create') {
        this.networks.get(args.at(-1)!)!.Labels['oms.execution'] = 'foreign-execution';
        throw new SandboxError('E_DOCKER', 'name collision');
      }
      return result;
    }
  }
  const daemon = new CollisionDaemon();
  await assert.rejects(runInSandbox(options, daemon), /cleanup/);
  assert.equal(daemon.networks.size, 1);
  assert.ok(!daemon.calls.some(args => args[0] === 'network' && args[1] === 'rm'));
});

test('the execution deadline includes forwarder setup', async t => {
  const { options, daemon } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  daemon.fail = args => {
    if (args[0] === 'network' && args[1] === 'connect') t.mock.timers.tick(20);
  };
  const result = await runInSandbox({ ...options, timeoutMs: 20 }, daemon);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.equal(daemon.executions.length, 0);
  assert.equal(daemon.containers.size, 0);
  assert.equal(daemon.networks.size, 0);
});

test('captured streams retain exact byte limits, including zero', async t => {
  const { options, daemon } = fixture(t);
  daemon.onExecute = async (_container, capture) => {
    capture.stdout(Buffer.from('abcdef'));
    capture.stdout(Buffer.from('more'));
    capture.stderr(Buffer.from('discarded'));
    return 0;
  };
  const result = await runInSandbox({ ...options, stdoutLimitBytes: 3, stderrLimitBytes: 0 }, daemon);
  assert.equal(result.stdout, 'abc');
  assert.equal(result.stderr, '');
  assert.equal(result.truncated, true);
});

test('run mounts dependency volumes readonly while build outputs remain writable', async t => {
  const { options, daemon } = fixture(t);
  await runInSandbox(options, daemon);
  const volumes = values(daemon.executions[0]!.args, '--volume');
  assert.ok(volumes.includes('oms-test-task-node_modules:/work/node_modules:ro'));
  assert.ok(volumes.includes('oms-test-task-target:/work/target'));
});

test('live sandbox ownership blocks host capture until confirmed container teardown', async t => {
  const { options, daemon } = fixture(t);
  const started = deferred<void>();
  const stopping = deferred<void>();
  const allowStop = deferred<void>();
  const controller = new AbortController();
  const config = { schema: 'oms.evaluator/0' as const, codePaths: [], snapshotDigest: EMPTY_SNAPSHOT_DIGEST, executionIdentity: 'test:source' };
  daemon.onExecute = async (_container, capture) => { started.resolve(); return abortable(capture); };
  const original = daemon.out.bind(daemon);
  daemon.out = async (args, signal) => {
    if (args[0] === 'rm' && daemon.executions.some(container => container.Id === args.at(-1))) {
      stopping.resolve(); await allowStop.promise;
    }
    return original(args, signal);
  };
  const running = runInSandbox({ ...options, signal: controller.signal }, daemon);
  await started.promise;
  assert.throws(() => digestCodeInputs(options.mounts.projectMount.hostPath, config, options), { code: 'E_SOURCE_BUSY' });
  controller.abort(); await stopping.promise;
  assert.throws(() => digestCodeInputs(options.mounts.projectMount.hostPath, config, options), { code: 'E_SOURCE_BUSY' });
  allowStop.resolve(); await running;
  assert.equal(typeof digestCodeInputs(options.mounts.projectMount.hostPath, config, options), 'string');
});

test('uncertain sandbox cleanup retains host capture exclusion for explicit recovery', async t => {
  const { options, daemon } = fixture(t);
  daemon.fail = args => { if (args[0] === 'rm') throw new SandboxError('E_DOCKER', 'unconfirmed container teardown'); };
  await assert.rejects(runInSandbox(options, daemon), /cleanup/);
  assert.throws(() => digestCodeInputs(options.mounts.projectMount.hostPath, {
    schema: 'oms.evaluator/0', codePaths: [], snapshotDigest: EMPTY_SNAPSHOT_DIGEST, executionIdentity: 'test:source',
  }, options), { code: 'E_SOURCE_BUSY' });
});

for (const kind of ['readonly-source', 'readonly-ancestor', 'extra-source', 'extra-ancestor'] as const) {
  test(`${kind} substitution after approval is refused before any Docker call`, async t => {
    const { options, daemon } = fixture(t);
    const base = path.dirname(options.mounts.projectMount.hostPath);
    const forbidden = path.join(base, 'forbidden');
    mkdirSync(forbidden); writeFileSync(path.join(forbidden, 'sentinel'), 'outside bytes');
    const parent = kind.startsWith('readonly') ? path.join(options.mounts.projectMount.hostPath, 'verify') : path.join(base, 'outputs');
    mkdirSync(parent, { mode: 0o700 });
    const source = path.join(parent, 'source');
    mkdirSync(source); writeFileSync(path.join(source, 'value'), 'approved');
    options.mounts = buildMounts({
      projectRoot: options.mounts.projectMount.hostPath, taskName: options.taskName,
      readOnlyPaths: kind.startsWith('readonly') ? [source] : [],
      extra: kind.startsWith('extra') ? [{ hostPath: source, containerPath: '/output' }] : [],
      forbidden: { signerDir: forbidden },
    });
    const replaced = kind.endsWith('ancestor') ? parent : source;
    renameSync(replaced, `${replaced}-old`); symlinkSync(forbidden, replaced);
    await assert.rejects(runInSandbox(options, daemon), { code: 'E_MOUNT_FORBIDDEN' });
    assert.equal(daemon.calls.length, 0);
  });
}
