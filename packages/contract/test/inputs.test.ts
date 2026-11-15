import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  digestCodeInputs,
  saveCodeInputs,
  MAX_INPUT_BYTES,
  MAX_SNAPSHOT_BYTES,
  snapshotDigest,
} from '../src/inputs.ts';
import { makeProject } from '../test-support/fixture.ts';

test('saving inputs copies exact bytes and excludes Git control data only', (t) => {
  const p = makeProject();
  t.after(() => p.cleanup());
  mkdirSync(join(p.root, '.git'));
  writeFileSync(join(p.root, '.git', 'config'), 'private repository configuration');
  writeFileSync(join(p.root, '.gitignore'), 'new.mjs\n');
  writeFileSync(join(p.root, 'new.mjs'), 'export const value = 1;');
  const saved = saveCodeInputs(p.root, p.config);
  t.after(() => saved.dispose());
  assert.equal(readFileSync(join(saved.codeRoot, 'new.mjs'), 'utf8'), 'export const value = 1;');
  assert.throws(() => readFileSync(join(saved.codeRoot, '.git', 'config')));
  writeFileSync(join(p.root, 'new.mjs'), 'export const value = 2;');
  assert.notEqual(digestCodeInputs(p.root, p.config), saved.codeDigest);
  assert.equal(readFileSync(join(saved.codeRoot, 'new.mjs'), 'utf8'), 'export const value = 1;');
});

test('input capture refuses symlink escapes instead of copying outside bytes', (t) => {
  const p = makeProject();
  t.after(() => p.cleanup());
  writeFileSync(join(p.outside, 'secret'), 'sentinel');
  symlinkSync(join(p.outside, 'secret'), join(p.root, 'imported.mjs'));
  assert.throws(() => saveCodeInputs(p.root, p.config), /outside/);
});

test('input and snapshot caps reject sparse oversized files before reading them', (t) => {
  const p = makeProject();
  t.after(() => p.cleanup());
  truncateSync(p.codePath, MAX_INPUT_BYTES + 1);
  assert.throws(() => saveCodeInputs(p.root, p.config), /256 MiB/);
  truncateSync(join(p.root, p.config.snapshotPath!), MAX_SNAPSHOT_BYTES + 1);
  assert.throws(() => snapshotDigest(p.root, p.config), /64 MiB/);
});

test('complete membership preserves empty directories, new files and contained relative symlinks', (t) => {
  const p = makeProject();
  t.after(() => p.cleanup());
  mkdirSync(join(p.root, 'empty'));
  writeFileSync(join(p.root, 'untracked.mjs'), 'export const value = 7;', { mode: 0o755 });
  symlinkSync('untracked.mjs', join(p.root, 'alias.mjs'));
  symlinkSync('empty', join(p.root, 'directory-alias'));
  symlinkSync('missing-inside-root', join(p.root, 'dangling'));
  const saved = saveCodeInputs(p.root, p.config);
  t.after(() => saved.dispose());
  assert.equal(readFileSync(join(saved.codeRoot, 'alias.mjs'), 'utf8'), 'export const value = 7;');
  assert.equal(digestCodeInputs(saved.codeRoot, p.config), saved.codeDigest);
  writeFileSync(join(p.root, 'added-after-capture'), 'new member');
  assert.notEqual(digestCodeInputs(p.root, p.config), saved.codeDigest);
});
