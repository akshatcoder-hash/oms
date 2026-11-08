import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMemoryHistory } from '../src/memory-history.ts';
import { capture, type CaptureFailure } from '../../memory/src/capture.ts';
const digest = 'a'.repeat(64);
test('journal replay preserves canonical code and capture identity while remaining local-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-history-code-'));
  const vocabulary = new Set('error trait bound is not satisfied the earlier independent verification failed check pinned requirements and reproduce passing offline checks'.split(' '));
  try {
    for (const diagnostic of ['error[E0277]: trait bound is not satisfied', 'error TS2345: trait bound is not satisfied', 'error anchor:3012 trait bound is not satisfied', 'error program:0x1770 trait bound is not satisfied']) {
      const failure: CaptureFailure = { reason: 'failed', output: diagnostic, failureDigest: digest, reopenCount: 1 };
      const history = createMemoryHistory({ path: join(dir, 'history.json'), scope: digest, vocabulary, secretForms: [] });
      history.set('one', failure);
      const input = { closure: { closed: true, executionIdentity: digest, evidence: { passed: true, mode: 'offline-snapshot', specificationDigest: digest, codeDigest: digest, verifierDigest: digest, snapshotDigest: digest, at: '2026-11-08T00:00:00Z' } }, applicability: { framework: 'other' as const, versions: { 'anchor-lang': null, '@solana/kit': null, surfpool: null, agave: null, rustc: null, node: null }, range: {} }, diff: '', installSalt: 's'.repeat(32), vocabulary, secretForms: [] };
      const direct = await capture({ ...input, failure });
      const replay = await capture({ ...input, failure: history.get('one') });
      assert.ok(direct && replay);
      assert.equal(replay.lesson.signature.code, direct.lesson.signature.code);
      assert.equal(replay.lesson.signature.key, direct.lesson.signature.key);
      assert.equal(replay.lesson.id, direct.lesson.id);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
