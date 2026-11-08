import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capture, type CaptureInput } from '../src/capture.ts';
import { dedupe } from '../src/dedupe.ts';

const digest = 'a'.repeat(64);
async function captured(version: string, codeDigest: string) {
  const input: CaptureInput = {
    failure: { reason: 'failed', failureDigest: digest, output: 'error: incompatible argument types in pinned requirements', reopenCount: 1 },
    closure: { closed: true, executionIdentity: digest, evidence: { passed: true, mode: 'offline-snapshot', specificationDigest: digest, codeDigest, verifierDigest: digest, snapshotDigest: digest, at: '2026-11-08T00:00:00Z' } },
    applicability: { framework: 'anchor', versions: { 'anchor-lang': version, '@solana/kit': null, surfpool: null, agave: null, rustc: null, node: null }, range: { 'anchor-lang': `=${version}` } },
    diff: '', installSalt: 's'.repeat(32), vocabulary: new Set('error incompatible argument types in check the pinned requirements and reproduce passing offline checks earlier independent verification failed'.split(' ')), secretForms: []
  };
  const result = await capture(input);
  assert.ok(result);
  return result.lesson;
}

test('same capture id across changed runtime pins becomes a version without broadening ranges', async () => {
  const first = await captured('1.2.2', digest);
  const second = await captured('1.2.3', 'b'.repeat(64));
  assert.equal(first.id, second.id);
  const rows = dedupe([first], second);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.version, 2);
  assert.equal(rows[0]!.confirmations.closed, 2);
  assert.deepEqual(rows[0]!.applicability, second.applicability);
  assert.equal(rows[0]!.applicability.range['anchor-lang'], '=1.2.3');
  assert.deepEqual(dedupe(rows, second), rows);
  // Replaying old evidence must not roll pins back or manufacture a version.
  assert.deepEqual(dedupe(rows, first), rows);
});

test('applicability equality ignores object insertion order', async () => {
  const first = await captured('1.2.2', digest);
  const second = await captured('1.2.2', 'b'.repeat(64));
  second.applicability = { range: second.applicability.range, versions: Object.fromEntries(Object.entries(second.applicability.versions).reverse()) as typeof second.applicability.versions, framework: second.applicability.framework };
  const rows = dedupe([first], second);
  assert.equal(rows[0]!.version, 1);
  assert.equal(rows[0]!.confirmations.closed, 2);
});
