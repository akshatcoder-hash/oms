import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvaluateResult, Evaluator } from '@oms/contract';
import { observeMemory, type MemoryObservation } from '../src/memory-observer.ts';

const digest = 'a'.repeat(64);
function closed(): Extract<EvaluateResult, { closed: true }> {
  return { closed: true, reason: 'verified', itemId: 'one', cached: false,
    evaluatedAt: '2026-11-08T00:00:00Z', evidence: {
      itemId: 'one', passed: true, mode: 'offline-snapshot',
      specificationDigest: digest, codeDigest: digest, verifierDigest: digest,
      snapshotDigest: digest, at: '2026-11-08T00:00:00Z', details: 'passed',
    } };
}
const failed: EvaluateResult = { closed: false, reason: 'failed', itemId: 'one',
  detail: 'error: verifier requires initialized account', reopenCount: 1, cached: false };
function fixture(results: EvaluateResult[], observe: (event: MemoryObservation) => Promise<void>) {
  const evaluator: Evaluator = {
    evaluate: async () => results.shift()!,
    read: () => { throw new Error('unused'); },
    reopen: () => { throw new Error('unused'); },
  };
  return observeMemory(evaluator, { executionIdentity: digest, observe });
}

test('only a trusted failure followed by passing offline closure is observed once', async () => {
  const events: MemoryObservation[] = [];
  const evaluator = fixture([failed, closed(), closed()], async event => { events.push(event); });
  await Promise.all([evaluator.evaluate('one'), evaluator.evaluate('one'), evaluator.evaluate('one')]);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.failure.output, failed.detail);
  assert.match(events[0]!.failure.failureDigest, /^[a-f0-9]{64}$/);
});

test('runner errors, another item, forked and failed evidence cannot capture', async () => {
  const runnerError: EvaluateResult = { ...failed, reason: 'runner-error' };
  const forked = closed(); forked.evidence.mode = 'forked';
  const notPassed = closed(); notPassed.evidence.passed = false;
  for (const results of [[closed()], [runnerError, closed()], [failed, forked], [failed, notPassed]]) {
    let calls = 0;
    const evaluator = fixture(results.slice(), async () => { calls++; });
    for (const _ of results) await evaluator.evaluate('one');
    assert.equal(calls, 0);
  }
  let calls = 0;
  const evaluator = fixture([failed, closed()], async () => { calls++; });
  await evaluator.evaluate('two'); await evaluator.evaluate('one');
  assert.equal(calls, 0);
});

test('capture failure cannot replace the evaluator result or poison later evaluations', async () => {
  const result = closed();
  const evaluator = fixture([failed, result, closed()], async () => { throw new Error('disk full'); });
  await evaluator.evaluate('one');
  assert.equal(await evaluator.evaluate('one'), result);
  assert.equal((await evaluator.evaluate('one')).closed, true);
});
