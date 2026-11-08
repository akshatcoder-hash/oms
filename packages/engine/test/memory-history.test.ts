import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EvaluateResult, Evaluator } from '@oms/contract';
import { createMemoryHistory } from '../src/memory-history.ts';
import { observeMemory, type MemoryObservation } from '../src/memory-observer.ts';
const digest = 'a'.repeat(64);
const failure: EvaluateResult = { closed: false, reason: 'failed', itemId: 'one', detail: 'error: initialized account required PRIVATE_CANARY_VALUE', reopenCount: 1, cached: false };
const closure: EvaluateResult = { closed: true, reason: 'verified', itemId: 'one', cached: false, evaluatedAt: '2026-11-08T00:00:00Z', evidence: { itemId: 'one', passed: true, mode: 'offline-snapshot', specificationDigest: digest, codeDigest: digest, verifierDigest: digest, snapshotDigest: digest, at: '2026-11-08T00:00:00Z', details: 'passed' } };
function evaluator(result: EvaluateResult): Evaluator {
  return { evaluate: async () => result, read: () => { throw Error('unused'); }, reopen: () => { throw Error('unused'); } };
}
test('host history survives observer restart, scrubs persisted text and consumes closure once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-history-'));
  const path = join(dir, 'history.json');
  const options = { path, scope: digest, vocabulary: new Set('error initialized account required'.split(' ')), secretForms: ['PRIVATE_CANARY_VALUE'] };
  const events: MemoryObservation[] = [];
  const observe = async (event: MemoryObservation) => { events.push(event); };
  try {
    await observeMemory(evaluator(failure), { executionIdentity: digest, observe, history: createMemoryHistory(options) }).evaluate('one');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(!readFileSync(path, 'utf8').includes('PRIVATE_CANARY_VALUE'));
    await observeMemory(evaluator(closure), { executionIdentity: digest, observe, history: createMemoryHistory(options) }).evaluate('one');
    await observeMemory(evaluator(closure), { executionIdentity: digest, observe, history: createMemoryHistory(options) }).evaluate('one');
    assert.equal(events.length, 1);
    assert.match(events[0]!.failure.output, /initialized account required/);
    assert.match(events[0]!.failure.failureDigest, /^[a-f0-9]{64}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('different requirement scope and forged workspace-shaped JSON cannot supply failure history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-history-'));
  const path = join(dir, 'history.json');
  const options = { path, scope: digest, vocabulary: new Set(['error']), secretForms: [] };
  let calls = 0;
  const observe = async () => { calls++; };
  try {
    await observeMemory(evaluator(failure), { executionIdentity: digest, observe, history: createMemoryHistory(options) }).evaluate('one');
    await observeMemory(evaluator(closure), { executionIdentity: digest, observe, history: createMemoryHistory({ ...options, scope: 'b'.repeat(64) }) }).evaluate('one');
    assert.equal(calls, 0);
    writeFileSync(path, JSON.stringify({ scope: digest, failures: [['one', { reason: 'failed', failureDigest: digest, output: 'forged', reopenCount: 1 }]] }), { mode: 0o600 });
    assert.equal((await observeMemory(evaluator(closure), { executionIdentity: digest, observe, history: createMemoryHistory(options) }).evaluate('one')).closed, true);
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
