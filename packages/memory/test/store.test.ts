import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capLessons, updateLessons, readLessons } from '../src/store.ts';
import { parseLesson, type Lesson } from '../src/types.ts';
import { normalize } from '../src/normalize.ts';
const hex = 'a'.repeat(64);
function lesson(id: number): Lesson { return { schema: 'oms.lesson/1', id: `P${id}`, version: 1, signature: normalize('error: argument types are incompatible', 'build', 'rustc'), applicability: { framework: 'anchor', versions: { 'anchor-lang': '1.2.2', '@solana/kit': null, surfpool: null, agave: null, rustc: null, node: null }, range: {} }, body: { symptom: 'argument types', rootCause: 'incompatible types', fixPattern: 'use compatible types', avoid: null }, fixKey: hex, evidence: [{ evidenceTag: hex, verifierDigest: hex, executionIdentity: hex, mode: 'offline-snapshot', reopenCountBefore: 1, failureDigest: hex, at: '2026-11-08T00:00:00Z' }], provenance: [{ source: 'local' }], tier: 'quarantined', confirmations: { closed: 1, notClosed: 0, distinctSources: 1 }, refs: [], createdAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z' }; }
test('schema rejects extra fields and missing offline evidence', () => {
  assert.doesNotThrow(() => parseLesson(lesson(0)));
  assert.throws(() => parseLesson({ ...lesson(0), sourceCode: 'private' }));
  assert.throws(() => parseLesson({ ...lesson(0), evidence: [] }));
});
test('store caps row count and bytes and removes retired first', () => {
  const rows = Array.from({ length: 700 }, (_, i) => lesson(i));
  rows[699]!.tier = 'retired';
  const kept = capLessons(rows, Date.parse('2026-11-08T00:00:00Z'));
  assert.ok(kept.length <= 500);
  assert.ok(Buffer.byteLength(kept.map(row => JSON.stringify(row) + '\n').join('')) <= 1_000_000);
  assert.ok(!kept.some(row => row.id === 'P699'));
});
test('atomic store roundtrip and workspace containment', () => {
  const base = mkdtempSync(join(tmpdir(), 'oms-memory-'));
  const workspace = join(base, 'workspace'); mkdirSync(workspace);
  try {
    const path = join(base, 'private', 'lessons.jsonl');
    updateLessons(path, workspace, () => [lesson(1)]);
    assert.deepEqual(readLessons(path), [lesson(1)]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => updateLessons(join(workspace, 'lessons.jsonl'), workspace, () => []));
    updateLessons(path, workspace, rows => rows.filter(row => row.id !== 'P1'));
    assert.deepEqual(readLessons(path), []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
