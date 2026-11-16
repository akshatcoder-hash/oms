import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBudgetLedger } from '@oms/core';
import { foldHelperEntries, usageOf, type HelperRecord } from '../src/runtime/helpers/records.ts';

const record = (id: string): HelperRecord => ({
  id,
  agent: 'explore',
  task: 'look',
  model: 'p/m',
  status: 'running',
  startedAt: 1,
  turnId: `turn-${id}`,
  sessionFile: `/x/${id}.jsonl`,
});
const entry = (data: unknown) => ({ type: 'custom', customType: 'oms.helper', data });

test('a start with an end is folded into one finished record', () => {
  const folded = foldHelperEntries([
    entry({ phase: 'start', record: record('a') }),
    { type: 'message' },
    entry({ phase: 'end', id: 'a', status: 'done', endedAt: 9, summary: 'found it' }),
  ]);
  assert.deepEqual(
    folded.map((item) => [item.id, item.status, item.endedAt, item.summary]),
    [['a', 'done', 9, 'found it']],
  );
});

test('a start with no end is interrupted, unless it is still running', () => {
  const entries = [entry({ phase: 'start', record: record('a') }), entry({ phase: 'start', record: record('b') })];
  assert.deepEqual(
    foldHelperEntries(entries).map((item) => item.status),
    ['interrupted', 'interrupted'],
  );
  assert.deepEqual(
    foldHelperEntries(entries, new Set(['b'])).map((item) => item.status),
    ['interrupted', 'running'],
  );
});

test('entries of other kinds and an end without a start are ignored', () => {
  assert.deepEqual(
    foldHelperEntries([
      { type: 'custom', customType: 'oms.other', data: {} },
      entry({ phase: 'end', id: 'ghost', status: 'done', endedAt: 1 }),
      null,
    ]),
    [],
  );
});

test('usage is read from the ledger by turn: settled requests at their receipt, uncertain ones at their reservation', () => {
  const ledger = createBudgetLedger({
    caps: { tokens: 1_000_000, spendMicroUsd: 1_000_000, wallClockMs: 60_000 },
    executionMode: 'interactive',
    clock: Date.now,
    persist() {},
  });
  assert.ok(ledger.beginOperation('op').ok);
  const reserve = (dispatchId: string, logicalTurnId: string, attempt: number, tokens: number, spendMicroUsd: number) =>
    assert.ok(ledger.reserve({ dispatchId, logicalTurnId, attempt, tokens, spendMicroUsd }).ok);
  reserve('d1', 'helper', 1, 5000, 50);
  reserve('d2', 'helper', 2, 4000, 40);
  reserve('d3', 'helper', 3, 3000, 30);
  reserve('d4', 'chat', 1, 9000, 90);
  const settle = (
    dispatchId: string,
    outcome: 'known' | 'uncertain',
    tokens: number | null,
    spendMicroUsd: number | null,
  ) => assert.ok(ledger.settle({ dispatchId, receiptId: `r-${dispatchId}`, outcome, tokens, spendMicroUsd }).ok);
  settle('d1', 'known', 1200, 12);
  settle('d4', 'known', 700, 7);
  settle('d2', 'uncertain', null, null);
  assert.deepEqual(usageOf(ledger, 'helper'), { tokens: 1200 + 4000, spendMicroUsd: 12 + 40 });
  assert.deepEqual(usageOf(ledger, 'chat'), { tokens: 700, spendMicroUsd: 7 });
  assert.deepEqual(usageOf(ledger, 'nobody'), { tokens: 0, spendMicroUsd: 0 });
});
