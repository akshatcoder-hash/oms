import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capLessons, updateLessons } from '../src/store.ts';
import { normalize, sha256 } from '../src/normalize.ts';
import { parseLesson, type Lesson } from '../src/types.ts';

const now = Date.parse('2026-11-08T00:00:00Z');
function lesson(id: number): Lesson {
  const hex = sha256(String(id));
  return parseLesson({
    schema: 'oms.lesson/1', id: `P${id}`, version: 1,
    signature: normalize('error: incompatible argument types in pinned requirements', 'build', 'rustc'),
    applicability: { framework: 'other', versions: { 'anchor-lang': null, '@solana/kit': null, surfpool: null, agave: null, rustc: null, node: null }, range: {} },
    body: { symptom: 'argument types', rootCause: 'incompatible types', fixPattern: 'use compatible types', avoid: null }, fixKey: hex,
    evidence: [{ evidenceTag: hex, verifierDigest: hex, executionIdentity: hex, mode: 'offline-snapshot', reopenCountBefore: 1, failureDigest: hex, at: '2026-11-08T00:00:00Z' }],
    provenance: [{ source: 'local' }], tier: 'quarantined', confirmations: { closed: 1, notClosed: 0, distinctSources: 1 }, refs: [],
    createdAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z',
  });
}

test('staleness uses the latest confirmation regardless of evidence arrival order', () => {
  const rows = Array.from({ length: 501 }, (_, i) => lesson(i));
  // This lesson was recently confirmed, then an older offline receipt arrived.
  rows[0]!.evidence.push({ ...rows[0]!.evidence[0]!, evidenceTag: sha256('late receipt'), at: '2025-01-01T00:00:00Z' });
  rows[0]!.updatedAt = '2026-11-07T00:00:00Z';
  rows[1]!.evidence[0]!.at = '2025-01-01T00:00:00Z';
  const kept = capLessons(rows, now);
  assert.ok(kept.some(row => row.id === 'P0'));
  assert.ok(!kept.some(row => row.id === 'P1'));
});

test('seeded Unicode/escaping and oversized histories never exceed persisted row/byte caps', () => {
  const base = mkdtempSync(join(tmpdir(), 'oms-memory-caps-'));
  const workspace = join(base, 'workspace'); mkdirSync(workspace);
  const path = join(base, 'private', 'lessons.jsonl');
  let seed = 3881;
  try {
    for (const count of [1, 33, 499, 501, 620]) {
      const rows = Array.from({ length: count }, (_, i) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const row = lesson(i);
        row.body.fixPattern = ['界', '\\', '"', '\n'][seed % 4]!.repeat(seed % 601);
        row.tier = i % 11 === 0 ? 'retired' : 'quarantined';
        return row;
      });
      const before = JSON.stringify(rows);
      const kept = updateLessons(path, workspace, () => rows, now);
      const bytes = readFileSync(path);
      assert.ok(kept.length <= 500);
      assert.ok(bytes.byteLength <= 1_000_000);
      assert.equal(bytes.toString(), kept.map(row => JSON.stringify(row) + '\n').join(''));
      assert.equal(JSON.stringify(rows), before);
    }
    const oversized = lesson(999);
    oversized.evidence = Array.from({ length: 3000 }, (_, i) => ({ ...oversized.evidence[0]!, evidenceTag: sha256(String(i)) }));
    assert.deepEqual(updateLessons(path, workspace, () => [oversized], now), []);
    assert.equal(readFileSync(path).byteLength, 0);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
