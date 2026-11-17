import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { DEFAULT_BUDGET_CAPS, createDeepRedactor, snapshotFor, type BudgetSource } from '@oms/core';
import { createHarness } from '../test-support/harness.ts';
import {
  createSettleExtension,
  type SettleTraceSink,
  type VerifierPort,
  type VerifierRunResult,
} from '../src/settle.ts';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

/** A verifier that reports a scripted pending state (default: always pending) and a queue of run results. */
function scriptedVerifier(steps: VerifierRunResult[], pendingQueue?: boolean[]): VerifierPort & { calls(): number } {
  let runIndex = 0;
  let pendingIndex = 0;
  let calls = 0;
  return {
    hasProposal: () => (pendingQueue === undefined ? true : (pendingQueue[pendingIndex++] ?? false)),
    run: async () => {
      calls += 1;
      const step = steps[runIndex];
      runIndex += 1;
      if (step === undefined) throw new Error('verifier script exhausted');
      return step;
    },
    calls: () => calls,
  };
}

function fixedBudget(): BudgetSource {
  return { snapshot: () => snapshotFor(DEFAULT_BUDGET_CAPS, { tokens: 0, spendMicroUsd: 0, wallClockMs: 0 }) };
}

function transcript(h: { session: { messages: unknown[] } }): string {
  return JSON.stringify(h.session.messages);
}

test('pass on the first run settles with exactly one model request', async () => {
  const verifier = scriptedVerifier([{ status: 'pass', summary: 'all verifier tests passed' }]);
  const gate = createSettleExtension({ verifier, budget: fixedBudget(), maxAttempts: 3 });
  const h = await createHarness({
    extensions: [gate],
    responses: [fauxAssistantMessage(fauxText('work done'))],
  });
  try {
    await h.session.prompt('finish the item');
    assert.equal(h.faux.state.callCount, 1, 'a pass must not request another model turn');
    assert.equal(verifier.calls(), 1);
    const state = gate.getState();
    assert.equal(state.pendingProposal, true);
    assert.equal(state.lastDecision?.action, 'allow');
    assert.equal(state.lastDecision?.reason, 'verifier_passed');
    assert.equal(state.attempts, 0, 'a terminal decision resets the retry loop');
  } finally {
    h.dispose();
  }
});

test('fail then pass: two requests and the failure summary reached the model', async () => {
  const verifier = scriptedVerifier([
    { status: 'fail', failureDigest: DIGEST_A, summary: 'transfer amount mismatch: expected 10, got 5' },
    { status: 'pass', summary: 'all verifier tests passed' },
  ]);
  const gate = createSettleExtension({ verifier, budget: fixedBudget(), maxAttempts: 5 });
  const h = await createHarness({
    extensions: [gate],
    responses: [fauxAssistantMessage(fauxText('first try')), fauxAssistantMessage(fauxText('fixed it'))],
  });
  try {
    await h.session.prompt('finish the item');
    assert.equal(h.faux.state.callCount, 2);
    assert.equal(verifier.calls(), 2);
    assert.match(transcript(h), /transfer amount mismatch: expected 10, got 5/);
    const state = gate.getState();
    assert.equal(state.lastDecision?.action, 'allow');
    assert.equal(state.lastDecision?.reason, 'verifier_passed');
  } finally {
    h.dispose();
  }
});

test('same failure digest twice stops and asks the user; the loop stays bounded', async () => {
  const verifier = scriptedVerifier([
    { status: 'fail', failureDigest: DIGEST_A, summary: 'transfer amount mismatch' },
    { status: 'fail', failureDigest: DIGEST_A, summary: 'transfer amount mismatch' },
    { status: 'fail', failureDigest: DIGEST_A, summary: 'transfer amount mismatch' },
  ]);
  const gate = createSettleExtension({ verifier, budget: fixedBudget(), maxAttempts: 10 });
  const h = await createHarness({
    extensions: [gate],
    responses: [
      fauxAssistantMessage(fauxText('try 1')),
      fauxAssistantMessage(fauxText('try 2')),
      fauxAssistantMessage(fauxText('try 3')),
    ],
  });
  try {
    await h.session.prompt('finish the item');
    assert.equal(h.faux.state.callCount, 2, 'the repeated failure must not buy a third request');
    assert.equal(verifier.calls(), 2);
    const state = gate.getState();
    assert.equal(state.lastDecision?.action, 'stop');
    assert.equal(state.lastDecision?.reason, 'repeated_failure');
    assert.equal(state.lastDecision?.askUser, true);
    assert.match(transcript(h), /user is needed/);
  } finally {
    h.dispose();
  }
});

test('an exhausted budget stops instead of continuing', async () => {
  const verifier = scriptedVerifier([{ status: 'fail', failureDigest: DIGEST_A, summary: 'still failing' }]);
  const zero = { tokens: 0, spendMicroUsd: 0, wallClockMs: 0 };
  const budget: BudgetSource = { snapshot: () => snapshotFor(zero, zero) };
  const gate = createSettleExtension({ verifier, budget, maxAttempts: 10 });
  const h = await createHarness({
    extensions: [gate],
    responses: [fauxAssistantMessage(fauxText('done?'))],
  });
  try {
    await h.session.prompt('finish the item');
    assert.equal(h.faux.state.callCount, 1);
    assert.equal(verifier.calls(), 1);
    const state = gate.getState();
    assert.equal(state.lastDecision?.action, 'stop');
    assert.equal(state.lastDecision?.reason, 'budget_exhausted');
    assert.equal(state.lastDecision?.askUser, true);
  } finally {
    h.dispose();
  }
});

test('the attempt cap stops the loop', async () => {
  const verifier = scriptedVerifier([{ status: 'fail', failureDigest: DIGEST_A, summary: 'still failing' }]);
  const gate = createSettleExtension({ verifier, budget: fixedBudget(), maxAttempts: 1 });
  const h = await createHarness({
    extensions: [gate],
    responses: [fauxAssistantMessage(fauxText('done?'))],
  });
  try {
    await h.session.prompt('finish the item');
    assert.equal(h.faux.state.callCount, 1);
    const state = gate.getState();
    assert.equal(state.lastDecision?.action, 'stop');
    assert.equal(state.lastDecision?.reason, 'attempts_exhausted');
    assert.equal(state.lastDecision?.askUser, true);
  } finally {
    h.dispose();
  }
});

test('a verifier that throws is unavailable: stop, never allow', async () => {
  const verifier: VerifierPort = {
    hasProposal: () => true,
    run: async () => {
      throw new Error('surfnet down');
    },
  };
  const gate = createSettleExtension({ verifier, budget: fixedBudget(), maxAttempts: 5 });
  const h = await createHarness({
    extensions: [gate],
    responses: [fauxAssistantMessage(fauxText('done?'))],
  });
  try {
    await h.session.prompt('finish the item');
    assert.equal(h.faux.state.callCount, 1, 'an unavailable verifier must not continue the loop');
    const state = gate.getState();
    assert.equal(state.lastRun?.status, 'unavailable');
    assert.equal(state.lastDecision?.action, 'stop');
    assert.equal(state.lastDecision?.reason, 'verifier_unavailable');
    assert.match(transcript(h), /surfnet down/);
  } finally {
    h.dispose();
  }
});

test('a malformed verifier result never allows a settle', async () => {
  const verifier: VerifierPort = {
    hasProposal: () => true,
    // Missing summary; a broken verifier cannot manufacture a pass.
    run: async () => ({ status: 'pass' }) as VerifierRunResult,
  };
  const gate = createSettleExtension({ verifier, budget: fixedBudget(), maxAttempts: 5 });
  const h = await createHarness({
    extensions: [gate],
    responses: [fauxAssistantMessage(fauxText('done?'))],
  });
  try {
    await h.session.prompt('finish the item');
    assert.equal(h.faux.state.callCount, 1);
    const state = gate.getState();
    assert.equal(state.lastRun?.status, 'unavailable');
    assert.equal(state.lastDecision?.action, 'stop');
    assert.equal(state.lastDecision?.reason, 'verifier_unavailable');
  } finally {
    h.dispose();
  }
});

test('no pending proposal: the verifier is never called and the model settles', async () => {
  const verifier = scriptedVerifier([], [false]);
  const gate = createSettleExtension({ verifier, budget: fixedBudget(), maxAttempts: 5 });
  const h = await createHarness({
    extensions: [gate],
    responses: [fauxAssistantMessage(fauxText('just chatting'))],
  });
  try {
    await h.session.prompt('hello');
    assert.equal(h.faux.state.callCount, 1);
    assert.equal(verifier.calls(), 0);
    const state = gate.getState();
    assert.equal(state.pendingProposal, false);
    assert.equal(state.lastDecision, undefined);
  } finally {
    h.dispose();
  }
});

test('a new proposal resets the attempt counter', async () => {
  // Settle 1: proposal, fail A -> continue. Settle 2: no proposal. Settle 3: a
  // new proposal failing with the same digest must be treated as a first failure.
  const verifier = scriptedVerifier(
    [
      { status: 'fail', failureDigest: DIGEST_A, summary: 'failing' },
      { status: 'fail', failureDigest: DIGEST_A, summary: 'failing' },
    ],
    [true, false, true, false],
  );
  const gate = createSettleExtension({ verifier, budget: fixedBudget(), maxAttempts: 5 });
  const h = await createHarness({
    extensions: [gate],
    responses: [
      fauxAssistantMessage(fauxText('one')),
      fauxAssistantMessage(fauxText('two')),
      fauxAssistantMessage(fauxText('three')),
      fauxAssistantMessage(fauxText('four')),
    ],
  });
  try {
    await h.session.prompt('first item');
    await h.session.prompt('next item');
    assert.equal(h.faux.state.callCount, 4);
    assert.equal(verifier.calls(), 2);
    const state = gate.getState();
    assert.equal(state.lastDecision?.action, 'continue');
    assert.equal(state.lastDecision?.reason, 'verifier_failed');
    assert.equal(state.attempts, 1, 'the second proposal started from attempts=0');
  } finally {
    h.dispose();
  }
});

test('different failure digests keep the loop going until the cap', async () => {
  const verifier = scriptedVerifier([
    { status: 'fail', failureDigest: DIGEST_A, summary: 'failure one' },
    { status: 'fail', failureDigest: DIGEST_B, summary: 'failure two' },
    { status: 'fail', failureDigest: DIGEST_B, summary: 'failure two' },
  ]);
  const gate = createSettleExtension({ verifier, budget: fixedBudget(), maxAttempts: 5 });
  const h = await createHarness({
    extensions: [gate],
    responses: [
      fauxAssistantMessage(fauxText('try 1')),
      fauxAssistantMessage(fauxText('try 2')),
      fauxAssistantMessage(fauxText('try 3')),
    ],
  });
  try {
    await h.session.prompt('finish the item');
    // Fail A -> continue; fail B -> continue (different digest); fail B again -> stop.
    assert.equal(h.faux.state.callCount, 3);
    assert.equal(verifier.calls(), 3);
    const state = gate.getState();
    assert.equal(state.lastDecision?.action, 'stop');
    assert.equal(state.lastDecision?.reason, 'repeated_failure');
  } finally {
    h.dispose();
  }
});

test('the optional trace sink receives a settle event per decision', async () => {
  const verifier = scriptedVerifier([{ status: 'pass', summary: 'green' }]);
  const events: Record<string, unknown>[] = [];
  const trace: SettleTraceSink = {
    append: (event) => {
      events.push(event);
    },
  };
  const gate = createSettleExtension({ verifier, budget: fixedBudget(), maxAttempts: 3, trace });
  const h = await createHarness({
    extensions: [gate],
    responses: [fauxAssistantMessage(fauxText('done'))],
  });
  try {
    await h.session.prompt('finish the item');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.['type'], 'settle');
    assert.equal(events[0]?.['action'], 'allow');
    assert.equal(events[0]?.['reason'], 'verifier_passed');
    assert.equal(events[0]?.['attempts'], 1);
  } finally {
    h.dispose();
  }
});

test('injected redactor covers verifier feedback and every model-visible error path', async () => {
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i * 3 + 1);
  const encoded = Buffer.from(secret).toString('hex');
  const redact = createDeepRedactor<string>([secret]);
  const scenarios: Array<{ verifier: VerifierPort; budget?: BudgetSource }> = [
    {
      verifier: scriptedVerifier([
        { status: 'fail', summary: `failure ${encoded}`, failureDigest: DIGEST_A },
        { status: 'pass', summary: `passed ${encoded}` },
      ]),
    },
    { verifier: scriptedVerifier([{ status: 'unavailable', summary: encoded }]) },
    {
      verifier: {
        hasProposal: () => true,
        run: async () => {
          throw new Error(encoded);
        },
      },
    },
    {
      verifier: {
        hasProposal: () => {
          throw new Error(encoded);
        },
        run: async () => ({ status: 'pass', summary: '' }),
      },
    },
    {
      verifier: scriptedVerifier([{ status: 'fail', summary: encoded }]),
      budget: {
        ...fixedBudget(),
        snapshot: () => {
          throw new Error(encoded);
        },
      },
    },
  ];
  for (const scenario of scenarios) {
    const gate = createSettleExtension({
      verifier: scenario.verifier,
      budget: scenario.budget ?? fixedBudget(),
      maxAttempts: 3,
      redact,
    });
    const h = await createHarness({
      extensions: [gate],
      responses: [fauxAssistantMessage(fauxText('done')), fauxAssistantMessage(fauxText('fixed'))],
    });
    try {
      await h.session.prompt('finish');
      assert.ok(!transcript(h).includes(encoded));
      assert.ok(!JSON.stringify(gate.getState()).includes(encoded));
      assert.match(transcript(h), /\[REDACTED\]/);
    } finally {
      h.dispose();
    }
  }
});

test('redactor failure never falls back to raw verifier text', async () => {
  const gate = createSettleExtension({
    verifier: scriptedVerifier([{ status: 'fail', summary: 'sensitive verifier output' }]),
    budget: fixedBudget(),
    maxAttempts: 3,
    redact: () => {
      throw new Error('sensitive redactor error');
    },
  });
  const h = await createHarness({
    extensions: [gate],
    responses: [fauxAssistantMessage(fauxText('done'))],
  });
  try {
    await h.session.prompt('finish');
    assert.ok(!transcript(h).includes('sensitive'));
    assert.match(transcript(h), /redaction failed/);
    assert.equal(h.faux.state.callCount, 1);
  } finally {
    h.dispose();
  }
});
