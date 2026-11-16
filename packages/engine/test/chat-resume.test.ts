import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DEFAULT_BUDGET_CAPS } from '@oms/core';
import { savedBudgetUsable } from '../src/runtime/chat-session.ts';
import { openBudgetJournal } from '../src/runtime/usage.ts';

const caps = DEFAULT_BUDGET_CAPS;

function journalPath(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'oms-chat-budget-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'saved.budget.jsonl');
}

test('a bounded saved budget expires with its wall clock, and an interactive one does not', (t) => {
  const path = journalPath(t);
  writeFileSync(path, JSON.stringify({ type: 'budget_open', seq: 1, version: 1, caps, startedAt: 0 }) + '\n', {
    mode: 0o600,
  });
  assert.equal(savedBudgetUsable(path, caps, 'bounded', 1), true);
  assert.equal(savedBudgetUsable(path, caps, 'bounded', caps.wallClockMs + 1), false);
  assert.equal(savedBudgetUsable(path, caps, 'interactive', caps.wallClockMs * 100), true);
});

test('resuming never silently enlarges explicitly selected caps', (t) => {
  const path = journalPath(t);
  const small = { tokens: 123, spendMicroUsd: 123, wallClockMs: 120_000 };
  openBudgetJournal({ path, caps: small, clock: Date.now }).close();
  assert.equal(savedBudgetUsable(path, small, 'bounded'), true);
  assert.equal(savedBudgetUsable(path, caps, 'bounded'), false);
});

test('missing, truncated or unreadable accounting is not usable and is left untouched', (t) => {
  const path = journalPath(t);
  assert.equal(savedBudgetUsable(path, caps, 'interactive'), false);
  writeFileSync(path, '{"type":"budget_open"', { mode: 0o600 });
  assert.equal(savedBudgetUsable(path, caps, 'interactive'), false);
  assert.equal(readFileSync(path, 'utf8'), '{"type":"budget_open"');
});

test('a pending dispatch is unknown after a restart', (t) => {
  const path = journalPath(t);
  const journal = openBudgetJournal({ path, caps, clock: Date.now });
  assert.equal(journal.ledger.beginOperation('turn').ok, true);
  assert.equal(
    journal.ledger.reserve({ dispatchId: 'pending', logicalTurnId: 'turn', attempt: 1, tokens: 10, spendMicroUsd: 100 })
      .ok,
    true,
  );
  journal.close();
  const before = readFileSync(path, 'utf8');
  assert.equal(savedBudgetUsable(path, caps, 'interactive'), false);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('known spend exhaustion stays usable for a subscription chat, unknown usage does not', (t) => {
  for (const outcome of ['uncertain', 'known'] as const) {
    const path = journalPath(t);
    const journal = openBudgetJournal({ path, caps, clock: Date.now });
    assert.equal(journal.ledger.beginOperation('turn').ok, true);
    assert.equal(
      journal.ledger.reserve({
        dispatchId: outcome,
        logicalTurnId: 'turn',
        attempt: 1,
        tokens: 10,
        spendMicroUsd: caps.spendMicroUsd,
      }).ok,
      true,
    );
    assert.equal(
      journal.ledger.settle({
        dispatchId: outcome,
        receiptId: 'receipt',
        outcome,
        tokens: outcome === 'known' ? 10 : null,
        spendMicroUsd: outcome === 'known' ? caps.spendMicroUsd : null,
      }).ok,
      true,
    );
    journal.close();
    assert.equal(savedBudgetUsable(path, caps, 'interactive'), outcome === 'known');
  }
});
