import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meanPermutation } from '../src/solbench-harness/stats.ts';
import { paired, renderSection, summarize, type RunResult } from '../src/solbench-harness/report.ts';

const run = (cell: string, runIndex: number, headline: number, extra: Partial<RunResult> = {}): RunResult => ({
  cell,
  variant: 'basic',
  runIndex,
  wallMs: 600_000,
  reason: null,
  forkSlot: 100 + runIndex,
  score: { headline, raw: headline + 1, arbitrary: 1, memo: 0, programs: 2, failed: 3, submissions: 50, pairs: [] },
  tokens: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 9000, cacheWriteTokens: 0 },
  tokensComplete: true,
  identities: { commit: 'abcdef0123', image: 'sha256:x', goal: 'g' },
  ...extra,
});

test('summary: median, max and min of the filtered score; tokens count cached input', () => {
  const s = summarize([run('a', 0, 4), run('a', 1, 10), run('a', 2, 7), run('a', 3, 1)]);
  assert.deepEqual([s.median, s.max, s.min, s.input, s.wallMin], [5.5, 10, 1, 10_000, 10]);
});

test('pairs match run index within a variant; the sign test ignores ties', () => {
  const runs = [
    run('a', 0, 5),
    run('b', 0, 3),
    run('a', 1, 2),
    run('b', 1, 2),
    run('a', 2, 9),
    run('b', 2, 1),
    run('a', 3, 1),
  ];
  const p = paired(runs, 'a', 'b');
  assert.equal(p.pairs.length, 3);
  assert.deepEqual([p.aWins, p.bWins, p.ties], [2, 0, 1]);
  assert.equal(p.pValue, 0.5);
});

test('runs paused on a usage limit are left out and said so', () => {
  const text = renderSection(
    [
      run('a', 0, 5),
      run('a', 1, 50, { reason: 'usage-limit' }),
      run('b', 0, 3, { reason: 'oms-usage-unknown', tokensComplete: false }),
    ],
    ['a', 'b'],
  );
  assert.match(text, /\| a \| 1 \| 5 \| 0 \| 5 \| 5 \|/);
  assert.match(text, /1 run\(s\) paused .* are not counted: a basic run 1 \(usage-limit\)/);
  assert.match(text, /not the Solana Foundation's published Solana Bench/);
  assert.match(text, /\| b \| 0 \|/);
  assert.match(text, /Truncated, not a score .*b basic run 0 \(oms-usage-unknown, 50 submissions, headline 3\)/);
});

test('an OMS infra ending before any submission is paused by name; precompile pairs get their own column', () => {
  const pre = 'Ed25519SigVerify111111111111111111111111111';
  const withPre = run('a', 0, 3);
  withPre.score.pairs = [`${pre}:1`, `${pre}:2`, 'Prog:7'];
  const text = renderSection([withPre, run('a', 1, 0, { reason: 'infra-no-start' })], ['a', 'b']);
  assert.match(text, /\| a \| 1 \| 3 \| 1 \|/);
  assert.match(text, /not counted: a basic run 1 \(infra-no-start\)/);
});

test('permutation test on the difference of means: exact for small groups, seeded and reproducible for large ones', () => {
  const r = meanPermutation([10, 11, 12, 13, 14], [1, 2, 3, 4, 5]);
  assert.equal(r.exact, true);
  assert.equal(r.splits, 252);
  assert.equal(r.observed, 9);
  assert.equal(r.pValue, 2 / 252, 'only the observed split and its mirror are as extreme');
  assert.equal(meanPermutation([5, 5, 5], [5, 5, 5]).pValue, 1);
  assert.throws(() => meanPermutation([], [1]), /at least one/);
  // The published swap comparison (16 OMS runs vs 12 Codex runs) is too large to enumerate, so it is sampled.
  const oms = [514, 283, 532, 280, 487, 284, 329, 311, 380, 312, 316, 431, 439, 296, 320, 343];
  const codex = [323, 265, 463, 196, 272, 286, 280, 229, 286, 284, 292, 215];
  const sampled = meanPermutation(oms, codex);
  assert.equal(sampled.exact, false);
  assert.equal(sampled.pValue, meanPermutation(oms, codex).pValue, 'same seed, same p');
  assert.ok(sampled.pValue > 0.005 && sampled.pValue < 0.02, `published p was 0.010-0.011, got ${sampled.pValue}`);
});
