import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MCP_SHARE_CAP,
  agentSummaries,
  cacheHitRatio,
  cacheHitRatioAfterTurn,
  cacheHitRatioForAgent,
  formatRatio,
  isCountedTurn,
  mcpShare,
  sessionInputTokens,
  usageProblems,
  windowAfterTurn,
  type TurnUsage,
} from '../src/cache/metrics.ts';

function usage(partial: Partial<TurnUsage> & Pick<TurnUsage, 'agent'>): TurnUsage {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    uncachedInput: 0,
    output: 0,
    cacheSupport: 'yes',
    ...partial,
  };
}

test('hit ratio matches the documented fixture (800/100/100 -> 0.80)', () => {
  const ratio = cacheHitRatio([usage({ agent: 'lead', cacheRead: 800, cacheWrite: 100, uncachedInput: 100 })]);
  assert.deepEqual(ratio, { kind: 'ratio', value: 0.8, numerator: 800, denominator: 1000 });
  assert.equal(formatRatio(ratio), '80.0%');
});

test('a provider without confirmed cache support reports unknown', () => {
  const cases: Array<{ name: string; record: TurnUsage }> = [
    { name: 'support unknown', record: usage({ agent: 'lead', cacheRead: 800, cacheWrite: 100, uncachedInput: 100, cacheSupport: 'unknown' }) },
    { name: 'support no', record: usage({ agent: 'lead', cacheRead: 800, cacheWrite: 100, uncachedInput: 100, cacheSupport: 'no' }) },
  ];
  for (const { name, record } of cases) {
    assert.deepEqual(cacheHitRatio([record]), { kind: 'unknown', reason: 'cache_support_unknown' }, name);
  }

  const withoutField = usage({ agent: 'lead', cacheRead: 1, uncachedInput: 1 });
  delete (withoutField as { cacheSupport?: string }).cacheSupport;
  assert.deepEqual(cacheHitRatio([withoutField]), {
    kind: 'unknown',
    reason: 'cache_support_unknown',
  });
});

test('unknown is never imputed as 0 or as a hit', () => {
  const ratio = cacheHitRatio([
    usage({ agent: 'lead', cacheRead: 900, uncachedInput: 100 }),
    usage({ agent: 'lead', cacheRead: 0, uncachedInput: 100, cacheSupport: 'unknown' }),
  ]);
  const kind: string = ratio.kind;
  assert.equal(kind, 'unknown');
  assert.notEqual(kind, 'ratio');
});

test('empty and zero-denominator inputs are unknown, not 0%', () => {
  assert.deepEqual(cacheHitRatio([]), { kind: 'unknown', reason: 'no_input_tokens' });
  assert.deepEqual(cacheHitRatio([usage({ agent: 'lead', output: 42 })]), {
    kind: 'unknown',
    reason: 'no_input_tokens',
  });
});

test('keep-warm and summary turns are excluded from the ratio', () => {
  const records = [
    usage({ agent: 'lead', turn: 1, cacheRead: 800, cacheWrite: 100, uncachedInput: 100 }),
    usage({ agent: 'lead', turn: 2, cacheRead: 0, cacheWrite: 0, uncachedInput: 5000, tag: 'keep_warm' }),
    usage({ agent: 'lead', turn: 3, cacheRead: 0, cacheWrite: 0, uncachedInput: 4000, tag: 'summary' }),
  ];
  assert.deepEqual(cacheHitRatio(records), { kind: 'ratio', value: 0.8, numerator: 800, denominator: 1000 });
  assert.equal(isCountedTurn(records[1] as TurnUsage), false);
  assert.equal(isCountedTurn(records[2] as TurnUsage), false);
});

test('a window of only excluded turns reports excluded_turns_only', () => {
  const records = [usage({ agent: 'lead', turn: 1, cacheRead: 10, uncachedInput: 10, tag: 'keep_warm' })];
  assert.deepEqual(cacheHitRatio(records), { kind: 'unknown', reason: 'excluded_turns_only' });
});

test('invalid usage is reported, not averaged', () => {
  const bad = usage({ agent: 'lead', cacheRead: -1, uncachedInput: 10 });
  assert.equal(usageProblems(bad).length, 1);
  assert.deepEqual(cacheHitRatio([bad]), { kind: 'unknown', reason: 'invalid_usage' });
  const fractional = usage({ agent: 'lead', cacheRead: 1.5, uncachedInput: 10 });
  assert.deepEqual(cacheHitRatio([fractional]), { kind: 'unknown', reason: 'invalid_usage' });
});

test('per-agent aggregation keeps separate rows', () => {
  const records = [
    usage({ agent: 'lead', turn: 1, cacheRead: 800, cacheWrite: 100, uncachedInput: 100 }),
    usage({ agent: 'sidekick', turn: 1, cacheRead: 100, cacheWrite: 0, uncachedInput: 100 }),
    usage({ agent: 'lead', turn: 2, cacheRead: 400, cacheWrite: 0, uncachedInput: 100 }),
  ];
  assert.deepEqual(cacheHitRatioForAgent(records, 'lead'), {
    kind: 'ratio',
    value: 1200 / 1500,
    numerator: 1200,
    denominator: 1500,
  });
  assert.deepEqual(cacheHitRatioForAgent(records, 'sidekick'), {
    kind: 'ratio',
    value: 0.5,
    numerator: 100,
    denominator: 200,
  });
  assert.deepEqual(cacheHitRatioForAgent(records, 'advisor'), {
    kind: 'unknown',
    reason: 'no_input_tokens',
  });

  const summaries = agentSummaries(records);
  assert.deepEqual(
    summaries.map((row) => row.agent),
    ['lead', 'sidekick'],
  );
  assert.equal(summaries[0]?.turns, 2);
  assert.equal(summaries[0]?.totals.input, 1500);
  assert.equal(summaries[1]?.ratio.kind, 'ratio');
  assert.deepEqual(agentSummaries(records), summaries, 'aggregation is deterministic');
});

test('the after-turn-3 window starts at turn 4', () => {
  const records = [
    usage({ agent: 'lead', turn: 1, cacheRead: 0, uncachedInput: 1000 }),
    usage({ agent: 'lead', turn: 2, cacheRead: 100, uncachedInput: 900 }),
    usage({ agent: 'lead', turn: 3, cacheRead: 200, uncachedInput: 800 }),
    usage({ agent: 'lead', turn: 4, cacheRead: 900, uncachedInput: 100 }),
    usage({ agent: 'lead', turn: 5, cacheRead: 800, cacheWrite: 100, uncachedInput: 100 }),
    usage({ agent: 'lead', turn: 6, cacheRead: 500, uncachedInput: 500 }),
    usage({ agent: 'sidekick', turn: 5, cacheRead: 0, uncachedInput: 9999 }),
    usage({ agent: 'lead', cacheRead: 0, uncachedInput: 9999 }),
  ];
  assert.deepEqual(
    windowAfterTurn(records, 3).map((record) => `${record.agent}:${String(record.turn)}`),
    ['lead:4', 'lead:5', 'lead:6', 'sidekick:5'],
  );
  const ratio = cacheHitRatioAfterTurn(records, { afterTurn: 3, agent: 'lead' });
  assert.deepEqual(ratio, { kind: 'ratio', value: 2200 / 3000, numerator: 2200, denominator: 3000 });
  assert.equal(ratio.kind === 'ratio' ? ratio.value >= 0.8 : false, false, 'window is below target here');
  const early = cacheHitRatioAfterTurn(records, { afterTurn: 0, agent: 'lead' });
  assert.equal(early.kind, 'ratio');
});

test('session input tokens sum every agent and turn', () => {
  const records = [
    usage({ agent: 'lead', cacheRead: 800, cacheWrite: 100, uncachedInput: 100, output: 9999 }),
    usage({ agent: 'sidekick', cacheRead: 5, cacheWrite: 5, uncachedInput: 5 }),
    usage({ agent: 'lead', cacheRead: 0, cacheWrite: 0, uncachedInput: 50, tag: 'keep_warm' }),
  ];
  assert.equal(sessionInputTokens(records), 1000 + 15 + 50);
});

test('MCP share uses the 5% cap', () => {
  const records = [usage({ agent: 'lead', cacheRead: 500, cacheWrite: 0, uncachedInput: 500 })];

  const under = mcpShare({ mcpTokens: 40, records });
  assert.equal(under.sessionInputTokens, 1000);
  assert.deepEqual(under.share, { kind: 'ratio', value: 0.04, numerator: 40, denominator: 1000 });
  assert.equal(under.cap, DEFAULT_MCP_SHARE_CAP);
  assert.equal(under.withinCap, true);

  const over = mcpShare({ mcpTokens: 70, records });
  assert.equal(over.withinCap, false);

  const exactly = mcpShare({ mcpTokens: 50, records });
  assert.equal(exactly.withinCap, true, 'exactly at the cap is inside it');

  const tightened = mcpShare({ mcpTokens: 40, records, cap: 0.03 });
  assert.equal(tightened.withinCap, false);
});

test('MCP share is unknown when the denominator or the counter is unusable', () => {
  const empty = mcpShare({ mcpTokens: 10, records: [] });
  assert.deepEqual(empty.share, { kind: 'unknown', reason: 'no_input_tokens' });
  assert.equal(empty.withinCap, 'unknown');

  const negative = mcpShare({ mcpTokens: -1, records: [usage({ agent: 'lead', uncachedInput: 10 })] });
  assert.deepEqual(negative.share, { kind: 'unknown', reason: 'invalid_usage' });
  assert.equal(negative.withinCap, 'unknown');
});

test('formatRatio spells out unknown', () => {
  assert.equal(formatRatio({ kind: 'unknown', reason: 'cache_support_unknown' }), 'unknown (cache_support_unknown)');
  assert.equal(formatRatio({ kind: 'ratio', value: 0.8, numerator: 8, denominator: 10 }), '80.0%');
});

test('MCP invalid denominators and invalid caps never pass the cap', () => {
  for (const invalid of [-100, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const result = mcpShare({ mcpTokens: 1, records: [usage({ agent: 'lead', uncachedInput: invalid })] });
    assert.deepEqual(result.share, { kind: 'unknown', reason: 'invalid_usage' });
    assert.equal(result.withinCap, 'unknown');
    assert.equal(result.sessionInputTokens, null);
  }
  for (const cap of [-1, 1.1, Number.NaN, Infinity]) {
    assert.equal(mcpShare({ mcpTokens: 1, records: [usage({ agent: 'lead', uncachedInput: 100 })], cap }).withinCap, 'unknown');
  }
});

test('MCP and cache aggregates reject safe-integer sum overflow', () => {
  for (const records of [
    [usage({ agent: 'lead', cacheRead: Number.MAX_SAFE_INTEGER, uncachedInput: 1 })],
    [usage({ agent: 'lead', cacheRead: Number.MAX_SAFE_INTEGER }), usage({ agent: 'lead', uncachedInput: 1 })],
  ]) {
    assert.equal(sessionInputTokens(records), null);
    assert.deepEqual(cacheHitRatio(records), { kind: 'unknown', reason: 'invalid_usage' });
    assert.deepEqual(mcpShare({ mcpTokens: 1, records }).share, { kind: 'unknown', reason: 'invalid_usage' });
    assert.equal(mcpShare({ mcpTokens: 1, records }).withinCap, 'unknown');
  }
});
