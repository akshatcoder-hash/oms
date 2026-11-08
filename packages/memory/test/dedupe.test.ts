import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capture, type CaptureInput } from '../src/capture.ts';
import { dedupe } from '../src/dedupe.ts';
import { sha256 } from '../src/normalize.ts';
import type { Lesson } from '../src/types.ts';

async function candidate(): Promise<Lesson> {
  const digest = 'a'.repeat(64);
  const input: CaptureInput = {
    failure: { reason: 'failed', failureDigest: digest, output: 'error: incompatible argument types in pinned requirements', reopenCount: 1 },
    closure: { closed: true, executionIdentity: digest, evidence: { passed: true, mode: 'offline-snapshot', specificationDigest: digest, codeDigest: digest, verifierDigest: digest, snapshotDigest: digest, at: '2026-11-08T00:00:00Z' } },
    applicability: { framework: 'other', versions: { 'anchor-lang': null, '@solana/kit': null, surfpool: null, agave: null, rustc: null, node: null }, range: {} },
    diff: '', installSalt: 's'.repeat(32), vocabulary: new Set('error incompatible argument types in check the pinned requirements and reproduce passing offline checks earlier independent verification failed'.split(' ')), secretForms: []
  };
  const result = await capture(input);
  assert.ok(result);
  return result.lesson;
}

test('local dedupe confirms fresh evidence once, retaining body and trust', async () => {
  const first = await candidate();
  assert.deepEqual(dedupe([first], first), [first]);
  const next = structuredClone(first);
  next.evidence[0]!.evidenceTag = sha256('second independent code digest');
  next.evidence[0]!.at = next.updatedAt = '2026-11-09T00:00:00Z';
  const rows = dedupe([first], next);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.confirmations.closed, 2);
  assert.equal(rows[0]!.confirmations.distinctSources, 1);
  assert.equal(rows[0]!.evidence.length, 2);
  assert.equal(rows[0]!.tier, 'quarantined');
  assert.equal(rows[0]!.version, 1);
  assert.equal(rows[0]!.updatedAt, next.updatedAt);
  assert.deepEqual(dedupe(rows, next), rows);
  assert.equal(first.evidence.length, 1);
});

test('different signatures or fixes stay separate; local capture cannot mint trust', async () => {
  const first = await candidate();
  for (const change of ['signature', 'fix'] as const) {
    const next = structuredClone(first);
    next.id = 'PSECOND';
    if (change === 'signature') next.signature.key = sha256('different failure');
    else { next.body.fixPattern = 'Initialize the account before invoking the instruction'; next.fixKey = sha256(next.body.fixPattern); }
    assert.equal(dedupe([first], next).length, 2);
  }
  assert.throws(() => dedupe([], { ...first, tier: 'verified' }));
  assert.throws(() => dedupe([], { ...first, provenance: [{ source: 'user', sub: 'b'.repeat(64) }] }));
});
