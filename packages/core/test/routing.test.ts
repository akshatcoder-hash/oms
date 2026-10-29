import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_ROUTING_TABLE,
  LEAD_ONLY_PHASES,
  LEAD_ONLY_TOOL_CLASSES,
  ROUTE_PHASES,
  TOOL_CLASSES,
  explainRoute,
  isLeadOnlyRoute,
  resolve,
  validateRoutingTable,
  type RouteInput,
  type RouteRole,
  type RoutingTable,
} from '../src/routing/table.ts';

function table(rules: RoutingTable['rules']): RoutingTable {
  return { version: 1, rules };
}

test('the default table validates', () => {
  const validation = validateRoutingTable(DEFAULT_ROUTING_TABLE);
  assert.equal(validation.ok, true, JSON.stringify(validation));
});

test('default routing assignments', () => {
  const cases: Array<[RouteInput, RouteRole]> = [
    [{ phase: 'plan', toolClass: 'read' }, 'lead'],
    [{ phase: 'plan', toolClass: 'search' }, 'lead'],
    [{ phase: 'edit', toolClass: 'edit' }, 'lead'],
    [{ phase: 'edit', toolClass: 'exec' }, 'lead'],
    [{ phase: 'edit', toolClass: 'read' }, 'sidekick'],
    [{ phase: 'verify', toolClass: 'exec' }, 'lead'],
    [{ phase: 'verify', toolClass: 'rpc' }, 'lead'],
    [{ phase: 'triage', toolClass: 'rpc' }, 'sidekick'],
    [{ phase: 'triage', toolClass: 'search' }, 'sidekick'],
    [{ phase: 'docs', toolClass: 'docs' }, 'sidekick'],
    [{ phase: 'docs', toolClass: 'search' }, 'sidekick'],
    [{ phase: 'final', toolClass: 'read' }, 'lead'],
    [{ phase: 'final', toolClass: 'docs' }, 'lead'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(resolve(DEFAULT_ROUTING_TABLE, input), expected, JSON.stringify(input));
  }
});

test('hard rule: sign and final can never route to the sidekick', () => {
  // A hostile / hand-edited table that tries to send both to the sidekick.
  const hostile = table([
    { toolClass: 'sign', role: 'sidekick' },
    { phase: 'final', role: 'sidekick' },
    { phase: 'plan', role: 'sidekick' },
  ]);
  for (const phase of ROUTE_PHASES) {
    for (const toolClass of TOOL_CLASSES) {
      const input: RouteInput = { phase, toolClass };
      const role = resolve(hostile, input);
      if (isLeadOnlyRoute(input)) {
        assert.equal(role, 'lead', `${phase}/${toolClass} must be lead`);
      }
    }
  }
  assert.deepEqual(LEAD_ONLY_TOOL_CLASSES, ['sign']);
  assert.deepEqual(LEAD_ONLY_PHASES, ['final']);

  const explanation = explainRoute(hostile, { phase: 'final', toolClass: 'read' });
  assert.equal(explanation.role, 'lead');
  assert.equal(explanation.clamped, true);
  assert.equal(explanation.reason, 'clamped_lead_only');
  assert.equal(explanation.matchedIndex, 1, 'the clamp still reports the rule that would have matched');
});

test('validation rejects a sidekick rule for sign or final with a precise code', () => {
  const cases: Array<{ name: string; value: unknown; code: string; index: number | null }> = [
    { name: 'not an object', value: 42, code: 'not_object', index: null },
    { name: 'wrong version', value: { version: 2, rules: [] }, code: 'version_unsupported', index: null },
    { name: 'rules not array', value: { version: 1, rules: {} }, code: 'rules_not_array', index: null },
    { name: 'rule not object', value: { version: 1, rules: ['x'] }, code: 'rule_not_object', index: 0 },
    {
      name: 'unknown phase',
      value: table([{ phase: 'deploy' as never, role: 'lead' }]),
      code: 'unknown_phase',
      index: 0,
    },
    {
      name: 'unknown tool class',
      value: table([{ toolClass: 'shell' as never, role: 'lead' }]),
      code: 'unknown_tool_class',
      index: 0,
    },
    {
      name: 'unknown role',
      value: table([{ phase: 'plan', role: 'advisor' as never }]),
      code: 'unknown_role',
      index: 0,
    },
    {
      name: 'unmatchable rule',
      value: table([{ role: 'lead' }]),
      code: 'unmatchable_rule',
      index: 0,
    },
    {
      name: 'unknown field',
      value: table([{ phase: 'plan', role: 'lead', model: 'x' } as never]),
      code: 'unknown_field',
      index: 0,
    },
    {
      name: 'bad note',
      value: table([{ phase: 'plan', role: 'lead', note: 7 } as never]),
      code: 'bad_note',
      index: 0,
    },
    {
      name: 'sidekick for sign',
      value: table([{ toolClass: 'sign', role: 'sidekick' }]),
      code: 'sidekick_forbidden',
      index: 0,
    },
    {
      name: 'sidekick for final',
      value: table([{ phase: 'final', role: 'sidekick' }]),
      code: 'sidekick_forbidden',
      index: 0,
    },
  ];
  for (const { name, value, code, index } of cases) {
    const validation = validateRoutingTable(value);
    assert.equal(validation.ok, false, name);
    if (validation.ok) continue;
    const issue = validation.issues.find((entry) => entry.code === code);
    assert.ok(issue, `${name}: expected ${code}, got ${validation.issues.map((entry) => entry.code).join(',')}`);
    assert.equal(issue.index, index, name);
    assert.ok(issue.message.length > 0, name);
  }
});

test('first match wins, not best match', () => {
  const ordered = table([
    { phase: 'edit', role: 'sidekick' },
    { phase: 'edit', toolClass: 'read', role: 'lead' },
  ]);
  assert.equal(resolve(ordered, { phase: 'edit', toolClass: 'read' }), 'sidekick');
  assert.equal(resolve(ordered, { phase: 'edit', toolClass: 'edit' }), 'sidekick');

  const reversed = table([
    { phase: 'edit', toolClass: 'read', role: 'lead' },
    { phase: 'edit', role: 'sidekick' },
  ]);
  assert.equal(resolve(reversed, { phase: 'edit', toolClass: 'read' }), 'lead');
  assert.equal(resolve(reversed, { phase: 'edit', toolClass: 'edit' }), 'sidekick');
});

test('both phase and toolClass must match when both are set', () => {
  const specific = table([{ phase: 'plan', toolClass: 'read', role: 'sidekick' }]);
  assert.equal(resolve(specific, { phase: 'plan', toolClass: 'read' }), 'sidekick');
  assert.equal(resolve(specific, { phase: 'edit', toolClass: 'read' }), 'lead');
  assert.equal(resolve(specific, { phase: 'plan', toolClass: 'edit' }), 'lead');
});

test('unmatched routes default to the lead', () => {
  assert.equal(resolve(table([]), { phase: 'plan', toolClass: 'read' }), 'lead');
  const onlyReads = table([{ toolClass: 'read', role: 'sidekick' }]);
  assert.equal(resolve(onlyReads, { phase: 'plan', toolClass: 'exec' }), 'lead');
  const explanation = explainRoute(onlyReads, { phase: 'plan', toolClass: 'exec' });
  assert.equal(explanation.reason, 'default_lead');
  assert.equal(explanation.matchedIndex, null);
});

test('invalid runtime input fails to the lead instead of throwing', () => {
  const explanation = explainRoute(DEFAULT_ROUTING_TABLE, {
    phase: 'deploy' as never,
    toolClass: 'read',
  });
  assert.equal(explanation.role, 'lead');
  assert.equal(explanation.reason, 'invalid_input');
  assert.equal(
    resolve(DEFAULT_ROUTING_TABLE, { phase: 'plan', toolClass: 'shell' as never }),
    'lead',
  );
});

test('an unvalidated table cannot invent a third role', () => {
  const bogus = { version: 1, rules: [{ phase: 'plan', role: 'advisor' }] } as unknown as RoutingTable;
  const explanation = explainRoute(bogus, { phase: 'plan', toolClass: 'read' });
  assert.equal(explanation.role, 'lead');
  assert.equal(explanation.reason, 'invalid_input');
  assert.equal(resolve(bogus, { phase: 'plan', toolClass: 'read' }), 'lead');
});

test('routing is deterministic', () => {
  for (const phase of ROUTE_PHASES) {
    for (const toolClass of TOOL_CLASSES) {
      const input: RouteInput = { phase, toolClass };
      assert.equal(resolve(DEFAULT_ROUTING_TABLE, input), resolve(DEFAULT_ROUTING_TABLE, input));
      assert.deepEqual(
        explainRoute(DEFAULT_ROUTING_TABLE, input),
        explainRoute(DEFAULT_ROUTING_TABLE, input),
      );
    }
  }
});

test('validation normalizes a valid table without losing notes', () => {
  const validation = validateRoutingTable({
    version: 1,
    rules: [{ toolClass: 'read', role: 'sidekick', note: 'cheap reads' }],
  });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  assert.deepEqual(validation.table.rules, [{ toolClass: 'read', role: 'sidekick', note: 'cheap reads' }]);
  assert.equal(resolve(validation.table, { phase: 'docs', toolClass: 'read' }), 'sidekick');
});
