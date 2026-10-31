/**
 * Evaluator rules, one test per rule:
 * pin mismatch, proposed-only, forked evidence, cache, reopen cap, binding.
 * Plus the generator-facing surface, which must not be able to close anything.
 */

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readContractFile } from '../src/contract-io.ts';
import {
  createEvaluator,
  createProposer,
  type EvaluatorOptions,
  type Runner,
} from '../src/evaluator.ts';
import { createVerifierCache } from '../src/evidence.ts';
import { verifyPin } from '../src/pin.ts';
import type { TaskContract } from '../src/types.ts';
import {
  FIXED_TIME,
  countingRunner,
  evidenceFor,
  makeProject,
  type Project,
} from '../test-support/fixture.ts';

function makeEvaluator(
  project: Project,
  runner: Runner,
  extra: Partial<EvaluatorOptions> = {},
) {
  return createEvaluator({ pinFile: project.pinFile, ...project.roots, runner,
  clock: () => FIXED_TIME,
  ...extra, });
}

function propose(project: Project, itemId = 'item-1'): void {
  const proposer = createProposer({ ...project.roots, pinFile: project.pinFile });
  const result = proposer.propose(itemId);
  assert.equal(result.ok, true, `propose failed: ${JSON.stringify(result)}`);
}

function onDisk(project: Project): TaskContract {
  const read = readContractFile(project.contractPath);
  assert.equal(read.ok, true, JSON.stringify(read));
  if (!read.ok) throw new Error('unreachable');
  return read.value;
}

test('only a proposed item can be evaluated', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner = countingRunner();
  const evaluator = makeEvaluator(project, runner.runner);

  const active = await evaluator.evaluate('item-1');
  assert.deepEqual(active, { closed: false, reason: 'not-proposed', itemId: 'item-1', status: 'active' });

  const open = await evaluator.evaluate('item-2');
  assert.equal(open.reason, 'not-proposed');

  const unknown = await evaluator.evaluate('nope');
  assert.deepEqual(unknown, { closed: false, reason: 'unknown-item', itemId: 'nope' });
  assert.equal(runner.calls(), 0, 'the runner must not run for a refused evaluation');
});

test('a passing offline run closes the item, records evidence and re-pins', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner = countingRunner();
  const evaluator = makeEvaluator(project, runner.runner);

  propose(project);
  const result = await evaluator.evaluate('item-1');
  assert.equal(result.closed, true, JSON.stringify(result));
  if (!result.closed) return;
  assert.equal(result.reason, 'verified');
  assert.equal(result.cached, false);
  assert.equal(result.evidence.mode, 'offline-snapshot');
  assert.equal(runner.calls(), 1);

  const contract = onDisk(project);
  const item = contract.items[0];
  assert.ok(item);
  assert.equal(item.status, 'closed');
  assert.deepEqual(item.evidence, result.evidence);

  // The evaluator's own write must not look like tampering to the next check.
  assert.equal(verifyPin(project.pinFile, project.roots).ok, true);

  const again = await evaluator.evaluate('item-1');
  assert.deepEqual(again, {
    closed: false,
    reason: 'not-proposed',
    itemId: 'item-1',
    status: 'closed',
  });
  assert.equal(runner.calls(), 1, 'a closed item is never re-run');
});

test('a verifier edit after pinning makes the evaluator refuse', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner = countingRunner();
  const evaluator = makeEvaluator(project, runner.runner);

  propose(project);
  writeFileSync(project.verifierPath, "// weakened\ntest.skip('all');\n");

  const result = await evaluator.evaluate('item-1');
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'pin-mismatch');
  if (result.reason !== 'pin-mismatch') return;
  const verifierMismatch = result.mismatches.find((mismatch) => mismatch.what === 'verifier');
  assert.ok(verifierMismatch, JSON.stringify(result.mismatches));
  assert.deepEqual(verifierMismatch.files, ['tests/verifier.test.ts']);
  assert.equal(runner.calls(), 0);
  assert.equal(onDisk(project).items[0]?.status, 'proposed');
});

test('editing task.json to close an item is refused', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner = countingRunner();
  const evaluator = makeEvaluator(project, runner.runner);

  propose(project);
  const forged = onDisk(project);
  const item = forged.items[0];
  assert.ok(item);
  item.status = 'closed';
  item.evidence = {
    itemId: 'item-1',
    specificationDigest: 'e'.repeat(64),
    codeDigest: 'a'.repeat(64),
    verifierDigest: 'b'.repeat(64),
    snapshotDigest: 'c'.repeat(64),
    mode: 'offline-snapshot',
    passed: true,
    details: 'the model says it works',
    at: FIXED_TIME.toISOString(),
  };
  project.writeContractRaw(`${JSON.stringify(forged, null, 2)}\n`);

  const result = await evaluator.evaluate('item-1');
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'pin-mismatch');
  if (result.reason === 'pin-mismatch') {
    assert.ok(result.mismatches.some((mismatch) => mismatch.what === 'contract'));
  }
  assert.equal(runner.calls(), 0);
});

test('mainnet-forked evidence is labeled and cannot close an item', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner = countingRunner({ mode: 'forked' });
  const evaluator = makeEvaluator(project, runner.runner);

  propose(project);
  const result = await evaluator.evaluate('item-1');
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'forked-evidence');
  if (result.reason === 'forked-evidence') {
    assert.equal(result.evidence.mode, 'forked');
    assert.match(result.detail, /offline snapshot/);
  }

  const item = onDisk(project).items[0];
  assert.equal(item?.status, 'proposed', 'the item stays proposed');
  assert.equal(item?.evidence, undefined, 'no evidence is recorded for a fork');
  assert.equal(runner.calls(), 1, 'forked runs are not cached');
});

test('a cache hit skips the runner', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner = countingRunner();
  const cache = createVerifierCache();
  const evaluator = makeEvaluator(project, runner.runner, { cache });

  propose(project);
  const first = await evaluator.evaluate('item-1');
  assert.equal(first.closed, true);
  assert.equal(runner.calls(), 1);
  assert.equal(cache.size(), 1);

  const reopened = evaluator.reopen('item-1');
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  propose(project);

  const second = await evaluator.evaluate('item-1');
  assert.equal(second.closed, true, JSON.stringify(second));
  if (second.closed) assert.equal(second.cached, true);
  assert.equal(runner.calls(), 1, 'the cached result must not re-run the verifier');
});

test('a changed code revision misses the cache', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner = countingRunner();
  const cache = createVerifierCache();
  const evaluator = makeEvaluator(project, runner.runner, { cache });

  propose(project);
  assert.equal((await evaluator.evaluate('item-1')).closed, true);
  evaluator.reopen('item-1');
  propose(project);

  writeFileSync(project.codePath, 'export const amount = 999;\n');
  const result = await evaluator.evaluate('item-1');
  assert.equal(result.closed, true, JSON.stringify(result));
  if (result.closed) assert.equal(result.cached, false);
  assert.equal(runner.calls(), 2);
});

test('failing runs are bounded by the reopen cap and then block the item', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner = countingRunner({ passed: false });
  const evaluator = makeEvaluator(project, runner.runner, {
    maxReopen: 2,
    cache: createVerifierCache(),
  });

  propose(project);
  const first = await evaluator.evaluate('item-1');
  assert.equal(first.closed, false);
  assert.equal(first.reason, 'failed');
  if (first.reason === 'failed') {
    assert.equal(first.reopenCount, 1);
    assert.equal(first.cached, false);
  }
  assert.equal(onDisk(project).items[0]?.status, 'active');

  propose(project);
  // The second evaluate replays the cached failure: no new verifier run, but it
  // still counts toward the cap so a proposal loop cannot spin forever.
  const second = await evaluator.evaluate('item-1');
  assert.equal(second.reason, 'reopen-cap');
  if (second.reason === 'reopen-cap') assert.equal(second.reopenCount, 2);
  assert.equal(runner.calls(), 1);

  const blockedItem = onDisk(project).items[0];
  assert.equal(blockedItem?.status, 'blocked');
  assert.equal(blockedItem?.reopenCount, 2);

  const third = await evaluator.evaluate('item-1');
  assert.deepEqual(third, { closed: false, reason: 'blocked', itemId: 'item-1', reopenCount: 2 });
});

test('a runner crash counts as a failed attempt and never closes', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  let calls = 0;
  const runner: Runner = async () => {
    calls += 1;
    throw new Error('surfnet RPC died');
  };
  const evaluator = makeEvaluator(project, runner, { maxReopen: 2 });

  propose(project);
  const first = await evaluator.evaluate('item-1');
  assert.equal(first.closed, false);
  assert.equal(first.reason, 'runner-error');
  if (first.reason === 'runner-error') {
    assert.equal(first.reopenCount, 1);
    assert.match(first.detail, /surfnet RPC died/);
  }

  propose(project);
  const second = await evaluator.evaluate('item-1');
  assert.equal(second.reason, 'reopen-cap');
  assert.equal(calls, 2);
  assert.equal(onDisk(project).items[0]?.status, 'blocked');
});

test('evidence not bound to the pinned digests cannot close an item', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner: Runner = async (item, ctx) =>
    evidenceFor(item, ctx, { verifierDigest: 'f'.repeat(64) });
  const evaluator = makeEvaluator(project, runner);

  propose(project);
  const result = await evaluator.evaluate('item-1');
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'evidence-not-bound');
  if (result.reason === 'evidence-not-bound') {
    assert.match(result.detail, /verifierDigest/);
  }
  const item = onDisk(project).items[0];
  assert.equal(item?.status, 'proposed');
  assert.equal(item?.evidence, undefined);
});

test('stale evidence from another code revision cannot close an item', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner: Runner = async (item, ctx) =>
    evidenceFor(item, ctx, { codeDigest: '0'.repeat(64) });
  const evaluator = makeEvaluator(project, runner);

  propose(project);
  const result = await evaluator.evaluate('item-1');
  assert.equal(result.reason, 'evidence-not-bound');
  if (result.reason === 'evidence-not-bound') assert.match(result.detail, /codeDigest/);
});

test('malformed evidence from a runner is refused', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner = (async () => ({ itemId: 'item-1', passed: true })) as unknown as Runner;
  const evaluator = makeEvaluator(project, runner);

  propose(project);
  const result = await evaluator.evaluate('item-1');
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'evidence-invalid');
  assert.equal(onDisk(project).items[0]?.status, 'proposed');
});

test('a missing pin file is a pin mismatch, not a crash', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner = countingRunner();
  const evaluator = makeEvaluator(project, runner.runner);
  rmSync(project.pinFile);

  const result = await evaluator.evaluate('item-1');
  assert.equal(result.reason, 'pin-mismatch');
  if (result.reason === 'pin-mismatch') {
    assert.equal(result.mismatches[0]?.what, 'pinFile');
  }
});

test('a file-backed cache is reused by a fresh evaluator', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner = countingRunner();
  const cachePath = join(project.outside, 'verifier-cache.json');

  const first = makeEvaluator(project, runner.runner, {
    cache: createVerifierCache({ path: cachePath, projectRoot: project.root }),
  });
  propose(project);
  assert.equal((await first.evaluate('item-1')).closed, true);
  first.reopen('item-1');
  propose(project);

  // New process would build a new cache object; the file carries the result.
  const second = makeEvaluator(project, runner.runner, {
    cache: createVerifierCache({ path: cachePath, projectRoot: project.root }),
  });
  const result = await second.evaluate('item-1');
  assert.equal(result.closed, true, JSON.stringify(result));
  if (result.closed) assert.equal(result.cached, true);
  assert.equal(runner.calls(), 1);
  assert.match(readFileSync(cachePath, 'utf8'), /oms\.verifier-cache\/0/);
});

test('the generator surface has no way to close or edit the contract', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const proposer = createProposer({ ...project.roots, pinFile: project.pinFile });
  assert.deepEqual(Object.keys(proposer).sort(), ['propose', 'read']);
  for (const forbidden of ['close', 'evaluate', 'activate', 'write', 'reopen', 'setStatus']) {
    assert.equal(
      (proposer as unknown as Record<string, unknown>)[forbidden],
      undefined,
      `the proposer must not expose ${forbidden}`,
    );
  }
  assert.equal(Object.isFrozen(proposer), true);

  // It cannot move anything except an active item, and never to `closed`.
  const open = proposer.propose('item-2');
  assert.equal(open.ok, false);
  if (!open.ok) assert.equal(open.code, 'E_ITEM_NOT_ACTIVE');

  const active = proposer.propose('item-1');
  assert.equal(active.ok, true);
  if (active.ok) assert.equal(active.contract.items[0]?.status, 'proposed');

  const again = proposer.propose('item-1');
  assert.equal(again.ok, false);

  // A tampered contract blocks even the proposal write.
  writeFileSync(project.contractPath, readFileSync(project.contractPath, 'utf8').replace('"proposed"', '"open"'));
  const tampered = proposer.propose('item-1');
  assert.equal(tampered.ok, false);
  if (!tampered.ok) assert.equal(tampered.code, 'E_PIN_MISMATCH');
});

test('reopen returns a closed item to active and drops the evidence', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner = countingRunner();
  const evaluator = makeEvaluator(project, runner.runner);

  propose(project);
  assert.equal((await evaluator.evaluate('item-1')).closed, true);

  const reopened = evaluator.reopen('item-1');
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  const item = onDisk(project).items[0];
  assert.equal(item?.status, 'active');
  assert.equal(item?.evidence, undefined);
  assert.equal(verifyPin(project.pinFile, project.roots).ok, true);
});

test('a missing code file leaves evidence unboundable', async (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner = countingRunner();
  const evaluator = makeEvaluator(project, runner.runner);

  propose(project);
  rmSync(project.codePath);
  const result = await evaluator.evaluate('item-1');
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'code-unreadable');
  if (result.reason === 'code-unreadable') assert.match(result.detail, /E_NOT_FOUND/);
  assert.equal(onDisk(project).items[0]?.status, 'proposed');
});

test('maxReopen must be a positive integer', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const runner = countingRunner();
  for (const maxReopen of [0, -1, 1.5]) {
    assert.throws(() => makeEvaluator(project, runner.runner, { maxReopen }), RangeError);
  }
});
