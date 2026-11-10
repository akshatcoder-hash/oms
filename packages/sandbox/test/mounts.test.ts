/**
 * Unit tests for the mount allowlist. No Docker required.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SandboxError, isSandboxError } from '../src/errors.ts';
import { buildMounts, type BuildMountsOptions } from '../src/mounts.ts';
import { makeScratchDir, removeScratchDir } from '../src/docker.ts';

const HOME = homedir();

function fixture(): { base: string; project: string; signerDir: string; stateDir: string } {
  const base = makeScratchDir('oms-sbx-unit-');
  const project = path.join(base, 'project');
  const signerDir = path.join(base, 'signerdir');
  const stateDir = path.join(base, 'oms-state');
  mkdirSync(project, { recursive: true });
  mkdirSync(signerDir, { mode: 0o700 });
  mkdirSync(stateDir, { mode: 0o700 });
  writeFileSync(path.join(signerDir, 'channel.token'), 'FAKE-TOKEN-NOT-REAL\n', { mode: 0o600 });
  writeFileSync(path.join(project, 'a.txt'), 'hello\n');
  return { base, project, signerDir, stateDir };
}

function opts(
  f: ReturnType<typeof fixture>,
  over: Partial<BuildMountsOptions> = {},
): BuildMountsOptions {
  return {
    projectRoot: f.project,
    taskName: 'demo',
    forbidden: { signerDir: f.signerDir, stateDir: f.stateDir },
    ...over,
  };
}

function expectCode(fn: () => unknown, code: SandboxError['code']): void {
  try {
    fn();
  } catch (e) {
    assert.ok(isSandboxError(e), `expected SandboxError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    return;
  }
  assert.fail(`expected SandboxError ${code}, but nothing was thrown`);
}

test('project mount is rw at /work with named volumes for heavy dirs', () => {
  const f = fixture();
  try {
    const plan = buildMounts(opts(f));
    assert.deepEqual(plan.projectMount, {
      hostPath: realpathSync(f.project),
      containerPath: '/work',
      mode: 'rw',
    });
    assert.deepEqual(
      plan.volumes.map((v) => v.name),
      ['oms-demo-node_modules', 'oms-demo-target'],
    );
    assert.deepEqual(
      plan.volumes.map((v) => v.containerPath),
      ['/work/node_modules', '/work/target'],
    );
    assert.deepEqual(plan.shadowMounts, []);
  } finally {
    removeScratchDir(f.base);
  }
});

test('readOnlyPaths come out :ro on top of the project mount', () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.project, '.oms'));
    const verifier = path.join(f.project, '.oms', 'verify');
    mkdirSync(verifier);
    writeFileSync(path.join(verifier, 'v.test.ts'), 'ok\n');
    const plan = buildMounts(
      opts(f, { readOnlyPaths: [path.join(f.project, '.oms', 'verify'), path.join(f.project, 'a.txt')] }),
    );
    const ro = plan.readOnlyMounts;
    assert.equal(ro.length, 2);
    assert.ok(ro.every((m) => m.mode === 'ro'), 'readOnlyPaths must be :ro');
    assert.deepEqual(
      ro.map((m) => m.containerPath),
      ['/work/.oms/verify', '/work/a.txt'],
    );
  } finally {
    removeScratchDir(f.base);
  }
});

test('signer dir is rejected: itself, inside it, and via any parent', () => {
  const f = fixture();
  try {
    expectCode(
      () => buildMounts(opts(f, { extra: [{ hostPath: f.signerDir, containerPath: '/s' }] })),
      'E_MOUNT_FORBIDDEN',
    );
    // a child inside the signer dir
    const child = path.join(f.signerDir, 'channel.token');
    expectCode(
      () => buildMounts(opts(f, { extra: [{ hostPath: child, containerPath: '/s' }] })),
      'E_MOUNT_FORBIDDEN',
    );
    // a parent that contains the signer dir
    expectCode(
      () => buildMounts(opts(f, { extra: [{ hostPath: f.base, containerPath: '/b' }] })),
      'E_MOUNT_FORBIDDEN',
    );
  } finally {
    removeScratchDir(f.base);
  }
});

test('well-known paths are rejected even when not supplied', () => {
  const f = fixture();
  try {
    for (const p of [
      path.join(HOME, '.ssh'),
      path.join(HOME, '.aws'),
      path.join(HOME, '.config', 'solana'),
      path.join(HOME, '.config', 'solana', 'id.json'),
      '/var/run/docker.sock',
      HOME,
      '/',
    ]) {
      expectCode(
        () => buildMounts(opts(f, { extra: [{ hostPath: p, containerPath: '/x' }] })),
        'E_MOUNT_FORBIDDEN',
      );
    }
    // /Users (an ancestor of home) would expose home -> contains ~/.ssh -> rejected
    expectCode(
      () =>
        buildMounts(
          opts(f, { extra: [{ hostPath: path.dirname(HOME), containerPath: '/x' }] }),
        ),
      'E_MOUNT_FORBIDDEN',
    );
  } finally {
    removeScratchDir(f.base);
  }
});

test('state/token dir subtree is rejected, including .. and symlink tricks', () => {
  const f = fixture();
  try {
    // lexical .. traversal into the signer dir
    const viaDotDot = path.join(f.project, '..', 'signerdir');
    expectCode(
      () => buildMounts(opts(f, { extra: [{ hostPath: viaDotDot, containerPath: '/s' }] })),
      'E_MOUNT_FORBIDDEN',
    );
    // project-internal symlink pointing at the signer dir
    const link = path.join(f.project, 'innocent');
    symlinkSync(f.signerDir, link);
    expectCode(
      () => buildMounts(opts(f, { extra: [{ hostPath: link, containerPath: '/s' }] })),
      'E_MOUNT_SYMLINK_ESCAPE',
    );
    // a symlinked path inside the project that resolves OUTSIDE the project
    const outside = path.join(f.base, 'outside');
    mkdirSync(outside);
    const escape = path.join(f.project, 'escape');
    symlinkSync(outside, escape);
    expectCode(
      () => buildMounts(opts(f, { readOnlyPaths: [escape] })),
      'E_MOUNT_SYMLINK_ESCAPE',
    );
  } finally {
    removeScratchDir(f.base);
  }
});

test('project root cannot be home, /, or a forbidden dir', () => {
  const f = fixture();
  try {
    expectCode(() => buildMounts(opts(f, { projectRoot: HOME })), 'E_MOUNT_FORBIDDEN');
    expectCode(() => buildMounts(opts(f, { projectRoot: '/' })), 'E_MOUNT_FORBIDDEN');
    expectCode(() => buildMounts(opts(f, { projectRoot: f.signerDir })), 'E_MOUNT_FORBIDDEN');
    expectCode(
      () => buildMounts(opts(f, { projectRoot: path.join(f.project, '..', 'signerdir') })),
      'E_MOUNT_FORBIDDEN',
    );
  } finally {
    removeScratchDir(f.base);
  }
});

test('project roots below forbidden trees are rejected through real and lexical symlink paths', () => {
  const f = fixture();
  try {
    const nested = path.join(f.signerDir, 'nested', 'project');
    mkdirSync(nested, { recursive: true });
    const alias = path.join(f.base, 'alias');
    symlinkSync(f.signerDir, alias);
    for (const projectRoot of [nested, path.join(alias, 'nested', 'project')]) {
      expectCode(() => buildMounts(opts(f, { projectRoot })), 'E_MOUNT_FORBIDDEN');
    }
    const outward = path.join(f.signerDir, 'outward');
    symlinkSync(f.project, outward);
    expectCode(() => buildMounts(opts(f, { projectRoot: outward })), 'E_MOUNT_FORBIDDEN');
    const home = path.join(f.base, 'fake-home');
    mkdirSync(path.join(home, '.ssh', 'project'), { recursive: true });
    expectCode(() => buildMounts(opts(f, {
      projectRoot: path.join(home, '.ssh', 'project'),
      forbidden: { signerDir: f.signerDir, homeDir: home },
    })), 'E_MOUNT_FORBIDDEN');
  } finally {
    removeScratchDir(f.base);
  }
});

test('project cannot contain the configured home but ordinary home descendants remain allowed', () => {
  const f = fixture();
  try {
    expectCode(() => buildMounts(opts(f, {
      projectRoot: f.base,
      forbidden: { signerDir: f.signerDir, homeDir: f.project },
    })), 'E_MOUNT_FORBIDDEN');
    const plan = buildMounts(opts(f, {
      forbidden: { signerDir: f.signerDir, homeDir: f.base },
    }));
    assert.equal(plan.projectMount.hostPath, realpathSync(f.project));
  } finally {
    removeScratchDir(f.base);
  }
});

test('forbidden paths absent at planning time still have shadows', () => {
  const f = fixture();
  try {
    const privateDir = path.join(f.project, '.private', 'future');
    const plan = buildMounts(opts(f, { forbidden: { signerDir: privateDir } }));
    assert.deepEqual(plan.shadowMounts, ['/work/.private/future']);
  } finally {
    removeScratchDir(f.base);
  }
});

test('dot-prefixed descendants do not evade forbidden containment', () => {
  const f = fixture();
  try {
    const nested = path.join(f.signerDir, '..hidden');
    mkdirSync(nested);
    expectCode(() => buildMounts(opts(f, { projectRoot: nested })), 'E_MOUNT_FORBIDDEN');
  } finally {
    removeScratchDir(f.base);
  }
});

test('readOnlyPaths must be inside the project and outside forbidden trees', () => {
  const f = fixture();
  try {
    // an existing directory outside the project
    const outside = path.join(f.base, 'outside');
    mkdirSync(outside);
    expectCode(() => buildMounts(opts(f, { readOnlyPaths: [outside] })), 'E_MOUNT_OUTSIDE_PROJECT');
    expectCode(() => buildMounts(opts(f, { readOnlyPaths: [path.join(f.base, 'nope')] })), 'E_MOUNT_MISSING');
    // a forbidden signer dir inside the project may not be readOnlyPaths either
    const inner = path.join(f.project, '.oms-signer');
    mkdirSync(inner, { mode: 0o700 });
    writeFileSync(path.join(inner, 't'), 'x\n');
    expectCode(
      () =>
        buildMounts({
          projectRoot: f.project,
          taskName: 'demo',
          forbidden: { signerDir: inner, stateDir: f.stateDir },
          readOnlyPaths: [inner],
        }),
      'E_MOUNT_FORBIDDEN',
    );
    expectCode(() => buildMounts(opts(f, { readOnlyPaths: [path.join(f.base, 'nope')] })), 'E_MOUNT_MISSING');
  } finally {
    removeScratchDir(f.base);
  }
});

test('a forbidden dir inside the project is shadowed with a tmpfs, not rejected', () => {
  const f = fixture();
  try {
    const innerSigner = path.join(f.project, '.oms-signer');
    mkdirSync(innerSigner, { mode: 0o700 });
    writeFileSync(path.join(innerSigner, 'tui.token'), 'tok\n', { mode: 0o600 });
    const plan = buildMounts(
      opts(f, { forbidden: { signerDir: innerSigner, stateDir: f.stateDir } }),
    );
    assert.deepEqual(plan.shadowMounts, ['/work/.oms-signer']);
  } finally {
    removeScratchDir(f.base);
  }
});

test('missing mount sources and bad task names are rejected', () => {
  const f = fixture();
  try {
    expectCode(
      () => buildMounts(opts(f, { extra: [{ hostPath: path.join(f.base, 'missing'), containerPath: '/m' }] })),
      'E_MOUNT_MISSING',
    );
    expectCode(() => buildMounts(opts(f, { taskName: 'bad_task!' })), 'E_BAD_ARGUMENT');
    expectCode(
      () => buildMounts(opts(f, { extra: [{ hostPath: f.project, containerPath: 'relative' }] })),
      'E_BAD_ARGUMENT',
    );
    // extra mount may not overlap the project container mount
    expectCode(
      () => buildMounts(opts(f, { extra: [{ hostPath: f.base, containerPath: '/work/sub' }] })),
      'E_MOUNT_CONFLICT',
    );
  } finally {
    removeScratchDir(f.base);
  }
});

test('default forbidden paths apply when only the signer dir is supplied', () => {
  const f = fixture();
  try {
    const plan = buildMounts({ projectRoot: f.project, taskName: 'demo', forbidden: { signerDir: f.signerDir } });
    assert.equal(plan.projectMount.mode, 'rw');
    expectCode(
      () =>
        buildMounts({
          projectRoot: f.project,
          taskName: 'demo',
          forbidden: { signerDir: f.signerDir },
          extra: [{ hostPath: path.join(HOME, '.ssh'), containerPath: '/ssh' }],
        }),
      'E_MOUNT_FORBIDDEN',
    );
  } finally {
    removeScratchDir(f.base);
  }
});

test('heavy dir names are sanitized', () => {
  const f = fixture();
  try {
    expectCode(() => buildMounts(opts(f, { heavyDirs: ['../evil'] })), 'E_BAD_ARGUMENT');
    const plan = buildMounts(opts(f, { heavyDirs: ['target'] }));
    assert.deepEqual(plan.volumes, [{ name: 'oms-demo-target', containerPath: '/work/target' }]);
  } finally {
    removeScratchDir(f.base);
  }
});

test('file modes are not the control: a 0600 token stays 0600 in the fixture', () => {
  // Documents the probe finding this package must design around: bind mounts
  // expose 0600 files regardless of mode, hence the allowlist above.
  const f = fixture();
  try {
    chmodSync(path.join(f.signerDir, 'channel.token'), 0o600);
    const ok = (): unknown =>
      buildMounts(opts(f, { extra: [{ hostPath: f.signerDir, containerPath: '/s' }] }));
    expectCode(ok, 'E_MOUNT_FORBIDDEN');
  } finally {
    removeScratchDir(f.base);
  }
});

test('extra sources cannot be the writable project, its descendants or overlapping writable binds', () => {
  const f = fixture();
  try {
    const nested = path.join(f.project, 'bind-source');
    mkdirSync(nested);
    for (const source of [f.project, nested]) {
      expectCode(() => buildMounts(opts(f, { extra: [{ hostPath: source, containerPath: '/output' }] })), 'E_MOUNT_FORBIDDEN');
    }
    const output = path.join(f.base, 'output');
    mkdirSync(output, { mode: 0o700 });
    mkdirSync(path.join(output, 'nested'));
    expectCode(() => buildMounts(opts(f, { extra: [
      { hostPath: output, containerPath: '/output' },
      { hostPath: path.join(output, 'nested'), containerPath: '/other' },
    ] })), 'E_MOUNT_FORBIDDEN');
  } finally { removeScratchDir(f.base); }
});

test('disjoint output sources require a private host parent; immutable projects remain supported', () => {
  const f = fixture();
  try {
    const output = path.join(f.base, 'output');
    mkdirSync(output);
    const plan = buildMounts(opts(f, { projectMode: 'ro', heavyDirs: [], extra: [{ hostPath: output, containerPath: '/output' }] }));
    assert.equal(plan.projectMount.mode, 'ro');
    assert.equal(plan.extraMounts[0]?.mode, 'rw');
    chmodSync(f.base, 0o755);
    expectCode(() => buildMounts(opts(f, { extra: [{ hostPath: output, containerPath: '/output' }] })), 'E_MOUNT_FORBIDDEN');
  } finally { removeScratchDir(f.base); }
});

// Docker bind safety requires root-owned alias dirs; macOS temp dirs are user-owned, and Docker mounts are Linux/bench only.
test('read-only overlays sit inside a writable project, always :ro, and nothing else may', { skip: process.platform === 'darwin' && 'Docker mounts are checked on Linux' }, () => {
  const f = fixture();
  try {
    const deps = path.join(f.base, 'locked-deps');
    mkdirSync(path.join(deps, 'node_modules'), { recursive: true });
    const plan = buildMounts(opts(f, { heavyDirs: [],
      readOnlyOverlays: [{ hostPath: path.join(deps, 'node_modules'), containerPath: '/work/node_modules' }] }));
    assert.equal(plan.projectMount.mode, 'rw');
    assert.deepEqual(plan.extraMounts, [{ hostPath: path.join(deps, 'node_modules'), containerPath: '/work/node_modules', mode: 'ro' }]);
    expectCode(() => buildMounts(opts(f, { readOnlyOverlays: [{ hostPath: deps, containerPath: '/elsewhere' }] })), 'E_BAD_ARGUMENT');
    expectCode(() => buildMounts(opts(f, { readOnlyOverlays: [{ hostPath: deps, containerPath: '/work' }] })), 'E_BAD_ARGUMENT');
    expectCode(() => buildMounts(opts(f, { readOnlyOverlays: [{ hostPath: f.signerDir, containerPath: '/work/s' }] })), 'E_MOUNT_FORBIDDEN');
    // The generic extra-mount rule is unchanged: a writable extra inside the project is still a conflict.
    expectCode(() => buildMounts(opts(f, { extra: [{ hostPath: deps, containerPath: '/work/node_modules' }] })), 'E_MOUNT_CONFLICT');
  } finally { removeScratchDir(f.base); }
});
