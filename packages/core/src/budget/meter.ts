/**
 * `/goal` budget meter.
 *
 * Three independent caps: tokens, spend and wall clock. Money is integer
 * micro-USD (1 USD = 1_000_000 units) everywhere - no floats, so caps and
 * reservations cannot drift by rounding. Caps are configuration, not constants
 * hidden in call sites; `DEFAULT_BUDGET_CAPS` is only the fallback.
 *
 * The settle gate reads this meter. Callers must supply usage and enforce request
 * admission/cancellation; the meter alone is not a global spending hard stop.
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

export type BudgetField = 'tokens' | 'spendMicroUsd';

export type ChargeErrorCode = 'E_NON_INTEGER' | 'E_NEGATIVE';

export interface ChargeOk {
  readonly ok: true;
  readonly snapshot: BudgetSnapshot;
}

export interface ChargeError {
  readonly ok: false;
  readonly code: ChargeErrorCode;
  readonly field: BudgetField;
  readonly message: string;
}

export type ChargeResult = ChargeOk | ChargeError;

export interface ChargeInput {
  readonly tokens?: number;
  readonly spendMicroUsd?: number;
}

export interface BudgetMeter {
  charge(input: ChargeInput): ChargeResult;
  snapshot(): BudgetSnapshot;
  exhausted(): boolean;
  /** One-line human summary of caps and usage (`/goal` header line). */
  explain(): string;
  readonly caps: BudgetCaps;
}

export interface BudgetMeterOptions {
  readonly caps?: BudgetCaps;
  /** Milliseconds since epoch. Injected for deterministic tests. */
  readonly clock: () => number;
  /** Epoch ms the budget started; defaults to `clock()` at creation. */
  readonly startedAt?: number;
}

export class InvalidBudgetCapsError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid budget caps: ${problems.join('; ')}`);
    this.name = 'InvalidBudgetCapsError';
    this.problems = problems;
  }
}

function capProblems(caps: BudgetCaps): string[] {
  const problems: string[] = [];
  for (const field of ['tokens', 'spendMicroUsd', 'wallClockMs'] as const) {
    const value = caps[field];
    if (!Number.isSafeInteger(value)) problems.push(`${field} must be a safe integer, got ${String(value)}`);
    else if (value < 0) problems.push(`${field} must be >= 0, got ${value}`);
  }
  return problems;
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
  const fraction = String(abs % 1_000_000).padStart(6, '0').replace(/0+$/, '');
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

export function createBudgetMeter(options: BudgetMeterOptions): BudgetMeter {
  const caps = options.caps ?? DEFAULT_BUDGET_CAPS;
  const problems = capProblems(caps);
  if (problems.length > 0) throw new InvalidBudgetCapsError(problems);

  const startedAt = options.startedAt ?? options.clock();
  if (!Number.isFinite(startedAt)) {
    throw new InvalidBudgetCapsError([`startedAt must be finite, got ${String(startedAt)}`]);
  }

  let tokensUsed = 0;
  let spendUsed = 0;

  const elapsed = (): number => {
    const now = options.clock();
    if (!Number.isFinite(now)) return Math.max(0, Number.MAX_SAFE_INTEGER);
    return Math.max(0, Math.floor(now - startedAt));
  };

  const snapshot = (): BudgetSnapshot =>
    snapshotFor(caps, { tokens: tokensUsed, spendMicroUsd: spendUsed, wallClockMs: elapsed() });

  const charge = (input: ChargeInput): ChargeResult => {
    if (input.tokens !== undefined) {
      if (!Number.isSafeInteger(input.tokens)) {
        return {
          ok: false,
          code: 'E_NON_INTEGER',
          field: 'tokens',
          message: `tokens must be a safe integer, got ${String(input.tokens)}`,
        };
      }
      if (input.tokens < 0) {
        return { ok: false, code: 'E_NEGATIVE', field: 'tokens', message: `tokens must be >= 0, got ${input.tokens}` };
      }
    }
    if (input.spendMicroUsd !== undefined) {
      if (!Number.isSafeInteger(input.spendMicroUsd)) {
        return {
          ok: false,
          code: 'E_NON_INTEGER',
          field: 'spendMicroUsd',
          message: `spend must be an integer number of micro-USD, got ${String(input.spendMicroUsd)}`,
        };
      }
      if (input.spendMicroUsd < 0) {
        return {
          ok: false,
          code: 'E_NEGATIVE',
          field: 'spendMicroUsd',
          message: `spend must be >= 0, got ${input.spendMicroUsd}`,
        };
      }
    }
    if ((input.tokens ?? 0) > Number.MAX_SAFE_INTEGER - tokensUsed) {
      return {
        ok: false,
        code: 'E_NON_INTEGER',
        field: 'tokens',
        message: 'token counter would overflow a safe integer',
      };
    }
    if ((input.spendMicroUsd ?? 0) > Number.MAX_SAFE_INTEGER - spendUsed) {
      return {
        ok: false,
        code: 'E_NON_INTEGER',
        field: 'spendMicroUsd',
        message: 'spend counter would overflow a safe integer',
      };
    }
    tokensUsed += input.tokens ?? 0;
    spendUsed += input.spendMicroUsd ?? 0;
    return { ok: true, snapshot: snapshot() };
  };

  const explain = (): string => {
    const state = snapshot();
    const parts = [
      `${formatInteger(state.caps.tokens)} tokens`,
      formatMicroUsd(state.caps.spendMicroUsd),
      formatDuration(state.caps.wallClockMs),
    ];
    const used = `used ${formatInteger(state.used.tokens)} tokens, ${formatMicroUsd(state.used.spendMicroUsd)}, ${formatDuration(state.used.wallClockMs)}`;
    const tail = state.exhausted
      ? `EXHAUSTED (${state.reasons.join(', ')})`
      : `remaining ${formatInteger(state.remaining.tokens)} tokens, ${formatMicroUsd(state.remaining.spendMicroUsd)}, ${formatDuration(state.remaining.wallClockMs)}`;
    return `budget ${parts.join(' / ')} - ${used} - ${tail}`;
  };

  return {
    charge,
    snapshot,
    exhausted: (): boolean => snapshot().exhausted,
    explain,
    caps,
  };
}
