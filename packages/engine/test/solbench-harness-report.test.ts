import assert from 'node:assert/strict';
import { test } from 'node:test';
import { medianPermutation } from '../src/bench/solbench-harness/stats.ts';
import { paired, renderSection, summarize, type RunResult } from '../src/bench/solbench-harness/report.ts';

const run = (cell: string, runIndex: number, headline: number, extra: Partial<RunResult> = {}): RunResult => ({
  cell, variant: 'basic', runIndex, wallMs: 600_000, reason: null, forkSlot: 100 + runIndex,
  score: { headline, raw: headline + 1, arbitrary: 1, memo: 0, programs: 2, failed: 3, submissions: 50, pairs: [] },
  tokens: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 9000, cacheWriteTokens: 0 },
  tokensComplete: true, identities: { commit: 'abcdef0123', image: 'sha256:x', goal: 'g' }, ...extra });

test('summary: median, max and min of the filtered score; tokens count cached input', () => {
  const s = summarize([run('a', 0, 4), run('a', 1, 10), run('a', 2, 7), run('a', 3, 1)]);
  assert.deepEqual([s.median, s.max, s.min, s.input, s.wallMin], [5.5, 10, 1, 10_000, 10]);
});

test('pairs match run index within a variant; the sign test ignores ties', () => {
  const runs = [run('a', 0, 5), run('b', 0, 3), run('a', 1, 2), run('b', 1, 2), run('a', 2, 9), run('b', 2, 1), run('a', 3, 1)];
  const p = paired(runs, 'a', 'b');
  assert.equal(p.pairs.length, 3);
  assert.deepEqual([p.aWins, p.bWins, p.ties], [2, 0, 1]);
  assert.equal(p.pValue, 0.5);
});

test('runs paused on a usage limit are left out and said so', () => {
  const text = renderSection([run('a', 0, 5), run('a', 1, 50, { reason: 'usage-limit' }), run('b', 0, 3, { reason: 'oms-usage-unknown', tokensComplete: false })], ['a', 'b']);
  assert.match(text, /\| a \| 1 \| 5 \| 0 \| 5 \| 5 \|/);
  assert.match(text, /1 run\(s\) paused .* are not counted: a basic run 1 \(usage-limit\)/);
  assert.match(text, /not the Solana Foundation's published Solana Bench/);
  assert.match(text, /\| b \| 0 \|/);
  assert.match(text, /Truncated, not a score .*b basic run 0 \(oms-usage-unknown, 50 submissions, headline 3\)/);
});

test('an OMS infra ending before any submission is paused by name; precompile pairs get their own column', () => {
  const pre = 'Ed25519SigVerify111111111111111111111111111';
  const withPre = run('a', 0, 3); withPre.score.pairs = [`${pre}:1`, `${pre}:2`, 'Prog:7'];
  const text = renderSection([withPre, run('a', 1, 0, { reason: 'infra-no-start' })], ['a', 'b']);
  assert.match(text, /\| a \| 1 \| 3 \| 1 \|/);
  assert.match(text, /not counted: a basic run 1 \(infra-no-start\)/);
});

test('exact permutation test on the difference of medians: 5 vs 5 fully separated counts every tied split as extreme', () => {
  const r = medianPermutation([10, 11, 12, 13, 14], [1, 2, 3, 4, 5]);
  assert.equal(r.splits, 252);
  assert.equal(r.observed, 9);
  assert.equal(r.pValue, 12 / 252);
  assert.ok(medianPermutation([1, 2, 3], [100, 101, 102]).pValue === 0.2);
  assert.equal(medianPermutation([5, 5, 5], [5, 5, 5]).pValue, 1);
  assert.throws(() => medianPermutation([], [1]), /at least one/);
});
