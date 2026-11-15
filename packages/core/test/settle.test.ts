import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_BUDGET_CAPS, snapshotFor, type BudgetSnapshot } from '../src/budget/meter.ts';
import { decideSettle, type SettleDecision, type SettleState, type VerifierStatus } from '../src/settle/gate.ts';

const FRESH: BudgetSnapshot = snapshotFor(DEFAULT_BUDGET_CAPS, {
  tokens: 0,
  spendMicroUsd: 0,
  wallClockMs: 0,
});

const EXHAUSTED: BudgetSnapshot = snapshotFor(DEFAULT_BUDGET_CAPS, {
  tokens: DEFAULT_BUDGET_CAPS.tokens,
  spendMicroUsd: 0,
  wallClockMs: 0,
});

function state(overrides: Partial<SettleState> = {}): SettleState {
  return {
    verifierStatus: 'fail',
    attempts: 1,
    maxAttempts: 3,
    budget: FRESH,
    lastFailureDigest: 'aaaa1111bbbb',
    previousFailureDigest: 'cccc2222dddd',
    ...overrides,
  };
}

test('settle decisions table', () => {
  const cases: Array<{ name: string; input: SettleState; expected: Partial<SettleDecision> }> = [
    {
      name: 'pass allows',
      input: state({ verifierStatus: 'pass' }),
      expected: { action: 'allow', reason: 'verifier_passed', askUser: false },
    },
    {
      name: 'pass wins over an exhausted budget',
      input: state({ verifierStatus: 'pass', budget: EXHAUSTED }),
      expected: { action: 'allow', reason: 'verifier_passed' },
    },
    {
      name: 'fail with room continues',
      input: state(),
      expected: { action: 'continue', reason: 'verifier_failed', askUser: false },
    },
    {
      name: 'same digest twice stops and asks',
      input: state({ lastFailureDigest: 'deadbeef0000', previousFailureDigest: 'deadbeef0000' }),
      expected: { action: 'stop', reason: 'repeated_failure', askUser: true },
    },
    {
      name: 'different digests keep trying',
      input: state({ lastFailureDigest: 'aaa', previousFailureDigest: 'bbb' }),
      expected: { action: 'continue', reason: 'verifier_failed' },
    },
    {
      name: 'attempt cap stops',
      input: state({ attempts: 3, maxAttempts: 3 }),
      expected: { action: 'stop', reason: 'attempts_exhausted', askUser: true },
    },
    {
      name: 'zero attempts allowed stops',
      input: state({ attempts: 0, maxAttempts: 0 }),
      expected: { action: 'stop', reason: 'attempts_exhausted' },
    },
    {
      name: 'exhausted budget stops',
      input: state({ budget: EXHAUSTED }),
      expected: { action: 'stop', reason: 'budget_exhausted', askUser: true },
    },
    {
      name: 'repeat beats budget in the reason',
      input: state({ budget: EXHAUSTED, lastFailureDigest: 'same', previousFailureDigest: 'same' }),
      expected: { action: 'stop', reason: 'repeated_failure' },
    },
    {
      name: 'unavailable never settles',
      input: state({ verifierStatus: 'unavailable' }),
      expected: { action: 'stop', reason: 'verifier_unavailable' },
    },
    {
      name: 'running never settles',
      input: state({ verifierStatus: 'running' }),
      expected: { action: 'stop', reason: 'verifier_running' },
    },
    {
      name: 'unknown status fails closed',
      input: state({ verifierStatus: 'timeout' as VerifierStatus }),
      expected: { action: 'stop', reason: 'unknown_status' },
    },
  ];

  for (const { name, input, expected } of cases) {
    const decision = decideSettle(input);
    assert.equal(decision.action, expected.action, `${name}: action`);
    assert.equal(decision.reason, expected.reason, `${name}: reason`);
    if (expected.askUser !== undefined) assert.equal(decision.askUser, expected.askUser, `${name}: askUser`);
    assert.ok(decision.summary.length > 0 && decision.summary.length <= 160, `${name}: summary`);
  }
});

test('a failed verifier can never be allowed to settle', () => {
  const statuses: VerifierStatus[] = ['fail', 'running', 'unavailable'];
  for (const verifierStatus of statuses) {
    for (const attempts of [0, 1, 3]) {
      const decision = decideSettle(state({ verifierStatus, attempts }));
      assert.notEqual(decision.action, 'allow', `${verifierStatus}/${attempts}`);
    }
  }
});

test('continue carries a short failure summary with attempt count and digest', () => {
  const decision = decideSettle(state({ attempts: 2, lastFailureDigest: 'abcdef1234567890' }));
  assert.equal(decision.action, 'continue');
  assert.match(decision.summary, /2\/3/);
  assert.match(decision.summary, /abcdef123456/);
  assert.equal(decision.summary.includes('abcdef1234567890'), false, 'digest is shortened');
});

test('budget reasons are surfaced in the stop summary', () => {
  const spendExhausted = snapshotFor(DEFAULT_BUDGET_CAPS, {
    tokens: 0,
    spendMicroUsd: DEFAULT_BUDGET_CAPS.spendMicroUsd,
    wallClockMs: 0,
  });
  const decision = decideSettle(state({ budget: spendExhausted }));
  assert.equal(decision.reason, 'budget_exhausted');
  assert.match(decision.summary, /spend/);
});

test('malformed state fails closed instead of guessing', () => {
  const cases: SettleState[] = [
    state({ attempts: 1.5 }),
    state({ attempts: -1 }),
    state({ maxAttempts: Number.NaN }),
    state({ budget: undefined as never }),
  ];
  for (const input of cases) {
    const decision = decideSettle(input);
    assert.equal(decision.action, 'stop');
    assert.equal(decision.reason, 'invalid_state');
  }
});

test('settle decisions are deterministic', () => {
  const input = state({ verifierStatus: 'fail', attempts: 2 });
  assert.deepEqual(decideSettle(input), decideSettle(input));
});
