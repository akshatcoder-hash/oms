import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryRecallExtension } from '../src/memory-recall-extension.ts';
import { capture } from '../../memory/src/capture.ts';
import { memoryPath, updateLessons } from '../../memory/src/store.ts';

test('spill get reveals only served local ids for 24 hours, respects removal and shares injection allowance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oms-spill-get-'));
  const workspace = join(root, 'repo'); mkdirSync(workspace);
  const home = join(root, 'home'); const digest = 'a'.repeat(64);
  try {
    const candidate = await capture({ failure: { reason: 'failed', failureDigest: digest, output: 'error incompatible argument types', reopenCount: 1 },
      closure: { closed: true, executionIdentity: digest, evidence: { passed: true, mode: 'offline-snapshot', specificationDigest: digest, codeDigest: digest, verifierDigest: digest, snapshotDigest: digest, at: '2026-11-08T00:00:00Z' } },
      applicability: { framework: 'other', versions: { 'anchor-lang': null, '@solana/kit': null, surfpool: null, agave: null, rustc: null, node: null }, range: {} }, diff: '', installSalt: 's'.repeat(32),
      vocabulary: new Set('error incompatible argument types check the pinned requirements and reproduce passing offline checks earlier independent verification failed'.split(' ')), secretForms: [] });
    assert.ok(candidate);
    const second = structuredClone(candidate.lesson); second.id = 'PSECOND'; second.body.fixPattern = 'Check the pinned requirements.';
    const path = memoryPath(home, workspace);
    updateLessons(path, workspace, () => [candidate.lesson, second]);
    let now = 0;
    const extension = createMemoryRecallExtension({ home, workspace, tokenCap: 100_000, clock: () => now });
    let onResult: (event: unknown) => unknown = () => undefined;
    extension({ on: (_name: string, callback: typeof onResult) => { onResult = callback; } } as never);
    assert.equal(extension.get('PSECOND'), extension.get('nonexistent'));
    const result = await onResult({ toolName: 'bash', isError: true, content: [{ type: 'text', text: 'error incompatible argument types' }] }) as { content: { text: string }[] };
    assert.ok(result.content.at(-1)!.text.includes('PSECOND'));
    assert.match(extension.get('PSECOND'), /trust="untrusted"/);
    now += 24 * 60 * 60 * 1000;
    assert.equal(extension.get('PSECOND'), 'not_found');
    now = 0;
    await onResult({ toolName: 'bash', isError: true, content: [{ type: 'text', text: 'error incompatible argument types' }] });
    updateLessons(path, workspace, () => []);
    assert.equal(extension.get('PSECOND'), 'not_found');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
