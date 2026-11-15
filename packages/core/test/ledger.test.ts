import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBudgetLedger, type BudgetLedgerEvent } from '../src/budget/ledger.ts';

const caps = { tokens: 1000, spendMicroUsd: 1000, wallClockMs: 10000 };
const reservation = { dispatchId: 'dispatch-1', logicalTurnId: 'turn-1', attempt: 1, tokens: 100, spendMicroUsd: 200 };

function fixture() {
  const events: BudgetLedgerEvent[] = [];
  const ledger = createBudgetLedger({ caps, clock: () => 100, startedAt: 0, persist: (event) => { events.push(event); } });
  return { ledger, events };
}

test('interactive idle time is free, continuations share limits, and paid spend is cumulative', () => {
  let now = 0;
  const ledger = createBudgetLedger({ caps, executionMode: 'interactive', clock: () => now, persist() {} });
  now = 31 * 60_000;
  assert.equal(ledger.snapshot().remaining.wallClockMs, caps.wallClockMs);
  assert.equal(ledger.beginOperation('turn-1').ok, true);
  assert.equal(ledger.reserve({ ...reservation, tokens: 900 }).ok, true);
  assert.equal(ledger.settle({ dispatchId: 'dispatch-1', receiptId: 'r1', outcome: 'known', tokens: 900, spendMicroUsd: 200 }).ok, true);
  now += 9000;
  assert.equal(ledger.beginOperation('turn-1').ok, true);
  assert.equal(ledger.snapshot().remaining.wallClockMs, 1000);
  assert.equal(ledger.reserve({ ...reservation, dispatchId: 'd2', attempt: 2, tokens: 101 }).ok, false);
  now += 1000;
  assert.equal(ledger.snapshot().exhausted, true);
  assert.equal(ledger.endOperation('turn-1').ok, true);
  now += 31 * 60_000;
  assert.equal(ledger.snapshot().remaining.tokens, caps.tokens);
  assert.equal(ledger.beginOperation('turn-1').ok, false);
  assert.equal(ledger.beginOperation('turn-2').ok, true);
  assert.equal(ledger.reserve({ ...reservation, dispatchId: 'd3', logicalTurnId: 'turn-2', tokens: 900, spendMicroUsd: 801 }).ok, false);
  assert.equal(ledger.reserve({ ...reservation, dispatchId: 'd3', logicalTurnId: 'turn-2', tokens: 900 }).ok, true);
  assert.equal(ledger.snapshot().used.tokens, 1800);
  assert.equal(ledger.snapshot().used.spendMicroUsd, 400);
});

test('policy migration and real journal replay preserve totals without read-only writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oms-policy-'));
  const path = join(directory, 'budget.jsonl');
  const fd = openSync(path, 'a');
  let now = 100;
  try {
    const persist = (event: BudgetLedgerEvent) => { writeSync(fd, `${JSON.stringify(event)}\n`); fsyncSync(fd); };
    const ledger = createBudgetLedger({ caps, clock: () => now, persist });
    ledger.reserve(reservation);
    assert.equal(ledger.setExecutionMode('interactive').ok, false);
    ledger.settle({ dispatchId: 'dispatch-1', receiptId: 'r1', outcome: 'known', tokens: 100, spendMicroUsd: 200 });
    now += 31 * 60_000;
    assert.equal(ledger.snapshot().exhausted, true);
    assert.equal(ledger.setExecutionMode('interactive').ok, true);
    ledger.beginOperation('next');
    ledger.endOperation('next');
    const before = readFileSync(path, 'utf8');
    const replay = createBudgetLedger({ caps, clock: () => now, events: before.trim().split('\n').map(line => JSON.parse(line)),
      persist() { throw new Error('inspection must not write'); } });
    assert.deepEqual(replay.snapshot(), ledger.snapshot());
    assert.equal(replay.snapshot().used.tokens, 100);
    assert.equal(replay.snapshot().used.spendMicroUsd, 200);
    assert.equal(replay.snapshot().remaining.tokens, 1000);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(replay.setExecutionMode('bounded').ok, false);
  } finally { closeSync(fd); rmSync(directory, { recursive: true, force: true }); }
});

test('unknown usage blocks interactive transition and resumed operations without refunding', () => {
  const { ledger, events } = fixture();
  ledger.reserve(reservation);
  ledger.settle({ dispatchId: 'dispatch-1', receiptId: 'u1', outcome: 'uncertain', tokens: null, spendMicroUsd: null });
  assert.equal(ledger.setExecutionMode('interactive').ok, false);
  const replay = createBudgetLedger({ caps, executionMode: 'interactive', clock: () => 2_000_000, events, persist() {} });
  assert.equal(replay.snapshot().executionMode, 'bounded');
  assert.equal(replay.beginOperation('next').ok, false);
  assert.equal(replay.snapshot().used.spendMicroUsd, 200);
  assert.equal(replay.snapshot().accounting, 'unknown');
});

test('interactive active windows replay without renewing time and subscription calls do not consume paid allowance', () => {
  let now = 0;
  const events: BudgetLedgerEvent[] = [];
  const policyCaps = { ...caps, spendMicroUsd: 0 };
  const ledger = createBudgetLedger({ caps: policyCaps, executionMode: 'interactive', clock: () => now, persist: event => { events.push(event); } });
  ledger.beginOperation('turn-1');
  assert.equal(ledger.snapshot().admissionBlocked, false);
  assert.equal(ledger.reserve({ ...reservation, spendMicroUsd: 1 }).ok, false);
  assert.equal(ledger.reserve({ ...reservation, spendMicroUsd: 0 }).ok, true);
  ledger.settle({ dispatchId: reservation.dispatchId, receiptId: 'r1', outcome: 'known', tokens: 80, spendMicroUsd: 0 });
  now = caps.wallClockMs + 1;
  const replay = createBudgetLedger({ caps: policyCaps, clock: () => now, events: [...events], persist: event => { events.push(event); } });
  assert.equal(replay.snapshot().activeOperationId, 'turn-1');
  assert.equal(replay.snapshot().remaining.wallClockMs, 0);
  assert.equal(replay.beginOperation('turn-1').ok, true);
  assert.equal(replay.snapshot().remaining.wallClockMs, 0);
  assert.equal(replay.reserve({ ...reservation, dispatchId: 'd2', attempt: 2, spendMicroUsd: 0 }).ok, false);
  replay.endOperation('turn-1');
  assert.equal(replay.beginOperation('turn-2').ok, true);
  assert.equal(replay.snapshot().remaining.wallClockMs, caps.wallClockMs);
  assert.equal(replay.snapshot().used.tokens, 80);
  assert.equal(replay.reserve({ ...reservation, dispatchId: 'd2', logicalTurnId: 'turn-2', spendMicroUsd: 0 }).ok, true);
});

test('reservations and receipts apply exactly once and replay the same accounting', () => {
  const { ledger, events } = fixture();
  assert.equal(ledger.reserve(reservation).ok, true);
  const duplicate = ledger.reserve({ ...reservation });
  assert.equal(duplicate.ok && duplicate.duplicate, true);
  assert.equal(ledger.snapshot().used.tokens, 100);
  const receipt = { dispatchId: reservation.dispatchId, receiptId: 'receipt-1', outcome: 'known' as const, tokens: 60, spendMicroUsd: 150 };
  assert.equal(ledger.settle(receipt).ok, true);
  const repeat = ledger.settle({ ...receipt });
  assert.equal(repeat.ok && repeat.duplicate, true);
  assert.equal(ledger.snapshot().used.tokens, 60);
  assert.equal(ledger.snapshot().used.spendMicroUsd, 150);
  assert.equal(events.length, 3);
  const replay = createBudgetLedger({ caps, clock: () => 100, events: JSON.parse(JSON.stringify(events)), persist: () => { throw new Error('replay must not write'); } });
  assert.deepEqual(replay.snapshot(), ledger.snapshot());
});

test('logical turn identity does not merge separately billable retry dispatches', () => {
  const { ledger } = fixture();
  ledger.reserve(reservation);
  assert.equal(ledger.reserve({ ...reservation, dispatchId: 'dispatch-2', attempt: 2 }).ok, true);
  assert.equal(ledger.snapshot().used.tokens, 200);
  assert.equal(ledger.reserve({ ...reservation, dispatchId: 'dispatch-3' }).ok, false);
  assert.equal(ledger.reserve({ ...reservation, tokens: 101 }).ok, false);
});

test('uncertain outcomes retain reservations across restart and block further admission', () => {
  const { ledger, events } = fixture();
  ledger.reserve(reservation);
  ledger.settle({ dispatchId: 'dispatch-1', receiptId: 'uncertain-1', outcome: 'uncertain', tokens: null, spendMicroUsd: null });
  assert.equal(ledger.snapshot().used.tokens, 100);
  assert.equal(ledger.snapshot().used.spendMicroUsd, 200);
  assert.equal(ledger.snapshot().accounting, 'unknown');
  const replay = createBudgetLedger({ caps, clock: () => 200, events, persist: (event) => { events.push(event); } });
  assert.equal(replay.snapshot().accounting, 'unknown');
  const refused = replay.reserve({ ...reservation, dispatchId: 'dispatch-2', attempt: 2 });
  assert.equal(refused.ok ? '' : refused.code, 'E_UNKNOWN');
  replay.settle({ dispatchId: 'dispatch-1', receiptId: 'reconciled-1', outcome: 'known', tokens: 80, spendMicroUsd: 180 });
  assert.equal(replay.snapshot().accounting, 'known');
  assert.equal(replay.snapshot().used.tokens, 80);
});

test('unknown pricing is not free, partial usage cannot refund a reservation', () => {
  const { ledger } = fixture();
  const refused = ledger.reserve({ ...reservation, spendMicroUsd: null });
  assert.equal(refused.ok ? '' : refused.code, 'E_UNKNOWN');
  ledger.reserve(reservation);
  ledger.settle({ dispatchId: 'dispatch-1', receiptId: 'partial-1', outcome: 'uncertain', tokens: 150, spendMicroUsd: null });
  assert.equal(ledger.snapshot().used.tokens, 150);
  assert.equal(ledger.snapshot().used.spendMicroUsd, 200);
  assert.equal(ledger.snapshot().accounting, 'unknown');
});

test('admission enforces remaining caps and final actual usage may exceed a reservation', () => {
  const { ledger } = fixture();
  assert.equal(ledger.reserve({ ...reservation, tokens: 1001 }).ok, false);
  ledger.reserve(reservation);
  assert.equal(ledger.settle({ dispatchId: 'dispatch-1', receiptId: 'actual-1', outcome: 'known', tokens: 1001, spendMicroUsd: 300 }).ok, true);
  assert.equal(ledger.snapshot().exhausted, true);
  assert.equal(ledger.snapshot().used.tokens, 1001);
});

test('a durably reserved dispatch with no receipt remains charged after a crash', () => {
  const { ledger, events } = fixture();
  ledger.reserve(reservation);
  const replay = createBudgetLedger({ caps, clock: () => 100, events, persist: () => {} });
  assert.equal(replay.snapshot().used.tokens, 100);
  assert.deepEqual(replay.snapshot().pendingDispatchIds, ['dispatch-1']);
  assert.equal(replay.snapshot().accounting, 'pending');
});

test('persistence failure never grants admission and poisons subsequent writes', () => {
  let writes = 0;
  const ledger = createBudgetLedger({ caps, clock: () => 100, persist: () => { if (++writes > 1) throw new Error('disk unavailable'); } });
  const result = ledger.reserve(reservation);
  assert.equal(result.ok ? '' : result.code, 'E_PERSIST');
  assert.equal(ledger.snapshot().accounting, 'unknown');
  assert.equal(ledger.reserve(reservation).ok, false);
  assert.equal(writes, 2);
});

test('replay rejects a different budget, conflicting receipts and malformed events', () => {
  const { ledger, events } = fixture();
  ledger.reserve(reservation);
  const receipt = { dispatchId: 'dispatch-1', receiptId: 'receipt-1', outcome: 'known' as const, tokens: 60, spendMicroUsd: 150 };
  ledger.settle(receipt);
  assert.equal(ledger.settle({ ...receipt, tokens: 1 }).ok, false);
  assert.equal(ledger.settle({ ...receipt, receiptId: 'receipt-2' }).ok, false);
  assert.throws(() => createBudgetLedger({ caps: { ...caps, tokens: 2000 }, clock: () => 100, events, persist: () => {} }), /budget/);
  assert.throws(() => createBudgetLedger({ caps, clock: () => 100, events: [...events, { type: 'invalid' } as never], persist: () => {} }), /event/);
});

test('not-dispatched proof releases only that reservation and duplicate receipt is inert', () => {
  const { ledger } = fixture();
  ledger.reserve(reservation);
  const receipt = { dispatchId: 'dispatch-1', receiptId: 'not-sent', outcome: 'not_dispatched' as const, tokens: 0, spendMicroUsd: 0 };
  assert.equal(ledger.settle(receipt).ok, true);
  assert.equal(ledger.settle(receipt).ok, true);
  assert.equal(ledger.snapshot().used.tokens, 0);
  assert.equal(ledger.snapshot().accounting, 'known');
});

test('fsynced JSONL reservations and uncertain receipts survive reopening the real journal', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'oms-budget-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'budget.jsonl');
  const persist = (event: BudgetLedgerEvent): void => {
    const fd = openSync(path, 'a', 0o600);
    try {
      const line = Buffer.from(`${JSON.stringify(event)}\n`);
      assert.equal(writeSync(fd, line), line.length);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const ledger = createBudgetLedger({ caps, clock: () => 100, startedAt: 0, persist });
  ledger.reserve(reservation);
  ledger.settle({
    dispatchId: reservation.dispatchId, receiptId: 'lost-response',
    outcome: 'uncertain', tokens: null, spendMicroUsd: null,
  });
  const events: BudgetLedgerEvent[] = readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  const reopened = createBudgetLedger({ caps, clock: () => 100, events, persist });
  assert.deepEqual(reopened.snapshot(), ledger.snapshot());
  assert.equal(reopened.snapshot().admissionBlocked, true);
  assert.equal(reopened.snapshot().used.spendMicroUsd, 200);
});

const workerReservation = {
  ...reservation,
  provenance: { role: 'worker' as const, provider: 'openai', modelId: 'worker-model',
    endpointId: 'https://example.invalid/v1', policyVersion: '2026-11-01.1' },
};

test('provenance participates in reservation identity and is detached from caller mutation', () => {
  const { ledger, events } = fixture();
  const input = { ...workerReservation, provenance: { ...workerReservation.provenance } };
  assert.equal(ledger.reserve(input).ok, true);
  input.provenance.modelId = 'tampered';
  assert.equal(ledger.reservations()[0]?.provenance?.modelId, 'worker-model');
  for (const field of ['provider', 'modelId', 'endpointId', 'policyVersion'] as const) {
    const result = ledger.reserve({ ...workerReservation, provenance: { ...workerReservation.provenance, [field]: 'other' } });
    assert.equal(result.ok ? '' : result.code, 'E_CONFLICT');
  }
  const snapshot = ledger.reservations();
  assert.equal(Reflect.set(snapshot[0]!.provenance!, 'modelId', 'changed'), false);
  assert.equal(Reflect.deleteProperty(snapshot, '0'), false);
  const replay = createBudgetLedger({ caps, clock: () => 100, events: JSON.parse(JSON.stringify(events)), persist: () => {} });
  assert.deepEqual(replay.reservations(), ledger.reservations());
  assert.equal(replay.reserve(workerReservation).ok, true);
});

test('invalid provenance is refused both on admission and journal replay; old receipts remain valid', () => {
  for (const provenance of [null, {}, { ...workerReservation.provenance, role: 'other' }, { ...workerReservation.provenance, role: 'router' },
    { ...workerReservation.provenance, provider: '' }, { ...workerReservation.provenance, modelId: 3 },
    { ...workerReservation.provenance, endpointId: '' }, { ...workerReservation.provenance, policyVersion: '' }]) {
    const { ledger, events } = fixture();
    const malformed = { ...workerReservation, provenance } as never;
    assert.equal(ledger.reserve(malformed).ok, false);
    assert.throws(() => createBudgetLedger({ caps, clock: () => 100,
      events: [...events, { type: 'budget_reserve', seq: 2, at: 100, reservation: malformed }], persist: () => {} }), /invalid budget event/);
  }
  const { ledger, events } = fixture();
  ledger.reserve(reservation);
  const replay = createBudgetLedger({ caps, clock: () => 100, events, persist: () => {} });
  assert.deepEqual(replay.reservations(), [reservation]);
});

test('provenance projects only semantic fields and cannot be mutated through replay input', () => {
  const { ledger, events } = fixture();
  ledger.reserve({ ...workerReservation, provenance: { ...workerReservation.provenance, ...reservation } });
  assert.deepEqual(ledger.reservations()[0]?.provenance, workerReservation.provenance);
  const source: BudgetLedgerEvent[] = JSON.parse(JSON.stringify(events));
  const replay = createBudgetLedger({ caps, clock: () => 100, events: source, persist: () => {} });
  const admitted = source[1];
  assert.equal(admitted?.type, 'budget_reserve');
  if (admitted?.type === 'budget_reserve' && admitted.reservation.provenance) {
    Reflect.set(admitted.reservation.provenance, 'provider', 'tampered');
  }
  assert.equal(replay.reservations()[0]?.provenance?.provider, workerReservation.provenance.provider);
});

test('worker receipt token partitions survive replay and reject conflicting or mutable observations', () => {
  const { ledger, events } = fixture();
  ledger.reserve(reservation);
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 };
  const receipt = { dispatchId: reservation.dispatchId, receiptId: 'partition', outcome: 'known' as const, tokens: 20, spendMicroUsd: 40, usage };
  assert.equal(ledger.settle({ ...receipt, usage: { ...usage, cacheReadTokens: 9 } }).ok, false);
  assert.equal(ledger.settle(receipt).ok, true);
  usage.cacheReadTokens = 99;
  assert.equal(ledger.receipts()[0]?.usage?.cacheReadTokens, 3);
  assert.equal(ledger.settle({ ...receipt, usage: { ...usage, cacheReadTokens: 2, cacheWriteTokens: 3 } }).ok, false);
  const replay = createBudgetLedger({ caps, clock: () => 100, events, persist() {} });
  assert.equal(replay.receipts()[0]?.usage?.cacheWriteTokens, 2);
});
