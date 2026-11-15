/**
 * Unit tests for argv/flag construction. No Docker required: the exact
 * hardening flags are the contract, so they are asserted verbatim.
 */

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildRunArgs, installProxyEnv, DEFAULT_LIMITS, sandboxUser } from '../src/args.ts';
import { buildMounts } from '../src/mounts.ts';
import { makeScratchDir, removeScratchDir } from '../src/docker.ts';

function planFor(base: string) {
  const project = path.join(base, 'project');
  const signerDir = path.join(base, 'signerdir');
  mkdirSync(project, { recursive: true });
  mkdirSync(signerDir, { mode: 0o700 });
  writeFileSync(path.join(project, 'a.txt'), 'x\n');
  return {
    plan: buildMounts({ projectRoot: project, taskName: 't1', forbidden: { signerDir } }),
    project,
    signerDir,
  };
}

const BASELINE = [
  'run',
  '--rm',
  '--pull=never',
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--user',
  `${process.getuid!()}:${process.getgid!()}`,
  '--tmpfs',
  '/tmp',
  '--pids-limit',
  '256',
  '--memory',
  '2048m',
  '--cpus',
  '2',
];

test('baseline hardening flags open every invocation, verbatim and in order', () => {
  const base = makeScratchDir('oms-sbx-args-');
  try {
    const { plan } = planFor(base);
    const args = buildRunArgs({
      image: 'node:22-alpine',
      name: 'oms-t1-run-abc',
      argv: ['sh', '-c', 'echo hi'],
      mounts: plan,
      network: 'oms-t1-net',
    });
    assert.deepEqual(args.slice(0, BASELINE.length), BASELINE);
  } finally {
    removeScratchDir(base);
  }
});

test('argv is passed through as an array; no shell string is built', () => {
  const base = makeScratchDir('oms-sbx-args-');
  try {
    const { plan } = planFor(base);
    const argv = ['sh', '-c', 'npm ci && npm test'];
    const args = buildRunArgs({
      image: 'node:22-alpine',
      name: 'n',
      argv,
      mounts: plan,
    });
    assert.deepEqual(args.slice(args.length - argv.length), argv);
    assert.equal(args[args.length - argv.length - 1], 'node:22-alpine');
    // the model command exists only inside the container argv, never wrapped by oms
    assert.ok(!args.slice(0, args.length - argv.length).some((a) => a.includes('npm ci')));
  } finally {
    removeScratchDir(base);
  }
});

test('env is explicit only: host environment is never inherited', () => {
  const base = makeScratchDir('oms-sbx-args-');
  try {
    const { plan } = planFor(base);
    process.env.OMS_SANDBOX_LEAK_PROBE = 'leak-probe-value';
    const args = buildRunArgs({
      image: 'i',
      name: 'n',
      argv: ['env'],
      env: { ONLY_ALLOWED: '1' },
      mounts: plan,
    });
    delete process.env.OMS_SANDBOX_LEAK_PROBE;
    const envValues = args.flatMap((a, i) => (a === '--env' ? [args[i + 1]] : []));
    assert.deepEqual(envValues, ['ONLY_ALLOWED=1']);
    assert.ok(!args.some((a) => a.includes('leak-probe-value')));
  } finally {
    removeScratchDir(base);
  }
});

test('no privileged mode, no docker.sock mount, no host network, ever', () => {
  const base = makeScratchDir('oms-sbx-args-');
  try {
    const { plan } = planFor(base);
    const args = buildRunArgs({
      image: 'i',
      name: 'n',
      argv: ['true'],
      mounts: plan,
      network: 'oms-t1-net',
    });
    assert.ok(!args.includes('--privileged'));
    const net = args[args.indexOf('--network') + 1];
    assert.notEqual(net, 'host');
    assert.ok(!args.some((a) => typeof a === 'string' && a.endsWith('docker.sock')));
  } finally {
    removeScratchDir(base);
  }
});

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test('mounts render in order: project rw, readOnly :ro on top, named volumes, tmpfs shadows', () => {
  const base = makeScratchDir('oms-sbx-args-');
  try {
    const project = path.join(base, 'project');
    const signerDir = path.join(base, 'signerdir');
    const innerSigner = path.join(project, '.oms-signer');
    const verify = path.join(project, '.oms', 'verify');
    mkdirSync(innerSigner, { recursive: true, mode: 0o700 });
    mkdirSync(verify, { recursive: true });
    writeFileSync(path.join(project, 'a.txt'), 'x\n');
    const plan = buildMounts({
      projectRoot: project,
      taskName: 't1',
      // the signer dir is INSIDE the project here, so it gets shadowed
      forbidden: { signerDir: innerSigner },
      readOnlyPaths: [verify],
      heavyDirs: ['node_modules'],
    });
    const args = buildRunArgs({ image: 'i', name: 'n', argv: ['true'], mounts: plan });
    assert.equal(flagValue(args, '-v'), `${realpathSync(project)}:/work:rw`);
    const bindValues = args.flatMap((a, i) => (a === '-v' ? [args[i + 1]] : []));
    assert.ok(bindValues.includes(`${realpathSync(verify)}:/work/.oms/verify:ro`));
    assert.equal(flagValue(args, '--volume'), 'oms-t1-node_modules:/work/node_modules');
    assert.equal(flagValue(args, '--tmpfs') !== undefined, true);
    assert.ok(
      args.some((a) =>
        a.startsWith(`/work/.oms-signer:rw,size=64k,uid=${process.getuid!()},gid=${process.getgid!()},mode=700`),
      ),
    );
    // readOnly overlay must come after the project mount
    assert.ok(
      args.indexOf(`${realpathSync(project)}:/work:rw`) < args.indexOf(`${realpathSync(verify)}:/work/.oms/verify:ro`),
    );
  } finally {
    removeScratchDir(base);
  }
});

test('limits are configurable and default sanely', () => {
  const base = makeScratchDir('oms-sbx-args-');
  try {
    const { plan } = planFor(base);
    const args = buildRunArgs({
      image: 'i',
      name: 'n',
      argv: ['true'],
      mounts: plan,
      limits: { memoryMb: 512, cpus: 1, pidsLimit: 64 },
    });
    const pids = args[args.indexOf('--pids-limit') + 1];
    const mem = args[args.indexOf('--memory') + 1];
    assert.equal(pids, '64');
    assert.equal(mem, '512m');
    assert.deepEqual(DEFAULT_LIMITS, { memoryMb: 2048, cpus: 2, pidsLimit: 256 });
  } finally {
    removeScratchDir(base);
  }
});

test('install proxy env points only at the internal forwarder', () => {
  const env = installProxyEnv('http://oms-fwd:3128');
  assert.equal(env.HTTPS_PROXY, 'http://oms-fwd:3128');
  assert.equal(env.npm_config_proxy, 'http://oms-fwd:3128');
  assert.ok(!Object.values(env).some((v) => v.includes('host.docker.internal')));
});

test('task and shadow ownership comes from the trusted non-root host identity', (t) => {
  assert.equal(typeof process.getuid, 'function');
  assert.equal(typeof process.getgid, 'function');
  const host = process as typeof process & Required<Pick<typeof process, 'getuid' | 'getgid'>>;
  const base = makeScratchDir('oms-sbx-args-');
  try {
    const { plan } = planFor(base);
    t.mock.method(host, 'getuid', () => 501);
    t.mock.method(host, 'getgid', () => 20);
    assert.equal(sandboxUser(), '501:20');
    plan.shadowMounts = ['/work/private'];
    const args = buildRunArgs({ image: 'i', name: 'n', argv: ['true'], mounts: plan });
    assert.equal(flagValue(args, '--user'), '501:20');
    assert.ok(args.includes('/work/private:rw,size=64k,uid=501,gid=20,mode=700'));
  } finally {
    removeScratchDir(base);
  }
});

test('root host identity is an explicit prerequisite failure, not a privileged task', (t) => {
  assert.equal(typeof process.getuid, 'function');
  const host = process as typeof process & Required<Pick<typeof process, 'getuid'>>;
  t.mock.method(host, 'getuid', () => 0);
  assert.throws(() => sandboxUser(), { code: 'E_BAD_ARGUMENT' });
});
