import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expireReviews, purgeReviews } from '../src/retention.ts';

const now = Date.parse('2026-11-08T12:00:00.000Z');
const day = 86400000;
async function fixture() {
  const parent = resolve('.tmp/retention');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  const repo = join(root, 'repo'); const stateRoot = join(root, 'state');
  await mkdir(repo, { mode: 0o700 }); await mkdir(stateRoot, { mode: 0o700 });
  const repoId = createHash('sha256').update(repo).digest('hex');
  await mkdir(join(stateRoot, 'reviews'), { mode: 0o700 });
  const directory = join(stateRoot, 'reviews', repoId);
  await mkdir(directory, { mode: 0o700 });
  async function review(id: string, age: number) {
    const dir = join(directory, id); await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, 'report.json'), JSON.stringify({ schema: 'oms.review/1', reviewId: id,
      createdAt: new Date(now - age * day).toISOString() }), { mode: 0o600 });
    await mkdir(join(dir, 'proofs'), { mode: 0o700 });
    await writeFile(join(dir, 'proofs', 'control.json'), '{}');
    return dir;
  }
  return { root, repo, stateRoot, directory, review, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('expiry uses report creation time, defaults to 30 days, and removes nested material', async () => {
  const f = await fixture();
  try {
    await f.review('old', 31); await f.review('boundary', 30); await f.review('recent', 29); await f.review('future', -1);
    const result = await expireReviews({ ...f, now });
    assert.deepEqual(result.deleted, ['boundary', 'old']);
    assert.deepEqual(await readdir(f.directory), ['future', 'recent']);
    assert.equal(result.retained.length, 1); assert.equal(result.retained[0]?.reviewId, 'future');
    assert.deepEqual((await expireReviews({ ...f, now, retentionDays: 28 })).deleted, ['recent']);
  } finally { await f.cleanup(); }
});

test('purge is scoped to the current repo, explicit id or all, with no consent deletion', async () => {
  const f = await fixture();
  try {
    await f.review('one', 1); await f.review('two', 1);
    const other = join(f.stateRoot, 'reviews', 'other'); await mkdir(other); await writeFile(join(other, 'sentinel'), 'keep');
    await mkdir(join(f.stateRoot, 'review-consent')); await writeFile(join(f.stateRoot, 'review-consent', 'sentinel'), 'keep');
    assert.deepEqual((await purgeReviews({ ...f, reviewId: 'one' })).deleted, ['one']);
    assert.deepEqual(await readdir(f.directory), ['two']);
    assert.deepEqual((await purgeReviews({ ...f, reviewId: 'all' })).deleted, ['two']);
    assert.equal(await readFile(join(other, 'sentinel'), 'utf8'), 'keep');
    assert.equal(await readFile(join(f.stateRoot, 'review-consent', 'sentinel'), 'utf8'), 'keep');
    assert.deepEqual((await purgeReviews({ ...f, reviewId: 'missing' })).deleted, []);
  } finally { await f.cleanup(); }
});

test('invalid selectors and retention settings cannot delete anything', async () => {
  const f = await fixture();
  try {
    await f.review('keep', 100);
    for (const reviewId of ['..', '../keep', '/tmp', 'a/b', 'a\\b', '', '.hidden']) {
      await assert.rejects(purgeReviews({ ...f, reviewId }));
    }
    for (const retentionDays of [-1, 0, NaN, Infinity, 0.5]) await assert.rejects(expireReviews({ ...f, now, retentionDays }));
    await assert.rejects(expireReviews({ ...f, now: NaN }));
    assert.deepEqual(await readdir(f.directory), ['keep']);
  } finally { await f.cleanup(); }
});

test('expiry retains malformed, mismatched, oversized and symlink report metadata', async () => {
  const f = await fixture();
  try {
    for (const id of ['bad', 'mismatch', 'large', 'link']) await f.review(id, 90);
    await writeFile(join(f.directory, 'bad', 'report.json'), '{}');
    await writeFile(join(f.directory, 'mismatch', 'report.json'), JSON.stringify({ schema: 'oms.review/1', reviewId: 'other', createdAt: new Date(0).toISOString() }));
    await writeFile(join(f.directory, 'large', 'report.json'), ' '.repeat(4 * 1024 * 1024 + 1));
    await rm(join(f.directory, 'link', 'report.json'));
    await symlink(join(f.directory, 'mismatch', 'report.json'), join(f.directory, 'link', 'report.json'));
    const result = await expireReviews({ ...f, now });
    assert.deepEqual(result.deleted, []); assert.equal(result.retained.length, 4);
    // Explicit purge does not depend on parseable metadata.
    assert.equal((await purgeReviews({ ...f, reviewId: 'all' })).deleted.length, 4);
  } finally { await f.cleanup(); }
});

test('symlink review directories stay untouched; symlinks inside a purged review are not followed', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'sentinel'), 'keep');
    await symlink(outside, join(f.directory, 'linked'));
    const dir = await f.review('real', 90); await symlink(outside, join(dir, 'outside'));
    const result = await purgeReviews({ ...f, reviewId: 'all' });
    assert.deepEqual(result.deleted, ['real']); assert.equal(result.retained[0]?.reviewId, 'linked');
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep');
  } finally { await f.cleanup(); }
});

test('state ancestors must be private real directories outside the workspace', async () => {
  const f = await fixture();
  try {
    await f.review('keep', 90);
    await chmod(f.directory, 0o755);
    await assert.rejects(purgeReviews({ ...f, reviewId: 'all' }));
    await chmod(f.directory, 0o700);
    const alias = join(f.root, 'alias'); await symlink(f.stateRoot, alias);
    await assert.rejects(purgeReviews({ ...f, stateRoot: alias, reviewId: 'all' }));
    await assert.rejects(purgeReviews({ ...f, stateRoot: f.repo, reviewId: 'all' }));
    assert.deepEqual(await readdir(f.directory), ['keep']);
    await rm(f.directory, { recursive: true });
    await symlink(f.repo, f.directory);
    await assert.rejects(purgeReviews({ ...f, reviewId: 'all' }));
  } finally { await f.cleanup(); }
});

test('absent review state is a no-op without creating directories', async () => {
  const f = await fixture();
  try {
    await rm(join(f.stateRoot, 'reviews'), { recursive: true });
    assert.deepEqual((await expireReviews({ ...f, now })).deleted, []);
    assert.deepEqual((await purgeReviews({ ...f, reviewId: 'all' })).deleted, []);
    assert.deepEqual(await readdir(f.stateRoot), []);
  } finally { await f.cleanup(); }
});
