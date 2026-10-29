import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_BUDGET_CAPS,
  InvalidBudgetCapsError,
  createBudgetMeter,
  formatDuration,
  formatInteger,
  formatMicroUsd,
  snapshotFor,
  type BudgetCaps,
} from '../src/budget/meter.ts';

const START = Date.UTC(2025, 9, 29, 1, 0, 0);

function clockAt(start = START): { clock: () => number; advance: (ms: number) => void } {
  let now = start;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const CAPS: BudgetCaps = { tokens: 1000, spendMicroUsd: 1_000_000, wallClockMs: 60_000 };

test('default caps are integer configuration', () => {
  for (const value of [DEFAULT_BUDGET_CAPS.tokens, DEFAULT_BUDGET_CAPS.spendMicroUsd, DEFAULT_BUDGET_CAPS.wallClockMs]) {
    assert.equal(Number.isSafeInteger(value), true);
    assert.ok(value > 0);
  }
});

test('charges accumulate and snapshots report remaining budget', () => {
  const { clock } = clockAt();
  const meter = createBudgetMeter({ caps: CAPS, clock });
  assert.deepEqual(meter.snapshot().used, { tokens: 0, spendMicroUsd: 0, wallClockMs: 0 });
  assert.equal(meter.exhausted(), false);

  const first = meter.charge({ tokens: 300, spendMicroUsd: 250_000 });
  assert.equal(first.ok, true);
  const snapshot = meter.snapshot();
  assert.deepEqual(snapshot.used, { tokens: 300, spendMicroUsd: 250_000, wallClockMs: 0 });
  assert.deepEqual(snapshot.remaining, { tokens: 700, spendMicroUsd: 750_000, wallClockMs: 60_000 });
  assert.equal(snapshot.exhausted, false);
  assert.deepEqual(snapshot.reasons, []);

  meter.charge({ tokens: 700, spendMicroUsd: 750_000 });
  assert.equal(meter.exhausted(), true);
  assert.deepEqual(meter.snapshot().reasons, ['tokens', 'spend']);
});

test('money is integers only', () => {
  const { clock } = clockAt();
  const meter = createBudgetMeter({ caps: CAPS, clock });
  const fractional = meter.charge({ spendMicroUsd: 0.5 });
  assert.equal(fractional.ok, false);
  assert.equal(fractional.ok === false ? fractional.code : '', 'E_NON_INTEGER');
  assert.equal(fractional.ok === false ? fractional.field : '', 'spendMicroUsd');

  const nan = meter.charge({ spendMicroUsd: Number.NaN });
  assert.equal(nan.ok === false ? nan.code : '', 'E_NON_INTEGER');
  assert.equal(meter.charge({ spendMicroUsd: Number.POSITIVE_INFINITY }).ok, false);
  assert.equal(meter.charge({ tokens: 1.5 }).ok, false);
  assert.equal(meter.charge({ tokens: -1 }).ok, false);
  assert.equal(meter.charge({ spendMicroUsd: -1 }).ok === false ? 'E_NEGATIVE' : '', 'E_NEGATIVE');

  assert.equal(meter.snapshot().used.spendMicroUsd, 0, 'rejected charges change nothing');
  meter.charge({ spendMicroUsd: 2_500_001 });
  const used = meter.snapshot().used.spendMicroUsd;
  assert.equal(used, 2_500_001);
  assert.equal(Number.isSafeInteger(used), true, 'no float drift');
});

test('wall clock comes from the injected clock', () => {
  const { clock, advance } = clockAt();
  const meter = createBudgetMeter({ caps: CAPS, clock });
  advance(15_000);
  assert.equal(meter.snapshot().used.wallClockMs, 15_000);
  advance(60_000);
  assert.equal(meter.exhausted(), true);
  assert.deepEqual(meter.snapshot().reasons, ['wall_clock']);
  assert.equal(meter.snapshot().remaining.wallClockMs, 0);
});

test('a clock that runs backwards does not create budget', () => {
  let now = START;
  const meter = createBudgetMeter({ caps: CAPS, clock: () => now });
  now = START - 10_000;
  assert.equal(meter.snapshot().used.wallClockMs, 0);
});

test('a non-finite clock cannot be charged as negative time', () => {
  const meter = createBudgetMeter({ caps: CAPS, clock: () => Number.NaN, startedAt: START });
  const snapshot = meter.snapshot();
  assert.equal(Number.isSafeInteger(snapshot.used.wallClockMs), true);
  assert.equal(meter.exhausted(), true, 'a broken clock fails closed');
});

test('a non-finite clock at construction is rejected', () => {
  assert.throws(
    () => createBudgetMeter({ caps: CAPS, clock: () => Number.NaN }),
    (error: unknown) => error instanceof InvalidBudgetCapsError && error.problems[0]?.startsWith('startedAt'),
  );
});

test('explain is one deterministic line', () => {
  const { clock } = clockAt();
  const meter = createBudgetMeter({ clock });
  const expected =
    'budget 2,000,000 tokens / $5 / 30m0s - used 0 tokens, $0, 0s - remaining 2,000,000 tokens, $5, 30m0s';
  assert.equal(meter.explain(), expected);
  assert.equal(meter.explain(), expected, 'same state, same line');
  assert.equal(meter.explain().includes('\n'), false);
});

test('explain reports usage and exhaustion', () => {
  const { clock } = clockAt();
  const meter = createBudgetMeter({ clock });
  meter.charge({ tokens: 1000, spendMicroUsd: 2_500_001 });
  assert.equal(
    meter.explain(),
    'budget 2,000,000 tokens / $5 / 30m0s - used 1,000 tokens, $2.500001, 0s - remaining 1,999,000 tokens, $2.499999, 30m0s',
  );
  meter.charge({ tokens: DEFAULT_BUDGET_CAPS.tokens });
  assert.match(meter.explain(), /EXHAUSTED \(tokens\)/);
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

test('invalid caps are rejected at construction', () => {
  const { clock } = clockAt();
  const cases: BudgetCaps[] = [
    { tokens: 1.5, spendMicroUsd: 1, wallClockMs: 1 },
    { tokens: 1, spendMicroUsd: -1, wallClockMs: 1 },
    { tokens: 1, spendMicroUsd: 1, wallClockMs: Number.NaN },
  ];
  for (const caps of cases) {
    assert.throws(
      () => createBudgetMeter({ caps, clock }),
      (error: unknown) => error instanceof InvalidBudgetCapsError && error.problems.length > 0,
    );
  }
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

test('meter snapshots are deterministic and integer-only', () => {
  const make = (): ReturnType<typeof createBudgetMeter> => {
    const { clock } = clockAt();
    const meter = createBudgetMeter({ caps: CAPS, clock });
    meter.charge({ tokens: 10, spendMicroUsd: 123 });
    meter.charge({ tokens: 20, spendMicroUsd: 456 });
    return meter;
  };
  const a = make();
  const b = make();
  assert.deepEqual(a.snapshot(), b.snapshot());
  const snapshot = a.snapshot();
  for (const group of [snapshot.used, snapshot.remaining, snapshot.caps]) {
    for (const value of Object.values(group)) {
      assert.equal(Number.isSafeInteger(value), true, String(value));
    }
  }
});
