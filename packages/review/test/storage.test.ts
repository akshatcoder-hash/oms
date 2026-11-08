import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { emptyReport } from '../src/report/render.ts';
import { saveReview } from '../src/report/storage.ts';
import { parseReviewReport } from '../src/types.ts';
import { expireReviews, purgeReviews } from '../src/retention.ts';
import { REVIEW_DISCLAIMER } from '../src/disclaimer.ts';

async function fixture() {
  const parent = resolve('.tmp/review-storage');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  const repo = join(root, 'repo'); const stateRoot = join(root, 'state');
  await mkdir(repo, { mode: 0o700 }); await mkdir(stateRoot, { mode: 0o700 });
  await writeFile(join(repo, 'sentinel'), 'unchanged');
  const report = emptyReport({ reviewId: 'review-1', createdAt: '2026-11-08T12:00:00.000Z', repo: { commit: '', dirty: false } });
  const files = new Map([['src/lib.rs', 5]]);
  return { root, repo, stateRoot, report, files, logs: '', cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('saves private reports outside the checkout with disclaimer and retention-compatible metadata', async () => {
  const f = await fixture();
  try {
    const saved = await saveReview(f);
    assert.equal(saved.directory, join(f.stateRoot, 'reviews', createHash('sha256').update(f.repo).digest('hex'), 'review-1'));
    assert.deepEqual((await readdir(saved.directory)).sort(), ['logs.txt', 'report.json', 'report.md']);
    for (const dir of [f.stateRoot, join(f.stateRoot, 'reviews'), resolve(saved.directory, '..'), saved.directory]) {
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    }
    for (const name of ['logs.txt', 'report.json', 'report.md']) assert.equal((await stat(join(saved.directory, name))).mode & 0o777, 0o600);
    const json = await readFile(join(saved.directory, 'report.json'), 'utf8');
    assert.deepEqual(parseReviewReport(JSON.parse(json)), f.report);
    const md = await readFile(join(saved.directory, 'report.md'), 'utf8');
    assert.ok(md.startsWith(REVIEW_DISCLAIMER)); assert.equal(md.split(REVIEW_DISCLAIMER).length, 2);
    assert.deepEqual(await readdir(f.repo), ['sentinel']); assert.equal(await readFile(join(f.repo, 'sentinel'), 'utf8'), 'unchanged');
    assert.deepEqual((await expireReviews({ ...f, now: Date.parse('2026-12-09T12:00:00Z') })).deleted, ['review-1']);
  } finally { await f.cleanup(); }
});

test('never overwrites an existing review, including concurrent writers and symlink destinations', async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([saveReview(f), saveReview(f)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const saved = results.find(r => r.status === 'fulfilled')!;
    assert.equal(saved.status, 'fulfilled');
    if (saved.status !== 'fulfilled') throw new Error('missing result');
    const before = await readFile(join(saved.value.directory, 'report.json'), 'utf8');
    await assert.rejects(saveReview(f));
    assert.equal(await readFile(join(saved.value.directory, 'report.json'), 'utf8'), before);
    await rm(saved.value.directory, { recursive: true }); await symlink(f.repo, saved.value.directory);
    await assert.rejects(saveReview(f)); assert.deepEqual(await readdir(f.repo), ['sentinel']);
  } finally { await f.cleanup(); }
});

test('refuses unsafe state locations and insecure or symlinked ancestors', async () => {
  const f = await fixture();
  try {
    await assert.rejects(saveReview({ ...f, stateRoot: f.repo }));
    await mkdir(join(f.repo, 'nested'), { mode: 0o700 });
    await assert.rejects(saveReview({ ...f, stateRoot: join(f.repo, 'nested') }));
    await assert.rejects(saveReview({ ...f, stateRoot: 'relative' }));
    const alias = join(f.root, 'alias'); await symlink(f.stateRoot, alias);
    await assert.rejects(saveReview({ ...f, stateRoot: alias }));
    await chmod(f.stateRoot, 0o755); await assert.rejects(saveReview(f)); await chmod(f.stateRoot, 0o700);
    await symlink(f.repo, join(f.stateRoot, 'reviews')); await assert.rejects(saveReview(f));
    assert.deepEqual((await readdir(f.repo)).sort(), ['nested', 'sentinel']);
  } finally { await f.cleanup(); }
});

test('validates metadata and resource bounds before creating report storage', async () => {
  const f = await fixture();
  try {
    for (const reviewId of ['../outside', 'all', '.hidden', 'a/b', 'a\\b', '1'.repeat(64)]) {
      await assert.rejects(saveReview({ ...f, report: { ...f.report, reviewId } }));
    }
    for (const createdAt of ['invalid', '2026-11-08', '2026-11-08T12:00:00Z']) {
      await assert.rejects(saveReview({ ...f, report: { ...f.report, createdAt } }));
    }
    await assert.rejects(saveReview({ ...f, logs: 'x'.repeat(1024 * 1024 + 1) }));
    await assert.rejects(saveReview({ ...f, report: { ...f.report, tools: Array.from({ length: 1200 }, () => ({ name: 'tool', version: 'x'.repeat(4000), status: 'ok' as const })) } }));
    assert.deepEqual(await readdir(f.stateRoot), []);
  } finally { await f.cleanup(); }
});

test('scrubs persisted prose and logs and drops invalid locations without mutating the input', async () => {
  const f = await fixture();
  try {
    const key = '1'.repeat(64); // Synthetic encoding of 64 zero bytes, never a real credential.
    f.report.tools.push({ name: 'tool', version: '', status: 'failed', reason: `value ${key}` });
    f.report.findings.push({ id: 'bad', label: 'suspected', class: 'missing-owner', severity: 'high', title: 'bad',
      location: { file: '../outside', line: 1 }, sources: ['static'], explanation: '', fix: '', staticHits: [] });
    f.report.totals.suspected = 1; delete f.report.emptyNote;
    const original = structuredClone(f.report);
    const saved = await saveReview({ ...f, logs: `${key}\n-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----` });
    for (const name of ['report.json', 'report.md', 'logs.txt']) {
      const content = await readFile(join(saved.directory, name), 'utf8');
      assert.ok(!content.includes(key)); assert.ok(!content.includes('synthetic')); assert.ok(content.includes(name === 'report.md' ? '\\[REDACTED\\]' : '[REDACTED]'));
    }
    const report = parseReviewReport(JSON.parse(await readFile(join(saved.directory, 'report.json'), 'utf8')));
    assert.equal(report.findings.length, 0); assert.equal(report.totals.invalidModelOutputs, 1);
    assert.deepEqual(f.report, original);
  } finally { await f.cleanup(); }
});

test('captures report, log and inventory inputs before asynchronous filesystem work', async () => {
  const f = await fixture();
  try {
    const promise = saveReview(f);
    f.report.reviewId = '../changed'; f.report.createdAt = 'invalid'; f.files.clear();
    const saved = await promise;
    assert.equal(parseReviewReport(JSON.parse(await readFile(join(saved.directory, 'report.json'), 'utf8'))).reviewId, 'review-1');
  } finally { await f.cleanup(); }
});

test('refuses a checkout inside the output tree even when stateRoot is outside the checkout', async () => {
  const f = await fixture();
  try {
    const repo = join(f.stateRoot, 'reviews');
    await mkdir(repo, { mode: 0o700 });
    await writeFile(join(repo, 'sentinel'), 'keep');
    await assert.rejects(saveReview({ ...f, repo }));
    assert.deepEqual(await readdir(repo), ['sentinel']);
    const nested = join(repo, 'nested'); await mkdir(nested, { mode: 0o700 });
    await assert.rejects(saveReview({ ...f, repo: nested }));
    assert.deepEqual(await readdir(nested), []);
  } finally { await f.cleanup(); }
});

test('retention rejects its state subtree as a checkout without mutation', async () => {
  const f = await fixture();
  try {
    const repo = join(f.stateRoot, 'reviews'); await mkdir(repo, { mode: 0o700 });
    await writeFile(join(repo, 'sentinel'), 'keep');
    await assert.rejects(expireReviews({ ...f, repo }));
    await assert.rejects(purgeReviews({ ...f, repo, reviewId: 'all' }));
    assert.deepEqual(await readdir(repo), ['sentinel']);
  } finally { await f.cleanup(); }
});
