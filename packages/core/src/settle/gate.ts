/**
 * `agent_before_settle` gate.
 *
 * Pi can request one more model request when the agent tries to finish, so without
 * a gate a failing verifier turns into an infinite loop. This function is the decision half: pure, deterministic, and fail-closed.
 *
 * The retry cap shares the `/goal` budget: `attempts < maxAttempts` is necessary but
 * not sufficient - the budget snapshot must also have room left.
 *
 * `running` never settles: a verifier that has not returned a terminal status cannot
 * produce a pass, and settling anyway would be a silent allow.
 */

import type { BudgetSnapshot } from '../budget/meter.ts';

export type VerifierStatus = 'pass' | 'fail' | 'running' | 'unavailable';

export type SettleAction = 'allow' | 'continue' | 'stop';

export type SettleReason =
  | 'verifier_passed'
  | 'verifier_failed'
  | 'verifier_running'
  | 'verifier_unavailable'
  | 'repeated_failure'
  | 'budget_exhausted'
  | 'attempts_exhausted'
  | 'unknown_status'
  | 'invalid_state';

export interface SettleState {
  readonly verifierStatus: VerifierStatus;
  /** Completed verifier runs in this item's retry loop. */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly budget: BudgetSnapshot;
  /** Digest of the current failure (verifier output digest). */
  readonly lastFailureDigest?: string;
  /** Digest of the previous failure, so a repeat can stop the loop. */
  readonly previousFailureDigest?: string;
}

export interface SettleDecision {
  readonly action: SettleAction;
  readonly reason: SettleReason;
  /** Short human summary for the transcript / gate UI. */
  readonly summary: string;
  /** True when the decision needs the user (loop guard, budget, hard cap). */
  readonly askUser: boolean;
}

function shortDigest(digest: string | undefined): string | null {
  if (digest === undefined) return null;
  const trimmed = digest.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > 12 ? trimmed.slice(0, 12) : trimmed;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function decideSettle(state: SettleState): SettleDecision {
  const problems: string[] = [];
  if (!isCount(state.attempts)) problems.push(`attempts must be a non-negative integer, got ${String(state.attempts)}`);
  if (!isCount(state.maxAttempts)) {
    problems.push(`maxAttempts must be a non-negative integer, got ${String(state.maxAttempts)}`);
  }
  if (state.budget === undefined || typeof state.budget.exhausted !== 'boolean') {
    problems.push('budget snapshot is missing or malformed');
  }
  if (problems.length > 0) {
    return {
      action: 'stop',
      reason: 'invalid_state',
      summary: `settle blocked: ${problems.join('; ')}`,
      askUser: false,
    };
  }

  const attemptLabel = `attempt ${state.attempts}/${state.maxAttempts}`;

  switch (state.verifierStatus) {
    case 'pass':
      return {
        action: 'allow',
        reason: 'verifier_passed',
        summary: `verifier passed (${attemptLabel}); settle allowed`,
        askUser: false,
      };
    case 'unavailable':
      return {
        action: 'stop',
        reason: 'verifier_unavailable',
        summary: 'verifier unavailable; settle blocked rather than silently allowed',
        askUser: false,
      };
    case 'running':
      return {
        action: 'stop',
        reason: 'verifier_running',
        summary: 'verifier still running; settle blocked until it returns a terminal status',
        askUser: false,
      };
    case 'fail':
      break;
    default:
      return {
        action: 'stop',
        reason: 'unknown_status',
        summary: `unknown verifier status ${JSON.stringify(state.verifierStatus)}; settle blocked`,
        askUser: false,
      };
  }

  const lastDigest = shortDigest(state.lastFailureDigest);
  const previousDigest = shortDigest(state.previousFailureDigest);
  if (lastDigest !== null && previousDigest !== null && lastDigest === previousDigest) {
    return {
      action: 'stop',
      reason: 'repeated_failure',
      summary: `same failure twice in a row (${lastDigest}, ${attemptLabel}); stopping and asking the user`,
      askUser: true,
    };
  }

  if (state.budget.exhausted) {
    const reasons = state.budget.reasons.length > 0 ? state.budget.reasons.join(', ') : 'cap reached';
    return {
      action: 'stop',
      reason: 'budget_exhausted',
      summary: `budget exhausted (${reasons}); no further retries`,
      askUser: true,
    };
  }

  if (state.attempts >= state.maxAttempts) {
    return {
      action: 'stop',
      reason: 'attempts_exhausted',
      summary: `retry cap reached (${attemptLabel}); stopping`,
      askUser: true,
    };
  }

  const digest = lastDigest ?? 'no digest';
  return {
    action: 'continue',
    reason: 'verifier_failed',
    summary: `verifier failed (${attemptLabel}, ${digest}); requesting one more attempt within budget`,
    askUser: false,
  };
}
