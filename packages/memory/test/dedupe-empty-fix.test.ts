import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capture } from '../src/capture.ts';
import { dedupe } from '../src/dedupe.ts';

test('replaying an exact captured empty fix remains idempotent', async () => {
  const digest = 'a'.repeat(64);
  const result = await capture({
    failure: { reason: 'failed', failureDigest: digest, output: 'error: incompatible argument types in pinned requirements', reopenCount: 1 },
    closure: { closed: true, executionIdentity: digest, evidence: { passed: true, mode: 'offline-snapshot', specificationDigest: digest, codeDigest: digest, verifierDigest: digest, snapshotDigest: digest, at: '2026-11-08T00:00:00Z' } },
    applicability: { framework: 'other', versions: { 'anchor-lang': null, '@solana/kit': null, surfpool: null, agave: null, rustc: null, node: null }, range: {} },
    diff: '', installSalt: 's'.repeat(32), vocabulary: new Set('error incompatible argument types in pinned requirements'.split(' ')), secretForms: [],
  });
  assert.ok(result);
  assert.deepEqual(dedupe([result.lesson], result.lesson), [result.lesson]);
});
