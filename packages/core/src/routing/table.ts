/**
 * Sealevel routing (docs/eng-review.md finding 4).
 *
 * Routing is configured, never chosen mid-turn: a model-judgement router churns the
 * cache and makes behaviour hard to test. The table is an ordered list of rules; the
 * first matching rule wins, so the order *is* the precedence. Anything unmatched goes
 * to the lead.
 *
 * Hard rule: signing and the final verdict can never route to the sidekick. This is
 * enforced twice - validation rejects such a config, and `resolve` clamps the result
 * even if an unvalidated table is passed in.
 */

export type RoutePhase = 'plan' | 'edit' | 'verify' | 'docs' | 'triage' | 'final';

export const ROUTE_PHASES: readonly RoutePhase[] = Object.freeze([
  'plan',
  'edit',
  'verify',
  'docs',
  'triage',
  'final',
]);

export type ToolClass = 'read' | 'search' | 'edit' | 'exec' | 'docs' | 'rpc' | 'sign';

export const TOOL_CLASSES: readonly ToolClass[] = Object.freeze([
  'read',
  'search',
  'edit',
  'exec',
  'docs',
  'rpc',
  'sign',
]);

export type RouteRole = 'lead' | 'sidekick';

export const ROUTE_ROLES: readonly RouteRole[] = Object.freeze(['lead', 'sidekick']);

/** Tool classes that only the lead may handle. */
export const LEAD_ONLY_TOOL_CLASSES: readonly ToolClass[] = Object.freeze(['sign']);

/** Phases that only the lead may handle. */
export const LEAD_ONLY_PHASES: readonly RoutePhase[] = Object.freeze(['final']);

export interface RoutingRule {
  /** Omit to match every phase. */
  readonly phase?: RoutePhase;
  /** Omit to match every tool class. */
  readonly toolClass?: ToolClass;
  readonly role: RouteRole;
  /** Human note, kept out of the routing decision. */
  readonly note?: string;
}

export interface RoutingTable {
  readonly version: 1;
  readonly rules: readonly RoutingRule[];
}

export interface RouteInput {
  readonly phase: RoutePhase;
  readonly toolClass: ToolClass;
}

export type RoutingIssueCode =
  | 'not_object'
  | 'version_unsupported'
  | 'rules_not_array'
  | 'rule_not_object'
  | 'unknown_phase'
  | 'unknown_tool_class'
  | 'unknown_role'
  | 'unmatchable_rule'
  | 'unknown_field'
  | 'bad_note'
  | 'sidekick_forbidden';

export interface RoutingIssue {
  /** Rule index, or null for a table-level problem. */
  readonly index: number | null;
  readonly code: RoutingIssueCode;
  readonly message: string;
}

export type RoutingValidation =
  | { readonly ok: true; readonly table: RoutingTable }
  | { readonly ok: false; readonly issues: RoutingIssue[] };

const RULE_FIELDS: readonly string[] = Object.freeze(['phase', 'toolClass', 'role', 'note']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPhase(value: unknown): value is RoutePhase {
  return typeof value === 'string' && (ROUTE_PHASES as readonly string[]).includes(value);
}

function isToolClass(value: unknown): value is ToolClass {
  return typeof value === 'string' && (TOOL_CLASSES as readonly string[]).includes(value);
}

function isRole(value: unknown): value is RouteRole {
  return typeof value === 'string' && (ROUTE_ROLES as readonly string[]).includes(value);
}

export function isLeadOnlyRoute(input: RouteInput): boolean {
  return (
    (LEAD_ONLY_PHASES as readonly string[]).includes(input.phase) ||
    (LEAD_ONLY_TOOL_CLASSES as readonly string[]).includes(input.toolClass)
  );
}

/** Validate an unknown value as a routing table, with precise per-rule errors. */
export function validateRoutingTable(value: unknown): RoutingValidation {
  const issues: RoutingIssue[] = [];
  if (!isPlainObject(value)) {
    return {
      ok: false,
      issues: [{ index: null, code: 'not_object', message: 'routing table must be an object' }],
    };
  }
  if (value.version !== 1) {
    issues.push({
      index: null,
      code: 'version_unsupported',
      message: `version must be 1, got ${JSON.stringify(value.version)}`,
    });
  }
  if (!Array.isArray(value.rules)) {
    issues.push({ index: null, code: 'rules_not_array', message: 'rules must be an array' });
    return { ok: false, issues };
  }

  const rules: RoutingRule[] = [];
  for (let index = 0; index < value.rules.length; index += 1) {
    const rawRule: unknown = value.rules[index];
    if (!isPlainObject(rawRule)) {
      issues.push({ index, code: 'rule_not_object', message: `rules[${index}] must be an object` });
      continue;
    }
    for (const key of Object.keys(rawRule)) {
      if (!RULE_FIELDS.includes(key)) {
        issues.push({ index, code: 'unknown_field', message: `rules[${index}] has unknown field "${key}"` });
      }
    }
    if (!isRole(rawRule.role)) {
      issues.push({
        index,
        code: 'unknown_role',
        message: `rules[${index}].role must be one of ${ROUTE_ROLES.join('|')}, got ${JSON.stringify(rawRule.role)}`,
      });
    }
    if (rawRule.phase !== undefined && !isPhase(rawRule.phase)) {
      issues.push({
        index,
        code: 'unknown_phase',
        message: `rules[${index}].phase must be one of ${ROUTE_PHASES.join('|')}, got ${JSON.stringify(rawRule.phase)}`,
      });
    }
    if (rawRule.toolClass !== undefined && !isToolClass(rawRule.toolClass)) {
      issues.push({
        index,
        code: 'unknown_tool_class',
        message: `rules[${index}].toolClass must be one of ${TOOL_CLASSES.join('|')}, got ${JSON.stringify(rawRule.toolClass)}`,
      });
    }
    if (rawRule.note !== undefined && typeof rawRule.note !== 'string') {
      issues.push({ index, code: 'bad_note', message: `rules[${index}].note must be a string` });
    }
    if (rawRule.phase === undefined && rawRule.toolClass === undefined) {
      issues.push({
        index,
        code: 'unmatchable_rule',
        message: `rules[${index}] must set phase or toolClass`,
      });
    }
    if (isRole(rawRule.role) && rawRule.role === 'sidekick') {
      const forbiddenPhase = isPhase(rawRule.phase) && (LEAD_ONLY_PHASES as readonly string[]).includes(rawRule.phase);
      const forbiddenTool =
        isToolClass(rawRule.toolClass) && (LEAD_ONLY_TOOL_CLASSES as readonly string[]).includes(rawRule.toolClass);
      if (forbiddenPhase || forbiddenTool) {
        issues.push({
          index,
          code: 'sidekick_forbidden',
          message: `rules[${index}] cannot route ${forbiddenTool ? 'toolClass "sign"' : 'phase "final"'} to the sidekick`,
        });
      }
    }

    if (issues.some((issue) => issue.index === index)) continue;
    const rule: RoutingRule = {
      role: rawRule.role as RouteRole,
      ...(isPhase(rawRule.phase) ? { phase: rawRule.phase } : {}),
      ...(isToolClass(rawRule.toolClass) ? { toolClass: rawRule.toolClass } : {}),
      ...(typeof rawRule.note === 'string' ? { note: rawRule.note } : {}),
    };
    rules.push(rule);
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, table: { version: 1, rules } };
}

export interface RouteExplanation {
  readonly role: RouteRole;
  /** Index of the winning rule, or null when the default applied or the hard rule clamped. */
  readonly matchedIndex: number | null;
  readonly matchedRule: RoutingRule | null;
  /** True when the table said sidekick and the hard rule forced lead. */
  readonly clamped: boolean;
  readonly reason: 'matched' | 'clamped_lead_only' | 'default_lead' | 'invalid_input';
}

/**
 * Resolve a route. Invalid runtime values (JS callers, bad payloads) fall back to
 * the lead instead of throwing mid-turn.
 */
export function explainRoute(table: RoutingTable, input: RouteInput): RouteExplanation {
  if (!isPhase(input.phase) || !isToolClass(input.toolClass)) {
    return {
      role: 'lead',
      matchedIndex: null,
      matchedRule: null,
      clamped: false,
      reason: 'invalid_input',
    };
  }

  let matchedIndex: number | null = null;
  let matchedRule: RoutingRule | null = null;
  for (let index = 0; index < table.rules.length; index += 1) {
    const rule = table.rules[index];
    if (rule === undefined) continue;
    if (rule.phase !== undefined && rule.phase !== input.phase) continue;
    if (rule.toolClass !== undefined && rule.toolClass !== input.toolClass) continue;
    matchedIndex = index;
    matchedRule = rule;
    break;
  }

  if (matchedRule === null) {
    return { role: 'lead', matchedIndex: null, matchedRule: null, clamped: false, reason: 'default_lead' };
  }
  // An unvalidated table (hand-edited JSON cast to RoutingTable) must not invent a
  // third role: anything that is not a known role fails closed to the lead.
  if (!isRole(matchedRule.role)) {
    return { role: 'lead', matchedIndex, matchedRule, clamped: false, reason: 'invalid_input' };
  }
  if (isLeadOnlyRoute(input) && matchedRule.role === 'sidekick') {
    return { role: 'lead', matchedIndex, matchedRule, clamped: true, reason: 'clamped_lead_only' };
  }
  return { role: matchedRule.role, matchedIndex, matchedRule, clamped: false, reason: 'matched' };
}

/** First match wins; `sign` and the `final` phase always resolve to the lead. */
export function resolve(table: RoutingTable, input: RouteInput): RouteRole {
  return explainRoute(table, input).role;
}

/**
 * Proposed default table. Reads, doc lookups, RPC polling and log triage go to the
 * cheap sidekick; plan/design, edits, command execution, verification decisions and
 * the final verdict stay on the lead.
 *
 * UNVERIFIED: these are proposals, not measured. See README.
 */
const DEFAULT_RULES: readonly RoutingRule[] = Object.freeze([
  { toolClass: 'sign', role: 'lead', note: 'hard rule: signing is lead-only' },
  { phase: 'final', role: 'lead', note: 'hard rule: final verdict is lead-only' },
  { toolClass: 'edit', role: 'lead', note: 'edits and hashline repairs' },
  { phase: 'plan', role: 'lead', note: 'design and decomposition' },
  { phase: 'verify', role: 'lead', note: 'verifier outcome decides the next step' },
  { toolClass: 'exec', role: 'lead', note: 'builds, tests, deploys' },
  { toolClass: 'rpc', role: 'sidekick', note: 'mechanical chain reads' },
  { toolClass: 'docs', role: 'sidekick' },
  { toolClass: 'search', role: 'sidekick' },
  { toolClass: 'read', role: 'sidekick' },
  { phase: 'triage', role: 'sidekick', note: 'log and error triage' },
  { phase: 'docs', role: 'sidekick' },
]);

export const DEFAULT_ROUTING_TABLE: RoutingTable = Object.freeze({
  version: 1,
  rules: DEFAULT_RULES,
});
