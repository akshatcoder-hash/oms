import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { emptyReport } from '../src/report/render.ts';
import { exportReview } from '../src/report/storage.ts';
import { REVIEW_DISCLAIMER } from '../src/disclaimer.ts';

async function fixture() {
  const parent = resolve('.tmp/review-export'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  return { root, out: join(root, 'out'), files: new Map<string, number>(),
    report: emptyReport({ reviewId: 'review-1', createdAt: '2026-11-08T12:00:00.000Z', repo: { commit: '', dirty: false } }),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('explicit export contains only private redacted reports, never logs or proofs', async () => {
  const f = await fixture();
  try {
    f.report.tools.push({ name: 'tool', version: '', status: 'failed', reason: '1'.repeat(64) });
    await exportReview(f);
    assert.deepEqual((await readdir(f.out)).sort(), ['report.json', 'report.md']);
    assert.equal((await stat(f.out)).mode & 0o777, 0o700);
    for (const name of ['report.json', 'report.md']) {
      assert.equal((await stat(join(f.out, name))).mode & 0o777, 0o600);
      const text = await readFile(join(f.out, name), 'utf8');
      assert.ok(!text.includes('1'.repeat(64))); assert.match(text, /REDACTED/);
      assert.equal(text.split(REVIEW_DISCLAIMER).length, 2);
    }
    assert.equal(f.report.tools[0]!.reason, '1'.repeat(64));
  } finally { await f.cleanup(); }
});

test('export refuses existing destinations and symlink ancestors without changing them', async () => {
  const f = await fixture();
  try {
    await mkdir(f.out); await writeFile(join(f.out, 'keep'), 'unchanged');
    await assert.rejects(exportReview(f));
    assert.deepEqual(await readdir(f.out), ['keep']);
    assert.equal(await readFile(join(f.out, 'keep'), 'utf8'), 'unchanged');
    const alias = join(f.root, 'alias'); await symlink(f.out, alias);
    await assert.rejects(exportReview({ ...f, out: alias }));
    await assert.rejects(exportReview({ ...f, out: join(alias, 'nested') }));
    assert.deepEqual(await readdir(f.out), ['keep']);
  } finally { await f.cleanup(); }
});

test('export validates Phase A input and captures it before asynchronous writes', async () => {
  const f = await fixture();
  try {
    await assert.rejects(exportReview({ ...f, report: { ...f.report, phase: 'B' } }));
    await assert.rejects(exportReview({ ...f, out: 'relative' }));
    await assert.rejects(exportReview({ ...f, out: join(f.root, 'bad\npath') }));
    assert.deepEqual(await readdir(f.root), []);
    const promise = exportReview(f); f.report.reviewId = 'changed';
    await promise;
    assert.equal(JSON.parse(await readFile(join(f.out, 'report.json'), 'utf8')).reviewId, 'review-1');
  } finally { await f.cleanup(); }
});

test('competing exports cannot overwrite or delete the successful export', async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([exportReview(f), exportReview(f)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.deepEqual((await readdir(f.out)).sort(), ['report.json', 'report.md']);
    assert.equal(JSON.parse(await readFile(join(f.out, 'report.json'), 'utf8')).reviewId, 'review-1');
  } finally { await f.cleanup(); }
});

test('export rejects extra proof and log fields before writing output', async () => {
  const f = await fixture();
  try {
    for (const extra of [{ proofs: {} }, { logs: 'private' }, { exploit: {} }]) {
      await assert.rejects(exportReview({ ...f, report: { ...f.report, ...extra } }));
    }
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.cleanup(); }
});
