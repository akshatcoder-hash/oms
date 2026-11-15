/**
 * File-read guard tests: allowlist semantics (project root only) plus a
 * protected-path list that must survive symlinks, relative traversal and
 * non-existent tails.
 */

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createReadGuard, type ReadGuard } from '../src/guard.ts';
import { makeTempDir, writeFixtureKeypair, writeFileWithMode } from '../test-support/helpers.ts';
import { realpathSync } from 'node:fs';

interface Fixture {
  root: string;
  outside: string;
  keypairPath: string;
  guard: ReadGuard;
}

function makeFixture(): Fixture {
  const base = realpathSync(makeTempDir());
  const root = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const keypair = writeFixtureKeypair(outside, 'signer.json');
  writeFileSync(join(root, 'src.ts'), 'export const x = 1;\n');
  writeFileSync(join(outside, 'notes.txt'), 'outside\n');
  // The signer keeps its key outside the project; the socket dir is inside.
  mkdirSync(join(root, '.oms-signer'), { mode: 0o700 });
  writeFileWithMode(join(root, '.oms-signer', 'tui.token'), 'secret-token\n', 0o600);
  writeFileSync(join(root, '.oms-signer', 'trace.jsonl'), '{}\n');
  const guard = createReadGuard({
    projectRoot: root,
    deniedPaths: [keypair.path, join(root, '.oms-signer')],
  });
  return { root: realpathSync(root), outside: realpathSync(outside), keypairPath: keypair.path, guard };
}

test('reads inside the project root are allowed', () => {
  const f = makeFixture();
  const decision = f.guard.checkRead(join(f.root, 'src.ts'));
  assert.equal(decision.allowed, true, JSON.stringify(decision));
  assert.equal(decision.resolved, join(f.root, 'src.ts'));
});

test('relative paths are resolved against the project root', () => {
  const f = makeFixture();
  assert.equal(f.guard.checkRead('src.ts').allowed, true);
  assert.equal(f.guard.checkRead('./src.ts').allowed, true);
});

test('absolute paths outside the root are denied', () => {
  const f = makeFixture();
  const decision = f.guard.checkRead(join(f.outside, 'notes.txt'));
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'E_GUARD_OUTSIDE_ROOT');
});

test('relative traversal out of the root is denied (../../etc/passwd)', () => {
  const f = makeFixture();
  for (const attempt of ['../outside/notes.txt', '../../etc/passwd', 'src/../../outside/notes.txt', '/etc/passwd']) {
    const decision = f.guard.checkRead(attempt);
    assert.equal(decision.allowed, false, `${attempt} must be denied`);
    assert.equal(decision.code, 'E_GUARD_OUTSIDE_ROOT', attempt);
  }
});

test('the configured signer keypair is denied even though it is named normally', () => {
  const f = makeFixture();
  const decision = f.guard.checkRead(f.keypairPath);
  assert.equal(decision.allowed, false);
  // It is outside the root as well; either denial is correct, the read must not happen.
  assert.ok(['E_GUARD_DENIED_PATH', 'E_GUARD_OUTSIDE_ROOT'].includes(String(decision.code)));
});

test('a keypair copied inside the root is still denied by exact path', () => {
  const f = makeFixture();
  const insideKey = join(f.root, 'keypair-copy.json');
  writeFileSync(insideKey, '[]\n');
  const guard = createReadGuard({ projectRoot: f.root, deniedPaths: [insideKey] });
  const decision = guard.checkRead(insideKey);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'E_GUARD_DENIED_PATH');
});

test('a symlink inside the root pointing at the keypair is denied', () => {
  const f = makeFixture();
  const link = join(f.root, 'innocent.txt');
  symlinkSync(f.keypairPath, link);
  const decision = f.guard.checkRead(link);
  assert.equal(decision.allowed, false, JSON.stringify(decision));
  assert.equal(decision.code, 'E_GUARD_DENIED_PATH', 'resolves to the protected keypair');
});

test('a symlink pointing inside the root at a protected file is denied', () => {
  const f = makeFixture();
  const link = join(f.outside, 'looks-like-src.ts');
  symlinkSync(join(f.root, 'src.ts'), link);
  // outside -> inside: resolves inside the root, so allowed (and that is correct:
  // it is the same file the project already allows reading).
  assert.equal(f.guard.checkRead(link).allowed, true);

  const tokenLink = join(f.root, 'token-link.txt');
  symlinkSync(join(f.root, '.oms-signer', 'tui.token'), tokenLink);
  const decision = f.guard.checkRead(tokenLink);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'E_GUARD_DENIED_PATH');
});

test('a symlinked directory inside the root cannot be used to escape', () => {
  const f = makeFixture();
  symlinkSync(f.outside, join(f.root, 'escape'));
  const decision = f.guard.checkRead(join(f.root, 'escape', 'notes.txt'));
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'E_GUARD_OUTSIDE_ROOT');
});

test('a symlinked ancestor pointing at the protected directory is denied', () => {
  const f = makeFixture();
  symlinkSync(join(f.root, '.oms-signer'), join(f.root, 'harmless'));
  const decision = f.guard.checkRead(join(f.root, 'harmless', 'tui.token'));
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'E_GUARD_DENIED_PATH');
});

test('directory names that merely start with a protected name are not denied', () => {
  const f = makeFixture();
  mkdirSync(join(f.root, '.oms-signer-backup'));
  writeFileSync(join(f.root, '.oms-signer-backup', 'x.txt'), 'x\n');
  assert.equal(f.guard.checkRead(join(f.root, '.oms-signer-backup', 'x.txt')).allowed, true);
});

test('nonexistent paths under a symlinked escape are still denied', () => {
  const f = makeFixture();
  symlinkSync(f.outside, join(f.root, 'escape2'));
  const decision = f.guard.checkRead(join(f.root, 'escape2', 'does-not-exist.txt'));
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'E_GUARD_OUTSIDE_ROOT');
});

test('bad path inputs are denied', () => {
  const f = makeFixture();
  assert.equal(f.guard.checkRead('').allowed, false);
  assert.equal(f.guard.checkRead('   ').allowed, false);
  assert.equal(f.guard.checkRead('a\u0000b').allowed, false);
  // @ts-expect-error runtime guard against non-string input
  assert.equal(f.guard.checkRead(undefined).allowed, false);
});

test('extraRoots widen the allowlist explicitly and nothing else changes', () => {
  const f = makeFixture();
  const guard = createReadGuard({ projectRoot: f.root, deniedPaths: [f.keypairPath], extraRoots: [f.outside] });
  assert.equal(guard.checkRead(join(f.outside, 'notes.txt')).allowed, true);
  assert.equal(guard.checkRead(f.keypairPath).allowed, false);
  assert.equal(guard.checkRead('/etc/passwd').allowed, false);
});
