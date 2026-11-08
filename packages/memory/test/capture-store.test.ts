import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureAndStore } from '../src/capture-store.ts';
import type { CaptureInput } from '../src/capture.ts';
import { memoryPath, readLessons } from '../src/store.ts';

function input(): CaptureInput {
  const digest = 'a'.repeat(64);
  return {
    failure: { reason: 'failed', failureDigest: digest, output: 'error: incompatible argument types in pinned requirements', reopenCount: 1 },
    closure: { closed: true, executionIdentity: digest, evidence: { passed: true, mode: 'offline-snapshot', specificationDigest: digest, codeDigest: digest, verifierDigest: digest, snapshotDigest: digest, at: '2026-11-08T00:00:00Z' } },
    applicability: { framework: 'other', versions: { 'anchor-lang': null, '@solana/kit': null, surfpool: null, agave: null, rustc: null, node: null }, range: {} },
    diff: '', installSalt: 's'.repeat(32), vocabulary: new Set('error incompatible argument types in check the pinned requirements and reproduce passing offline checks earlier independent verification failed'.split(' ')), secretForms: []
  };
}

test('capture persists outside workspace and confirms each fresh closure once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-capture-store-'));
  try {
    const workspace = join(root, 'repo'); mkdirSync(workspace);
    const home = join(root, 'home');
    const options = { home, workspace };
    const first = await captureAndStore(options, input());
    assert.ok(first);
    const path = memoryPath(home, workspace);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    await captureAndStore(options, input());
    const fresh = input(); fresh.closure.evidence.codeDigest = 'b'.repeat(64);
    await captureAndStore(options, fresh);
    const rows = readLessons(path);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.confirmations.closed, 2);
    assert.equal(rows[0]!.evidence.length, 2);
    assert.equal(rows[0]!.tier, 'quarantined');
    assert.equal(existsSync(join(workspace, '.oms')), false);
    assert.equal(existsSync(memoryPath(home)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejected closures create no store; workspace-contained memory is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-capture-reject-'));
  try {
    const workspace = join(root, 'repo'); mkdirSync(workspace);
    const home = join(root, 'home');
    const rejected = input(); rejected.closure.evidence.passed = false;
    assert.equal(await captureAndStore({ home, workspace }, rejected), null);
    assert.equal(existsSync(home), false);
    await assert.rejects(captureAndStore({ home: workspace, workspace }, input()), /outside workspace/);
    assert.equal(existsSync(memoryPath(workspace, workspace)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
