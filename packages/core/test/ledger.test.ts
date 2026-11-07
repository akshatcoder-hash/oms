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

const routerReservation = {
  ...reservation, tokens: 0, spendMicroUsd: 934,
  provenance: { role: 'router' as const, provider: 'cloudflare-workers-ai', modelId: 'clef-flash',
    endpointId: 'cloudflare-account', policyVersion: '2026-11-01.1' },
};
const routerRecord = {
  dispatchId: reservation.dispatchId, inputTokens: 100, outputTokens: 10_000_000,
  calls: 1 as const, outcome: 'known' as const, spendMicroUsd: 4,
};

test('provenance participates in reservation identity and is detached from caller mutation', () => {
  const { ledger, events } = fixture();
  const input = { ...routerReservation, provenance: { ...routerReservation.provenance } };
  assert.equal(ledger.reserve(input).ok, true);
  input.provenance.modelId = 'tampered';
  assert.equal(ledger.reservations()[0]?.provenance?.modelId, 'clef-flash');
  for (const field of ['role', 'provider', 'modelId', 'endpointId', 'policyVersion'] as const) {
    const result = ledger.reserve({ ...routerReservation, provenance: { ...routerReservation.provenance, [field]: field === 'role' ? 'worker' : 'other' } });
    assert.equal(result.ok ? '' : result.code, 'E_CONFLICT');
  }
  const snapshot = ledger.reservations();
  assert.equal(Reflect.set(snapshot[0]!.provenance!, 'modelId', 'changed'), false);
  assert.equal(Reflect.deleteProperty(snapshot, '0'), false);
  const replay = createBudgetLedger({ caps, clock: () => 100, events: JSON.parse(JSON.stringify(events)), persist: () => {} });
  assert.deepEqual(replay.reservations(), ledger.reservations());
  assert.equal(replay.reserve(routerReservation).ok, true);
});

test('invalid provenance is refused both on admission and journal replay; old receipts remain valid', () => {
  for (const provenance of [null, {}, { ...routerReservation.provenance, role: 'other' },
    { ...routerReservation.provenance, provider: '' }, { ...routerReservation.provenance, modelId: 3 },
    { ...routerReservation.provenance, endpointId: '' }, { ...routerReservation.provenance, policyVersion: '' }]) {
    const { ledger, events } = fixture();
    const malformed = { ...routerReservation, provenance } as never;
    assert.equal(ledger.reserve(malformed).ok, false);
    assert.throws(() => createBudgetLedger({ caps, clock: () => 100,
      events: [...events, { type: 'budget_reserve', seq: 2, at: 100, reservation: malformed }], persist: () => {} }), /invalid budget event/);
  }
  const { ledger, events } = fixture();
  ledger.reserve(reservation);
  const replay = createBudgetLedger({ caps, clock: () => 100, events, persist: () => {} });
  assert.deepEqual(replay.reservations(), [reservation]);
});

test('router records persist once, retain worker tokens, and replay quota and separate observed tokens', () => {
  const { ledger, events } = fixture();
  assert.equal(ledger.reserve(routerReservation).ok, true);
  assert.equal(ledger.recordRouter(routerRecord).ok, true);
  const duplicate = ledger.recordRouter({ ...routerRecord });
  assert.equal(duplicate.ok && duplicate.duplicate, true);
  assert.equal(events.filter((event) => event.type === 'budget_router').length, 1);
  assert.equal(ledger.snapshot().used.spendMicroUsd, 934);
  assert.equal(ledger.settle({ dispatchId: reservation.dispatchId, receiptId: 'router-receipt',
    outcome: 'known', tokens: 0, spendMicroUsd: 4 }).ok, true);
  assert.equal(ledger.snapshot().used.tokens, 0);
  assert.equal(ledger.snapshot().used.spendMicroUsd, 4);
  const replay = createBudgetLedger({ caps, clock: () => 100, events: JSON.parse(JSON.stringify(events)), persist: () => {} });
  assert.deepEqual(replay.routerRecords(), [routerRecord]);
  assert.equal(replay.routerRecords().reduce((total, record) => total + record.calls, 0), 1);
  assert.equal(Reflect.set(replay.routerRecords()[0]!, 'calls', 0), false);
  for (const field of ['inputTokens', 'outputTokens', 'calls', 'outcome', 'spendMicroUsd'] as const) {
    const result = ledger.recordRouter({ ...routerRecord, [field]: field === 'outcome' ? 'unknown' : field === 'calls' ? 0 : 5 } as never);
    assert.equal(result.ok, false);
  }
});

test('router telemetry validates reservation role and safe amounts without an output token cap', () => {
  const { ledger } = fixture();
  assert.equal(ledger.recordRouter(routerRecord).ok, false);
  ledger.reserve(reservation);
  assert.equal(ledger.recordRouter(routerRecord).ok, false);
  const routed = fixture().ledger;
  routed.reserve(routerReservation);
  for (const malformed of [
    { ...routerRecord, inputTokens: 0 }, { ...routerRecord, inputTokens: null },
    { ...routerRecord, inputTokens: 0.5 }, { ...routerRecord, outputTokens: -1 },
    { ...routerRecord, outputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...routerRecord, spendMicroUsd: null }, { ...routerRecord, calls: 0 },
    { ...routerRecord, outcome: 'not_dispatched', calls: 0 },
  ]) assert.equal(routed.recordRouter(malformed as never).ok, false);
  assert.equal(routed.recordRouter({ ...routerRecord, outputTokens: Number.MAX_SAFE_INTEGER }).ok, true);
});

test('unknown router records retain reservations and block admission through replay', () => {
  const { ledger, events } = fixture();
  ledger.reserve(routerReservation);
  const unknown = { ...routerRecord, outcome: 'unknown' as const, inputTokens: null, outputTokens: null, spendMicroUsd: null };
  assert.equal(ledger.recordRouter(unknown).ok, true);
  assert.equal(ledger.snapshot().used.spendMicroUsd, 934);
  assert.equal(ledger.snapshot().used.tokens, 0);
  assert.equal(ledger.snapshot().accounting, 'unknown');
  const replay = createBudgetLedger({ caps, clock: () => 100, events, persist: () => {} });
  assert.equal(replay.snapshot().admissionBlocked, true);
  assert.equal(replay.reserve({ ...reservation, dispatchId: 'next', attempt: 2, spendMicroUsd: 1 }).ok, false);
});

test('router journal failure grants no telemetry commit and poisons subsequent writes', () => {
  const events: BudgetLedgerEvent[] = [];
  const ledger = createBudgetLedger({ caps, clock: () => 100, persist(event) {
    if (event.type === 'budget_router') throw new Error('disk unavailable');
    events.push(event);
  } });
  ledger.reserve(routerReservation);
  const result = ledger.recordRouter(routerRecord);
  assert.equal(result.ok ? '' : result.code, 'E_PERSIST');
  assert.deepEqual(ledger.routerRecords(), []);
  assert.equal(ledger.snapshot().used.spendMicroUsd, 934);
  assert.equal(ledger.snapshot().accounting, 'unknown');
  assert.equal(ledger.settle({ dispatchId: reservation.dispatchId, receiptId: 'settled',
    outcome: 'known', tokens: 0, spendMicroUsd: 4 }).ok, false);
});

test('replay rejects forged router telemetry and not-dispatched records count no call', () => {
  const { ledger, events } = fixture();
  ledger.reserve(routerReservation);
  const zero = { ...routerRecord, calls: 0 as const, outcome: 'not_dispatched' as const,
    inputTokens: 0, outputTokens: 0, spendMicroUsd: 0 };
  assert.equal(ledger.recordRouter(zero).ok, true);
  assert.equal(ledger.routerRecords()[0]?.calls, 0);
  const bad = [...events.slice(0, -1), { type: 'budget_router' as const, seq: 3, at: 100,
    record: { ...routerRecord, dispatchId: 'unadmitted' } }];
  assert.throws(() => createBudgetLedger({ caps, clock: () => 100, events: bad, persist: () => {} }), /invalid budget event/);
});

test('trusted financial reconciliation clears unknown router admission without inventing missing tokens', () => {
  const { ledger, events } = fixture();
  ledger.reserve(routerReservation);
  ledger.recordRouter({ ...routerRecord, outcome: 'unknown', inputTokens: null, outputTokens: null, spendMicroUsd: 3 });
  const receipt = { dispatchId: reservation.dispatchId, receiptId: 'reconciled', outcome: 'known' as const, tokens: 0, spendMicroUsd: 4 };
  assert.equal(ledger.settle(receipt).ok, true);
  assert.equal(ledger.snapshot().accounting, 'known');
  assert.equal(ledger.routerRecords()[0]?.inputTokens, null);
  assert.equal(ledger.routerRecords()[0]?.calls, 1);
  const replay = createBudgetLedger({ caps, clock: () => 100, events, persist: () => {} });
  assert.equal(replay.snapshot().admissionBlocked, false);
  assert.equal(replay.reserve({ ...reservation, dispatchId: 'next', attempt: 2 }).ok, true);
});

test('router receipts cannot charge worker tokens or contradict durable observed spend', () => {
  const { ledger } = fixture();
  ledger.reserve(routerReservation);
  ledger.recordRouter({ ...routerRecord, outcome: 'unknown', spendMicroUsd: 20 });
  const receipt = { dispatchId: reservation.dispatchId, receiptId: 'reconciled', outcome: 'known' as const, tokens: 0, spendMicroUsd: 20 };
  assert.equal(ledger.settle({ ...receipt, tokens: 1 }).ok, false);
  assert.equal(ledger.settle({ ...receipt, spendMicroUsd: 19 }).ok, false);
  assert.equal(ledger.settle({ ...receipt, outcome: 'not_dispatched', spendMicroUsd: 0 }).ok, false);
  assert.equal(ledger.snapshot().used.spendMicroUsd, 934);
  assert.equal(ledger.settle(receipt).ok, true);
});

test('router telemetry refuses unsafe aggregate counters before persistence', () => {
  const { ledger, events } = fixture();
  ledger.reserve(routerReservation);
  ledger.recordRouter({ ...routerRecord, outputTokens: Number.MAX_SAFE_INTEGER });
  ledger.settle({ dispatchId: reservation.dispatchId, receiptId: 'first', outcome: 'known', tokens: 0, spendMicroUsd: 4 });
  ledger.reserve({ ...routerReservation, dispatchId: 'second', attempt: 2 });
  const before = events.length;
  const result = ledger.recordRouter({ ...routerRecord, dispatchId: 'second', outputTokens: 1 });
  assert.equal(result.ok ? '' : result.code, 'E_INVALID');
  assert.equal(events.length, before);
  assert.equal(ledger.routerRecords().length, 1);
});

test('provenance projects only semantic fields and cannot be mutated through replay input', () => {
  const { ledger, events } = fixture();
  ledger.reserve({ ...routerReservation, provenance: { ...routerReservation.provenance, ...reservation } });
  assert.deepEqual(ledger.reservations()[0]?.provenance, routerReservation.provenance);
  const source: BudgetLedgerEvent[] = JSON.parse(JSON.stringify(events));
  const replay = createBudgetLedger({ caps, clock: () => 100, events: source, persist: () => {} });
  const admitted = source[1];
  assert.equal(admitted?.type, 'budget_reserve');
  if (admitted?.type === 'budget_reserve' && admitted.reservation.provenance) {
    Reflect.set(admitted.reservation.provenance, 'provider', 'tampered');
  }
  assert.equal(replay.reservations()[0]?.provenance?.provider, routerReservation.provenance.provider);
});

test('trustworthy router reconciliation updates observed tokens once and preserves monetary reservation until settlement', () => {
  const { ledger, events } = fixture();
  ledger.reserve(routerReservation);
  ledger.recordRouter({ ...routerRecord, outcome: 'unknown', inputTokens: null, outputTokens: null, spendMicroUsd: null });
  ledger.settle({ dispatchId: reservation.dispatchId, receiptId: 'unknown', outcome: 'uncertain', tokens: null, spendMicroUsd: null });
  assert.equal(ledger.recordRouter(routerRecord).ok, true);
  assert.equal(ledger.snapshot().used.spendMicroUsd, 934);
  assert.equal(ledger.routerRecords()[0]?.inputTokens, 100);
  assert.equal(ledger.routerRecords()[0]?.calls, 1);
  assert.equal(ledger.settle({ dispatchId: reservation.dispatchId, receiptId: 'known', outcome: 'known', tokens: 0, spendMicroUsd: 4 }).ok, true);
  const replay = createBudgetLedger({ caps, clock: () => 100, events, persist() {} });
  assert.equal(replay.routerRecords()[0]?.outputTokens, 10_000_000);
  assert.equal(replay.snapshot().used.spendMicroUsd, 4);
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

// ---- Exempt reservations: spend funded by something other than this ledger's caps (external funding) --------------------------

const exempt = { ...reservation, dispatchId: 'managed-1', logicalTurnId: 'managed-turn-1', exempt: true as const };

test('an exempt reservation is admitted beyond the local token and spend caps without consuming them', () => {
  for (const mode of ['bounded', 'interactive'] as const) {
    const ledger = createBudgetLedger({ caps, clock: () => 100, startedAt: 0, executionMode: mode, persist() {} });
    if (mode === 'interactive') ledger.beginOperation('op-1');
    // 50x the local spend cap and 500x the local token cap.
    const big = ledger.reserve({ ...exempt, tokens: 500_000, spendMicroUsd: 50_000 });
    assert.equal(big.ok, true, mode);
    const snapshot = ledger.snapshot();
    assert.deepEqual([snapshot.used.tokens, snapshot.used.spendMicroUsd], [0, 0]);
    assert.deepEqual([snapshot.remaining.tokens, snapshot.remaining.spendMicroUsd], [1000, 1000]);
    assert.deepEqual(snapshot.exemptUsed, { tokens: 500_000, spendMicroUsd: 50_000 });
    assert.equal(snapshot.exhausted, false);
    // The local allowance is still whole and still enforced.
    assert.equal(ledger.reserve({ ...reservation, dispatchId: 'local-1', logicalTurnId: 'local-turn', tokens: 1001 }).ok, false);
    assert.equal(ledger.reserve({ ...reservation, dispatchId: 'local-2', logicalTurnId: 'local-turn-2', tokens: 1000, spendMicroUsd: 1000 }).ok, true);
  }
});

test('local spend still hits the cap while exempt usage accumulates beside it, and neither borrows from the other', () => {
  const { ledger } = fixture();
  assert.equal(ledger.reserve({ ...reservation, spendMicroUsd: 1000 }).ok, true);
  assert.equal(ledger.snapshot().remaining.spendMicroUsd, 0);
  assert.equal(ledger.reserve({ ...reservation, dispatchId: 'local-2', logicalTurnId: 'local-turn-2', attempt: 1, spendMicroUsd: 1 }).ok, false);
  assert.equal(ledger.reserve({ ...exempt, spendMicroUsd: 99_999 }).ok, true);
  assert.equal(ledger.snapshot().exhausted, true, 'the local cap is exhausted, and an exempt dispatch does not undo that');
  assert.equal(ledger.snapshot().exemptUsed.spendMicroUsd, 99_999);
});

test('an exempt dispatch is still bounded by wall-clock time', () => {
  let now = 100;
  const ledger = createBudgetLedger({ caps, clock: () => now, startedAt: 0, persist() {} });
  now = caps.wallClockMs;
  const result = ledger.reserve({ ...exempt });
  assert.equal(result.ok, false);
});

test('unknown exempt usage still blocks every later admission until it is reconciled, and keeps its bound out of the local caps', () => {
  const { ledger } = fixture();
  ledger.reserve({ ...exempt, tokens: 5000, spendMicroUsd: 5000 });
  const unknown = ledger.settle({ dispatchId: 'managed-1', receiptId: 'u1', outcome: 'uncertain', tokens: null, spendMicroUsd: null });
  assert.equal(unknown.ok, true);
  assert.equal(ledger.snapshot().accounting, 'unknown');
  assert.equal(ledger.snapshot().admissionBlocked, true);
  assert.deepEqual([ledger.snapshot().used.tokens, ledger.snapshot().used.spendMicroUsd], [0, 0]);
  const blocked = ledger.reserve({ ...reservation, dispatchId: 'local-3', logicalTurnId: 'local-turn-3' });
  assert.deepEqual([blocked.ok, blocked.ok ? '' : blocked.code], [false, 'E_UNKNOWN']);
  const blockedExempt = ledger.reserve({ ...exempt, dispatchId: 'managed-2', logicalTurnId: 'managed-turn-2' });
  assert.deepEqual([blockedExempt.ok, blockedExempt.ok ? '' : blockedExempt.code], [false, 'E_UNKNOWN']);
  assert.equal(ledger.settle({ dispatchId: 'managed-1', receiptId: 'k1', outcome: 'known', tokens: 700, spendMicroUsd: 300 }).ok, true);
  assert.equal(ledger.snapshot().accounting, 'known');
  assert.deepEqual(ledger.snapshot().exemptUsed, { tokens: 700, spendMicroUsd: 300 });
  assert.equal(ledger.reserve({ ...reservation, dispatchId: 'local-3', logicalTurnId: 'local-turn-3' }).ok, true);
});

test('known and not-dispatched receipts settle exempt entries in the exempt counters only', () => {
  const { ledger } = fixture();
  ledger.reserve({ ...exempt, tokens: 4000, spendMicroUsd: 4000 });
  ledger.settle({ dispatchId: 'managed-1', receiptId: 'k1', outcome: 'known', tokens: 1234, spendMicroUsd: 567 });
  assert.deepEqual(ledger.snapshot().exemptUsed, { tokens: 1234, spendMicroUsd: 567 });
  ledger.reserve({ ...exempt, dispatchId: 'managed-2', logicalTurnId: 'managed-turn-2', tokens: 4000, spendMicroUsd: 4000 });
  ledger.settle({ dispatchId: 'managed-2', receiptId: 'n2', outcome: 'not_dispatched', tokens: 0, spendMicroUsd: 0 });
  assert.deepEqual(ledger.snapshot().exemptUsed, { tokens: 1234, spendMicroUsd: 567 });
  assert.deepEqual([ledger.snapshot().used.tokens, ledger.snapshot().used.spendMicroUsd], [0, 0]);
});

test('exempt usage does not spend the interactive per-operation token allowance', () => {
  const ledger = createBudgetLedger({ caps, clock: () => 100, startedAt: 0, executionMode: 'interactive', persist() {} });
  ledger.beginOperation('op-1');
  ledger.reserve({ ...exempt, tokens: 900_000, spendMicroUsd: 0 });
  assert.equal(ledger.snapshot().executionUsed.tokens, 0);
  assert.equal(ledger.reserve({ ...reservation, tokens: 1000 }).ok, true);
});

test('exempt identity participates in a reservation and invalid values are refused', () => {
  const { ledger } = fixture();
  assert.equal(ledger.reserve({ ...exempt }).ok, true);
  assert.equal(ledger.reserve({ ...exempt }).ok && (ledger.reserve({ ...exempt }) as { duplicate: boolean }).duplicate, true);
  const conflict = ledger.reserve({ ...exempt, exempt: undefined });
  assert.deepEqual([conflict.ok, conflict.ok ? '' : conflict.code], [false, 'E_CONFLICT']);
  for (const bad of [false, 'yes', 1] as const) {
    const result = ledger.reserve({ ...reservation, dispatchId: 'bad', logicalTurnId: 'bad-turn', exempt: bad as never });
    assert.deepEqual([result.ok, result.ok ? '' : result.code], [false, 'E_INVALID'], String(bad));
  }
});

test('a real journal replays exempt reservations into the same accounting, and old journals without the field count as local', () => {
  const events: BudgetLedgerEvent[] = [];
  const ledger = createBudgetLedger({ caps, clock: () => 100, startedAt: 0, persist: event => { events.push(event); } });
  ledger.reserve({ ...exempt, tokens: 5000, spendMicroUsd: 5000 });
  ledger.settle({ dispatchId: 'managed-1', receiptId: 'k1', outcome: 'known', tokens: 4000, spendMicroUsd: 3000 });
  ledger.reserve({ ...reservation });
  const reopened = createBudgetLedger({ caps, clock: () => 100, startedAt: 0, events: JSON.parse(JSON.stringify(events)), persist() { throw new Error('inspection must not write'); } });
  assert.deepEqual(reopened.snapshot(), ledger.snapshot());
  assert.deepEqual(reopened.snapshot().exemptUsed, { tokens: 4000, spendMicroUsd: 3000 });
  // The same events with the flag stripped (an old journal) are admitted as ordinary local usage and fail the local caps.
  const old = JSON.parse(JSON.stringify(events)) as BudgetLedgerEvent[];
  for (const event of old) if (event.type === 'budget_reserve') delete (event.reservation as { exempt?: true }).exempt;
  assert.throws(() => createBudgetLedger({ caps, clock: () => 100, startedAt: 0, events: old, persist() {} }), /budget/i);
});
