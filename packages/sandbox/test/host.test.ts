import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { hostEnvironment, runInSandbox, type HostRunOptions } from '../src/index.ts';

function fixture(): HostRunOptions {
  const root = mkdtempSync(path.join(tmpdir(), 'oms-host-'));
  return {
    backend: 'host',
    taskName: 'fixture',
    phase: 'run',
    argv: [process.execPath, '-e', 'console.log(process.cwd())'],
    mounts: {
      projectMount: { hostPath: root, containerPath: '/work', mode: 'rw' },
      extraMounts: [],
      readOnlyMounts: [],
      volumes: [],
      shadowMounts: [],
    },
    timeoutMs: 5000,
  };
}

test('host environment excludes credentials and unlisted variables from both sources', () => {
  const secrets = Object.fromEntries(
    ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'PRIVATE'].map((name) => [`TEST_${name}`, 'fixture-secret']),
  );
  assert.deepEqual(
    hostEnvironment(
      { ...secrets, NODE_OPTIONS: '--inspect', SOLANA_RPC_URL: 'http://127.0.0.1:8899' },
      { ...secrets, PATH: '/bin', RANDOM: 'no' },
    ),
    { PATH: '/bin', SOLANA_RPC_URL: 'http://127.0.0.1:8899' },
  );
});

test('host environment never inherits HOME but keeps the real toolchain dirs', () => {
  assert.deepEqual(hostEnvironment({ HOME: '/private' }, { HOME: '/home/real' }), {
    HOME: '/private',
    CARGO_HOME: '/home/real/.cargo',
    RUSTUP_HOME: '/home/real/.rustup',
  });
  assert.deepEqual(hostEnvironment({}, { HOME: '/home/real', CARGO_HOME: '/opt/cargo' }), {
    CARGO_HOME: '/opt/cargo',
    RUSTUP_HOME: '/home/real/.rustup',
  });
});

test('host command runs with a private HOME that is removed afterwards', async () => {
  const o = fixture();
  try {
    o.argv = [
      process.execPath,
      '-e',
      'console.log(JSON.stringify({home:process.env.HOME,cargo:process.env.CARGO_HOME,rustup:process.env.RUSTUP_HOME}))',
    ];
    const value = JSON.parse((await runInSandbox(o)).stdout);
    assert.notEqual(value.home, homedir());
    assert.equal(value.cargo, process.env.CARGO_HOME ?? path.join(homedir(), '.cargo'));
    assert.equal(value.rustup, process.env.RUSTUP_HOME ?? path.join(homedir(), '.rustup'));
    assert.equal(existsSync(value.home), false);
  } finally {
    rmSync(o.mounts.projectMount.hostPath, { recursive: true, force: true });
  }
});

test('host command executes in real task root without Docker or inherited secrets', async () => {
  const o = fixture();
  try {
    o.argv = [process.execPath, '-e', 'console.log(JSON.stringify({cwd:process.cwd(),env:process.env}))'];
    o.env = {
      ANTHROPIC_API_KEY: 'fixture-secret',
      NODE_OPTIONS: '--inspect',
      SURFNET_RPC_URL: 'http://127.0.0.1:8899',
    };
    const result = await runInSandbox(o);
    assert.equal(result.exitCode, 0);
    const value = JSON.parse(result.stdout);
    // macOS: tmpdir() is /var/... while the process sees /private/var/...
    assert.equal(realpathSync(value.cwd), realpathSync(o.mounts.projectMount.hostPath));
    assert.equal(value.env.SURFNET_RPC_URL, o.env.SURFNET_RPC_URL);
    assert.equal(value.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(value.env.NODE_OPTIONS, undefined);
  } finally {
    rmSync(o.mounts.projectMount.hostPath, { recursive: true, force: true });
  }
});

test('host command caps output and enforces timeout', async () => {
  const o = fixture();
  try {
    const result = await runInSandbox({
      ...o,
      argv: [process.execPath, '-e', 'console.log("abcdefgh"); setInterval(()=>{},1000)'],
      timeoutMs: 300,
      stdoutLimitBytes: 4,
    });
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
    assert.equal(result.stdout, 'abcd');
    assert.equal(result.truncated, true);
  } finally {
    rmSync(o.mounts.projectMount.hostPath, { recursive: true, force: true });
  }
});

test('dependency link tampering reports uncertain cleanup and retains source ownership', async () => {
  const o = fixture();
  const dependencies = mkdtempSync(path.join(tmpdir(), 'oms-host-deps-'));
  const control = mkdtempSync(path.join(tmpdir(), 'oms-host-source-'));
  try {
    o.sourceControlDir = control;
    o.mounts.readOnlyMounts = [{ hostPath: dependencies, containerPath: '/work/node_modules', mode: 'ro' }];
    o.argv = [process.execPath, '-e', 'require("fs").unlinkSync("node_modules")'];
    await assert.rejects(runInSandbox(o), AggregateError);
  } finally {
    rmSync(o.mounts.projectMount.hostPath, { recursive: true, force: true });
    rmSync(dependencies, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  }
});

test('empty dependency mountpoint is restored with its exact mode despite umask', async () => {
  const o = fixture();
  const dependencyRoot = mkdtempSync(path.join(tmpdir(), 'oms-host-deps-mode-'));
  const target = path.join(o.mounts.projectMount.hostPath, 'node_modules');
  mkdirSync(target);
  chmodSync(target, 0o777);
  const previousMask = process.umask(0o077);
  try {
    o.mounts.readOnlyMounts = [{ hostPath: dependencyRoot, containerPath: '/work/node_modules', mode: 'ro' }];
    const result = await runInSandbox(o);
    assert.equal(result.exitCode, 0);
    assert.equal(statSync(target).mode & 0o777, 0o777);
  } finally {
    process.umask(previousMask);
    rmSync(o.mounts.projectMount.hostPath, { recursive: true, force: true });
    rmSync(dependencyRoot, { recursive: true, force: true });
  }
});

test('runs that share the source lease overlap, while a run that does not share is refused beside them', async () => {
  const sleep = [process.execPath, '-e', 'setTimeout(() => console.log("slept"), 400)'];
  const control = mkdtempSync(path.join(tmpdir(), 'oms-control-'));
  const o = { ...fixture(), argv: sleep, sourceControlDir: control, timeoutMs: 10_000 };
  try {
    const started = Date.now();
    const results = await Promise.all([
      runInSandbox({ ...o, sharedSource: true }),
      runInSandbox({ ...o, sharedSource: true }),
    ]);
    assert.deepEqual(
      results.map((result) => result.stdout.trim()),
      ['slept', 'slept'],
    );
    assert.ok(Date.now() - started < 1500, 'both ran in the time of one');
    const shared = runInSandbox({ ...o, sharedSource: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(runInSandbox(o), /source is in use/);
    await shared;
    assert.equal((await runInSandbox(o)).stdout.trim(), 'slept', 'the lease is free again afterwards');
  } finally {
    rmSync(o.mounts.projectMount.hostPath, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  }
});
