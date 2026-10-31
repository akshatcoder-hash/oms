/**
 * Cache and MCP meters.
 *
 * Definitions are taken verbatim from docs/knowledge-and-cache.md sections 7
 * and 8:
 *   hit_ratio = cache_read / (cache_read + cache_write + input_uncached)
 *   session_input_tokens = sum over all agents and turns of the same three fields
 *   mcp share = mcp_tokens / session_input_tokens, cap 5%
 *
 * Honesty rule (doc section 1.4): a provider that reports no cache data yields
 * `unknown`, never 0 and never a hit. A record whose `cacheSupport` is absent is
 * treated as `unknown` - adapters must not synthesize fields the provider did not
 * return (doc section 4).
 */

export type AgentRole = 'lead' | 'sidekick' | 'advisor' | 'evaluator' | 'subagent';

export type CacheSupport = 'yes' | 'no' | 'unknown';

/**
 * `keep_warm` and `summary` turns are tagged and excluded from the lead's ratio
 * (doc section 8). Keep-warm turns still consume input tokens, so they stay in the
 * MCP-share denominator.
 */
export type TurnTag = 'normal' | 'keep_warm' | 'summary';

export interface TurnUsage {
  readonly agent: AgentRole;
  /** 1-based session turn. Absent means "position unknown" and is never windowed in. */
  readonly turn?: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly uncachedInput: number;
  readonly output: number;
  /** Defaults to `unknown` rather than `yes`. */
  readonly cacheSupport?: CacheSupport;
  readonly tag?: TurnTag;
}

export type UnknownReason =
  | 'no_input_tokens'
  | 'cache_support_unknown'
  | 'invalid_usage'
  | 'excluded_turns_only';

export interface MeasuredRatio {
  readonly kind: 'ratio';
  readonly value: number;
  readonly numerator: number;
  readonly denominator: number;
}

export interface UnknownRatio {
  readonly kind: 'unknown';
  readonly reason: UnknownReason;
}

export type Ratio = MeasuredRatio | UnknownRatio;

export const DEFAULT_MCP_SHARE_CAP = 0.05;

const TOKEN_FIELDS = ['cacheRead', 'cacheWrite', 'uncachedInput', 'output'] as const;

/** Structural problems with a usage record. Empty means valid. */
export function usageProblems(record: TurnUsage): string[] {
  const problems: string[] = [];
  for (const field of TOKEN_FIELDS) {
    const value = record[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      problems.push(`${field} must be a non-negative safe integer, got ${String(value)}`);
    }
  }
  if (record.turn !== undefined && (!Number.isSafeInteger(record.turn) || record.turn < 1)) {
    problems.push(`turn must be a positive safe integer when present, got ${String(record.turn)}`);
  }
  return problems;
}

export function isCountedTurn(record: TurnUsage): boolean {
  return (record.tag ?? 'normal') === 'normal';
}

function ratioFrom(
  records: readonly TurnUsage[],
  excludedReasonIfEmpty: UnknownReason,
): Ratio {
  if (records.length === 0) return { kind: 'unknown', reason: excludedReasonIfEmpty };
  if (records.some((record) => usageProblems(record).length > 0)) {
    return { kind: 'unknown', reason: 'invalid_usage' };
  }
  if (records.some((record) => (record.cacheSupport ?? 'unknown') !== 'yes')) {
    return { kind: 'unknown', reason: 'cache_support_unknown' };
  }
  let cacheRead = 0;
  let denominator = 0;
  for (const record of records) {
    cacheRead += record.cacheRead;
    denominator += record.cacheRead + record.cacheWrite + record.uncachedInput;
    if (!Number.isSafeInteger(cacheRead) || !Number.isSafeInteger(denominator)) {
      return { kind: 'unknown', reason: 'invalid_usage' };
    }
  }
  if (denominator === 0) return { kind: 'unknown', reason: 'no_input_tokens' };
  // Summed numerator over summed denominator is the doc's "mean of per-turn
  // ratios weighted by denominator tokens" (section 8), without float rounding.
  return { kind: 'ratio', value: cacheRead / denominator, numerator: cacheRead, denominator };
}

/**
 * `cache_read / (cache_read + cache_write + input_uncached)` over the given turns.
 * Keep-warm and summary turns are excluded; any turn without confirmed cache
 * support makes the aggregate `unknown`.
 */
export function cacheHitRatio(records: readonly TurnUsage[]): Ratio {
  const included = records.filter(isCountedTurn);
  if (included.length === 0 && records.length > 0) {
    return { kind: 'unknown', reason: 'excluded_turns_only' };
  }
  return ratioFrom(included, 'no_input_tokens');
}

export function cacheHitRatioForAgent(
  records: readonly TurnUsage[],
  agent: AgentRole,
): Ratio {
  return cacheHitRatio(records.filter((record) => record.agent === agent));
}

/** Turns strictly after `afterTurn` (the doc's "after turn 3" window is `afterTurn: 3`). */
export function windowAfterTurn(records: readonly TurnUsage[], afterTurn: number): TurnUsage[] {
  return records.filter((record) => record.turn !== undefined && record.turn > afterTurn);
}

export interface AfterTurnOptions {
  readonly afterTurn: number;
  readonly agent?: AgentRole;
}

export function cacheHitRatioAfterTurn(
  records: readonly TurnUsage[],
  options: AfterTurnOptions,
): Ratio {
  let window = windowAfterTurn(records, options.afterTurn);
  if (options.agent !== undefined) {
    const agent = options.agent;
    window = window.filter((record) => record.agent === agent);
  }
  return cacheHitRatio(window);
}

export interface TokenTotals {
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly uncachedInput: number;
  readonly input: number;
  readonly output: number;
}

export interface AgentSummary {
  readonly agent: AgentRole;
  readonly turns: number;
  readonly totals: TokenTotals;
  readonly ratio: Ratio;
}

function totalsOf(records: readonly TurnUsage[]): TokenTotals {
  let cacheRead = 0;
  let cacheWrite = 0;
  let uncachedInput = 0;
  let output = 0;
  for (const record of records) {
    cacheRead += record.cacheRead;
    cacheWrite += record.cacheWrite;
    uncachedInput += record.uncachedInput;
    output += record.output;
  }
  return { cacheRead, cacheWrite, uncachedInput, input: cacheRead + cacheWrite + uncachedInput, output };
}

/** One row per agent role, sorted by role name so output is deterministic. */
export function agentSummaries(records: readonly TurnUsage[]): AgentSummary[] {
  const byAgent = new Map<AgentRole, TurnUsage[]>();
  for (const record of records) {
    const bucket = byAgent.get(record.agent);
    if (bucket === undefined) byAgent.set(record.agent, [record]);
    else bucket.push(record);
  }
  const agents = [...byAgent.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return agents.map((agent) => {
    const bucket = byAgent.get(agent) ?? [];
    return {
      agent,
      turns: bucket.length,
      totals: totalsOf(bucket),
      ratio: cacheHitRatio(bucket),
    };
  });
}

/** All agents/turns, including warming/summary; null means invalid or overflowing usage. */
export function sessionInputTokens(records: readonly TurnUsage[]): number | null {
  let total = 0;
  for (const record of records) {
    if (usageProblems(record).length > 0) return null;
    total += record.cacheRead + record.cacheWrite + record.uncachedInput;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export interface McpShareInput {
  readonly mcpTokens: number;
  readonly records: readonly TurnUsage[];
  /** Defaults to the 5% policy cap (doc section 7). Tightened caps are allowed. */
  readonly cap?: number;
}

export interface McpShareResult {
  readonly mcpTokens: number;
  readonly sessionInputTokens: number | null;
  readonly share: Ratio;
  readonly cap: number;
  /** `unknown` when tokens cannot be attributed to a denominator. */
  readonly withinCap: boolean | 'unknown';
}

/**
 * MCP-attributed tokens over session input tokens, with the 5% cap check.
 * A zero denominator is `unknown`, not "0% used".
 */
export function mcpShare(input: McpShareInput): McpShareResult {
  const cap = input.cap ?? DEFAULT_MCP_SHARE_CAP;
  const denominator = sessionInputTokens(input.records);
  if (denominator === null || !Number.isSafeInteger(input.mcpTokens) || input.mcpTokens < 0 ||
      !Number.isFinite(cap) || cap < 0 || cap > 1) {
    return {
      mcpTokens: input.mcpTokens,
      sessionInputTokens: denominator,
      share: { kind: 'unknown', reason: 'invalid_usage' },
      cap,
      withinCap: 'unknown',
    };
  }
  if (denominator === 0) {
    return {
      mcpTokens: input.mcpTokens,
      sessionInputTokens: 0,
      share: { kind: 'unknown', reason: 'no_input_tokens' },
      cap,
      withinCap: 'unknown',
    };
  }
  const value = input.mcpTokens / denominator;
  return {
    mcpTokens: input.mcpTokens,
    sessionInputTokens: denominator,
    share: { kind: 'ratio', value, numerator: input.mcpTokens, denominator },
    cap,
    withinCap: value <= cap,
  };
}

/** Format a measured ratio for a meter line; `unknown` is spelled out, never 0%. */
export function formatRatio(ratio: Ratio): string {
  if (ratio.kind === 'unknown') return `unknown (${ratio.reason})`;
  return `${(ratio.value * 100).toFixed(1)}%`;
}
