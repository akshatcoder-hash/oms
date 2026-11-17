import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { dockerOut, removeTaskResources } from '@oms/sandbox';
import { acquireTaskLease, createTask, inspectMutationLease, openWorkspace } from '../src/workspace/index.ts';
import { recoverHarnessWorkspace, trackRuntimeProcesses } from '../src/runtime/recovery.ts';
import { taskContext } from '../src/runtime/task-context.ts';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { createHarnessSession, type HarnessSession } from '../src/runtime/session.ts';
import { createHarnessFixture } from '../test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

async function deadOwner(t: TestContext, leaseFile: string) {
  const module = new URL('../src/workspace/lease.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { acquireMutationLease } from ${JSON.stringify(module)};
    import { createServer } from 'node:net';
    acquireMutationLease(${JSON.stringify(leaseFile)});
    createServer().listen(0, '127.0.0.1', () => console.log('ready'));
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exited;
  });
  await once(child.stdout, 'data');
  const state = inspectMutationLease(leaseFile);
  assert.equal(state.status, 'live');
  if (state.status !== 'live') throw new Error('live owner required');
  child.kill();
  await exited;
  return state.owner;
}

async function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oms-recovery-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  writeFileSync(join(repo, 'saved.txt'), 'saved work\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.test', 'commit', '-qm', 'fixture');
  const workspace = openWorkspace(repo, { stateRoot: join(base, 'state'), initialize: { ignore: 'exclude' } });
  const task = createTask(workspace, { id: 'saved', baseOid: git('rev-parse', 'HEAD') });
  const context = taskContext(workspace, task);
  const owner = await deadOwner(t, task.leaseFile);
  const saved = join(context.stateDir, 'saved-history.json');
  writeFileSync(saved, '{"history":"preserve"}\n', { mode: 0o600 });
  return { workspace, task, context, owner, saved };
}

async function runtimeChild(t: TestContext, cwd: string) {
  const child = spawn(
    process.execPath,
    ['-e', "require('node:net').createServer().listen(0,'127.0.0.1',() => console.log('ready'))"],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exited;
  });
  await once(child.stdout, 'data');
  return { child, exited };
}

test('dead owner with no resources recovers and reopens without changing saved work/history', async (t) => {
  if (await skipUnavailable(t, { docker: [] })) return;
  const f = await fixture(t);
  await recoverHarnessWorkspace(f.workspace, f.task, f.owner);
  assert.equal(inspectMutationLease(f.task.leaseFile).status, 'absent');
  assert.equal(readFileSync(f.saved, 'utf8'), '{"history":"preserve"}\n');
  assert.equal(readFileSync(join(f.task.codeRoot, 'saved.txt'), 'utf8'), 'saved work\n');
  acquireTaskLease(f.workspace, f.task.id).release();
});

test('verified recovery releases only the dead task owner’s source and volume exclusion records', async (t) => {
  if (await skipUnavailable(t, { docker: [] })) return;
  const f = await fixture(t);
  const source = join(f.context.sourceControlDir, `${createHash('sha256').update(f.task.codeRoot).digest('hex')}.json`);
  writeFileSync(
    source,
    JSON.stringify({ token: randomUUID(), codeRoot: f.task.codeRoot, kind: 'sandbox', pid: f.owner.pid }),
    { mode: 0o600 },
  );
  const volume = 'saved-dependencies';
  const volumeDir = join(f.context.leaseDir, createHash('sha256').update(volume).digest('hex'));
  mkdirSync(volumeDir, { mode: 0o700 });
  const volumeLease = join(volumeDir, `${randomUUID()}.json`);
  writeFileSync(
    volumeLease,
    JSON.stringify({ taskName: f.context.taskName, volume, phase: 'install', pid: f.owner.pid }),
    { mode: 0o600 },
  );
  await recoverHarnessWorkspace(f.workspace, f.task, f.owner);
  assert.equal(existsSync(source), false);
  assert.equal(existsSync(volumeLease), false);
  assert.equal(readFileSync(join(f.task.codeRoot, 'saved.txt'), 'utf8'), 'saved work\n');
  acquireTaskLease(f.workspace, f.task.id).release();
});

test('foreign source exclusion is never removed or treated as recovered', async (t) => {
  const f = await fixture(t);
  const source = join(f.context.sourceControlDir, `${createHash('sha256').update(f.task.codeRoot).digest('hex')}.json`);
  const record = JSON.stringify({ token: randomUUID(), codeRoot: f.task.codeRoot, kind: 'sandbox', pid: process.pid });
  writeFileSync(source, record, { mode: 0o600 });
  await assert.rejects(recoverHarnessWorkspace(f.workspace, f.task, f.owner), { code: 'RECOVERY_SOURCE_UNVERIFIABLE' });
  assert.equal(readFileSync(source, 'utf8'), record);
  assert.equal(inspectMutationLease(f.task.leaseFile).status, 'stale');
});

test('recovery stops a durably identified task process but refuses an untracked process', async (t) => {
  if (await skipUnavailable(t, { docker: [] })) return;
  const f = await fixture(t);
  const runtime = await runtimeChild(t, f.context.workDir);
  await assert.rejects(recoverHarnessWorkspace(f.workspace, f.task, f.owner), { code: 'RECOVERY_PROCESS_UNTRACKED' });
  assert.equal(runtime.child.exitCode, null);
  const tracker = trackRuntimeProcesses(f.task.leaseFile, f.owner, f.context.workDir);
  tracker.onSpawn(runtime.child.pid!, f.context.workDir);
  await recoverHarnessWorkspace(f.workspace, f.task, f.owner);
  await runtime.exited;
  acquireTaskLease(f.workspace, f.task.id).release();
});

test('recovery removes task execution resources and preserves persistent Docker volume contents', async (t) => {
  const image = process.env.OMS_SANDBOX_IMAGE;
  if ((await skipUnavailable(t, { docker: [image] })) || !image) return;
  const f = await fixture(t);
  const name = `oms-${f.context.taskName}-run-recovery`;
  const network = `${name}-net`;
  const volume = `${name}-data`;
  const labels = [
    '--label',
    'oms.component=sandbox',
    '--label',
    `oms.task=${f.context.taskName}`,
    '--label',
    'oms.execution=recovery-fixture',
    '--label',
    'oms.phase=run',
  ];
  t.after(async () => {
    await removeTaskResources(f.context.taskName);
  });
  await dockerOut(['volume', 'create', ...labels, volume]);
  await dockerOut(['network', 'create', '--internal', ...labels, network]);
  await dockerOut([
    'run',
    '--pull=never',
    '-d',
    '--name',
    name,
    ...labels,
    '--network',
    network,
    '-v',
    `${volume}:/data`,
    image,
    'node',
    '-e',
    "require('node:net').createServer().listen(0,'127.0.0.1')",
  ]);
  await dockerOut(['exec', name, 'node', '-e', "require('node:fs').writeFileSync('/data/saved','persistent')"]);
  await recoverHarnessWorkspace(f.workspace, f.task, f.owner);
  assert.equal(
    (await dockerOut(['ps', '-a', '--filter', `label=oms.task=${f.context.taskName}`, '--format', '{{.ID}}'])).trim(),
    '',
  );
  assert.equal(
    (
      await dockerOut(['network', 'ls', '--filter', `label=oms.task=${f.context.taskName}`, '--format', '{{.ID}}'])
    ).trim(),
    '',
  );
  assert.equal(
    (
      await dockerOut([
        'run',
        '--pull=never',
        '--rm',
        '--network',
        'none',
        '-v',
        `${volume}:/data:ro`,
        image,
        'node',
        '-e',
        "process.stdout.write(require('node:fs').readFileSync('/data/saved'))",
      ])
    ).trim(),
    'persistent',
  );
  assert.equal(readFileSync(f.saved, 'utf8'), '{"history":"preserve"}\n');
  acquireTaskLease(f.workspace, f.task.id).release();
});

test('foreign resource identity prevents cleanup and leaves the stale lease', async (t) => {
  if (await skipUnavailable(t, { docker: [] })) return;
  const f = await fixture(t);
  const name = `oms-${f.context.taskName}-foreign`;
  await dockerOut([
    'network',
    'create',
    '--label',
    `oms.task=${f.context.taskName}`,
    '--label',
    'oms.component=foreign',
    name,
  ]);
  t.after(async () => {
    await dockerOut(['network', 'rm', name]);
  });
  await assert.rejects(recoverHarnessWorkspace(f.workspace, f.task, f.owner), { code: 'RECOVERY_DOCKER_OWNERSHIP' });
  assert.equal(inspectMutationLease(f.task.leaseFile).status, 'stale');
  assert.ok(existsSync(f.saved));
});

test(
  'saved production Harness reopens after stale-owner recovery with history and work intact',
  { timeout: 120_000 },
  async (t) => {
    const binary = process.env.SURFPOOL_BINARY;
    const image = process.env.OMS_SANDBOX_IMAGE;
    const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE ?? image;
    if (
      (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
      !binary ||
      !image ||
      !forwarderImage
    )
      return;
    const f = await createHarnessFixture({ binary, image, forwarderImage });
    let harness: HarnessSession | undefined;
    try {
      f.faux.setResponses([fauxAssistantMessage('Saved recovery conversation.')]);
      harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
      await harness.session.prompt('Keep this conversation.');
      const sessionId = harness.session.sessionManager.getSessionId();
      const used = harness.budget.snapshot().used;
      writeFileSync(join(f.task.codeRoot, 'draft.txt'), 'unsynced saved work\\n');
      await harness.close();
      harness = undefined;
      const owner = await deadOwner(t, f.task.leaseFile);
      await recoverHarnessWorkspace(f.workspace, f.task, owner);
      harness = await createHarnessSession({ ...f.options, sessionId, modelRuntime: f.modelRuntime, model: f.model });
      assert.equal(harness.session.sessionManager.getSessionId(), sessionId);
      assert.match(JSON.stringify(harness.session.messages), /Saved recovery conversation/);
      assert.equal(harness.budget.snapshot().used.tokens, used.tokens);
      assert.equal(harness.budget.snapshot().used.spendMicroUsd, used.spendMicroUsd);
      assert.equal(readFileSync(join(f.task.codeRoot, 'draft.txt'), 'utf8'), 'unsynced saved work\\n');
      assert.equal(f.faux.state.callCount, 1, 'opening and recovery must not dispatch inference');
    } finally {
      await harness?.close();
      rmSync(f.base, { recursive: true, force: true });
    }
  },
);

test('host recovery tracks worktree children and uses saved backend without Docker', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.context.stateDir, 'runtime-backend.json'), JSON.stringify({ backend: 'host' }), { mode: 0o600 });
  const running = await runtimeChild(t, f.task.codeRoot);
  await assert.rejects(recoverHarnessWorkspace(f.workspace, f.task, f.owner), { code: 'RECOVERY_PROCESS_UNTRACKED' });
  const tracker = trackRuntimeProcesses(f.task.leaseFile, f.owner, f.context.workDir, [f.task.codeRoot], true);
  tracker.onSpawn(running.child.pid!, f.task.codeRoot);
  const previousPath = process.env.PATH;
  process.env.PATH = '/nonexistent-fixture-bin';
  try {
    await recoverHarnessWorkspace(f.workspace, f.task, f.owner);
  } finally {
    process.env.PATH = previousPath;
  }
  await running.exited;
  assert.equal(inspectMutationLease(f.task.leaseFile).status, 'absent');
  assert.equal(readFileSync(join(f.task.codeRoot, 'saved.txt'), 'utf8'), 'saved work\n');
});

test('host recovery accounts for native session children outside the task mounts', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.context.stateDir, 'runtime-backend.json'), JSON.stringify({ backend: 'host' }), { mode: 0o600 });
  const nativeRoot = join(f.workspace.stateDir, 'sessions', f.task.id);
  const nativeWork = join(nativeRoot, `${randomUUID()}.claude.json.work`);
  mkdirSync(nativeWork, { recursive: true, mode: 0o700 });
  const running = await runtimeChild(t, nativeWork);
  await assert.rejects(recoverHarnessWorkspace(f.workspace, f.task, f.owner), { code: 'RECOVERY_PROCESS_UNTRACKED' });
  const tracker = trackRuntimeProcesses(f.task.leaseFile, f.owner, f.context.workDir, [nativeRoot], true);
  tracker.onSpawn(running.child.pid!, nativeWork);
  await recoverHarnessWorkspace(f.workspace, f.task, f.owner);
  await running.exited;
  assert.equal(inspectMutationLease(f.task.leaseFile).status, 'absent');
  assert.ok(existsSync(nativeWork));
  assert.equal(readFileSync(f.saved, 'utf8'), '{"history":"preserve"}\n');
});
