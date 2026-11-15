import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_BUDGET_CAPS,
  formatDuration,
  formatInteger,
  formatMicroUsd,
  snapshotFor,
  type BudgetCaps,
} from '../src/budget/meter.ts';

test('default caps are integer configuration', () => {
  for (const value of [DEFAULT_BUDGET_CAPS.tokens, DEFAULT_BUDGET_CAPS.spendMicroUsd, DEFAULT_BUDGET_CAPS.wallClockMs]) {
    assert.equal(Number.isSafeInteger(value), true);
    assert.ok(value > 0);
  }
});

test('money and integer formatting use integer arithmetic only', () => {
  const microCases: Array<[number, string]> = [
    [0, '$0'],
    [1, '$0.000001'],
    [2_500_001, '$2.500001'],
    [1_500_000, '$1.5'],
    [2_000_000, '$2'],
    [1_000_000, '$1'],
    [123_456_789, '$123.456789'],
  ];
  for (const [value, expected] of microCases) {
    assert.equal(formatMicroUsd(value), expected, String(value));
    assert.equal(formatMicroUsd(value), formatMicroUsd(value));
  }
  const integerCases: Array<[number, string]> = [
    [0, '0'],
    [999, '999'],
    [1000, '1,000'],
    [2_000_000, '2,000,000'],
    [123_456_789, '123,456,789'],
  ];
  for (const [value, expected] of integerCases) assert.equal(formatInteger(value), expected);
});

test('durations format deterministically', () => {
  const cases: Array<[number, string]> = [
    [0, '0s'],
    [4_000, '4s'],
    [60_000, '1m0s'],
    [30 * 60 * 1000, '30m0s'],
    [3_723_000, '1h2m3s'],
  ];
  for (const [ms, expected] of cases) assert.equal(formatDuration(ms), expected);
});

test('snapshotFor lists every exhausted cap in a stable order', () => {
  const caps: BudgetCaps = { tokens: 10, spendMicroUsd: 10, wallClockMs: 10 };
  const snapshot = snapshotFor(caps, { tokens: 10, spendMicroUsd: 10, wallClockMs: 10 });
  assert.deepEqual(snapshot.reasons, ['tokens', 'spend', 'wall_clock']);
  assert.equal(snapshot.exhausted, true);
  const partial = snapshotFor(caps, { tokens: 0, spendMicroUsd: 0, wallClockMs: 10 });
  assert.deepEqual(partial.reasons, ['wall_clock']);
  assert.deepEqual(partial.remaining, { tokens: 10, spendMicroUsd: 10, wallClockMs: 0 });
});
