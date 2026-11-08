import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryRecallExtension } from '../src/memory-recall-extension.ts';
import { capture } from '../../memory/src/capture.ts';
import { memoryPath, updateLessons } from '../../memory/src/store.ts';

test('inline and repeated spill gets share one two-thousand-byte failure allowance', async () => {
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
    let injected = Buffer.byteLength(result.content.at(-1)!.text);
    let successful = 0;
    for (let i = 0; i < 30; i++) {
      const text = extension.get('PSECOND');
      if (text !== 'not_found') { injected += Buffer.byteLength(text); successful++; }
    }
    assert.ok(successful > 0);
    assert.ok(injected <= 2_000);
    assert.equal(extension.get(candidate.lesson.id), 'not_found');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
