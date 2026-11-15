/**
 * Budget caps, snapshots and formatters.
 *
 * Three independent caps: tokens, spend and wall clock. Money is integer
 * micro-USD (1 USD = 1_000_000 units) everywhere - no floats, so caps and
 * reservations cannot drift by rounding. Caps are configuration, not constants
 * hidden in call sites; `DEFAULT_BUDGET_CAPS` is only the fallback.
 *
 * The settle gate reads a `BudgetSource` (the reservation ledger in production).
 * Callers must enforce request admission/cancellation; a snapshot alone is not a
 * global spending hard stop.
 */

export interface BudgetCaps {
  readonly tokens: number;
  readonly spendMicroUsd: number;
  readonly wallClockMs: number;
}

/** Proposed defaults. Not measured - see README UNVERIFIED items. */
export const DEFAULT_BUDGET_CAPS: BudgetCaps = Object.freeze({
  tokens: 2_000_000,
  spendMicroUsd: 5_000_000,
  wallClockMs: 30 * 60 * 1000,
});

export type BudgetReason = 'tokens' | 'spend' | 'wall_clock';

export interface BudgetUsage {
  readonly tokens: number;
  readonly spendMicroUsd: number;
  readonly wallClockMs: number;
}

export interface BudgetSnapshot {
  readonly caps: BudgetCaps;
  readonly used: BudgetUsage;
  readonly remaining: BudgetUsage;
  readonly exhausted: boolean;
  readonly reasons: readonly BudgetReason[];
}

/** Anything that can report the current budget; the reservation ledger is the production source. */
export interface BudgetSource {
  snapshot(): BudgetSnapshot;
}

export class InvalidBudgetCapsError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid budget caps: ${problems.join('; ')}`);
    this.name = 'InvalidBudgetCapsError';
    this.problems = problems;
  }
}

function reasonsFor(caps: BudgetCaps, used: BudgetUsage): BudgetReason[] {
  const reasons: BudgetReason[] = [];
  if (used.tokens >= caps.tokens) reasons.push('tokens');
  if (used.spendMicroUsd >= caps.spendMicroUsd) reasons.push('spend');
  if (used.wallClockMs >= caps.wallClockMs) reasons.push('wall_clock');
  return reasons;
}

function remainingOf(caps: BudgetCaps, used: BudgetUsage): BudgetUsage {
  return {
    tokens: Math.max(0, caps.tokens - used.tokens),
    spendMicroUsd: Math.max(0, caps.spendMicroUsd - used.spendMicroUsd),
    wallClockMs: Math.max(0, caps.wallClockMs - used.wallClockMs),
  };
}

/** Build a snapshot from caps and usage without a mutable meter (pure helper). */
export function snapshotFor(caps: BudgetCaps, used: BudgetUsage): BudgetSnapshot {
  const reasons = reasonsFor(caps, used);
  return {
    caps,
    used,
    remaining: remainingOf(caps, used),
    exhausted: reasons.length > 0,
    reasons,
  };
}

/** Group integer digits with commas, locale-free so output is stable. */
export function formatInteger(value: number): string {
  const negative = value < 0;
  const digits = String(Math.abs(value));
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i] ?? '';
  }
  return negative ? `-${out}` : out;
}

/** Micro-USD to a dollar string using integer arithmetic only. */
export function formatMicroUsd(microUsd: number): string {
  const negative = microUsd < 0;
  const abs = Math.abs(microUsd);
  const whole = Math.trunc(abs / 1_000_000);
  const fraction = String(abs % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '');
  const body = fraction.length > 0 ? `${formatInteger(whole)}.${fraction}` : formatInteger(whole);
  return negative ? `-$${body}` : `$${body}`;
}

/** Milliseconds to `1h2m3s` / `30m0s` / `4s`, deterministic. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}
