import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryCapture } from '../src/memory-extension.ts';
import { memoryPath, readLessons } from '../../memory/src/store.ts';
import type { MemoryObservation } from '../src/memory-observer.ts';

const digest = 'a'.repeat(64);
function event(): MemoryObservation {
  return { itemId: 'one', failure: { reason: 'failed', output: 'error: incompatible argument types in pinned requirements', failureDigest: digest, reopenCount: 1 },
    closure: { closed: true, executionIdentity: digest, evidence: { passed: true, mode: 'offline-snapshot', specificationDigest: digest, codeDigest: digest, verifierDigest: digest, snapshotDigest: digest, at: '2026-11-08T00:00:00Z' } } };
}
const vocabulary = new Set('error incompatible argument types in check the pinned requirements and reproduce passing offline checks earlier independent verification failed anchor-lang'.split(' '));
test('host capture sink resolves lockfiles and stores replay once without a model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-memory-extension-'));
  try {
    const workspace = join(root, 'repo'); mkdirSync(workspace);
    writeFileSync(join(workspace, 'Cargo.lock'), '[[package]]\nname = "anchor-lang"\nversion = "1.2.2"\n');
    const sink = createMemoryCapture({ home: join(root, 'home'), workspace, installSalt: 's'.repeat(32), vocabulary, secretForms: [],
      runtime: { surfpool: '1.7.0', agave: null, rustc: null, node: null } });
    await sink(event()); await sink(event());
    const rows = readLessons(memoryPath(join(root, 'home'), workspace));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.confirmations.closed, 1);
    assert.equal(rows[0]!.applicability.framework, 'anchor');
    assert.equal(rows[0]!.applicability.versions['anchor-lang'], '1.2.2');
    assert.equal(rows[0]!.tier, 'quarantined');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
