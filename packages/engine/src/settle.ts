/**
 * The settle gate as a Pi extension (SPEC 3 verification row; eng-review
 * finding 5).
 *
 * `agent_before_settle` fires when the model stops. With no pending proposal
 * the model is just chatting and the gate stays out of the way. With a pending
 * proposal the verifier must speak first: the gate runs it, feeds the result
 * (plus the retry counter, the tracked failure digests and the `/goal` budget
 * snapshot) into `decideSettle` from @oms/core, and maps the decision:
 *
 *   allow    -> settle; append a `custom` entry recording the pass
 *   continue -> one more model request carrying the failure summary
 *   stop     -> settle; append a visible message saying why and that the user is needed
 *
 * Fail-closed: a verifier that throws is treated as `unavailable`, a malformed
 * run result is `unavailable`, and any unexpected error in the gate itself
 * produces a visible stop rather than a silent allow. Usage accounting and
 * request admission belong to composition; this gate only reads its snapshot.
 */

import {
  decideSettle,
  type BudgetMeter,
  type SettleAction,
  type SettleReason,
} from '@oms/core';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

export type VerifierRunStatus = 'pass' | 'fail' | 'unavailable';

export interface VerifierRunResult {
  status: VerifierRunStatus;
  /** Digest of this run's failure output; used by the repeated-failure loop guard. */
  failureDigest?: string;
  summary: string;
}

/**
 * The gate's view of the verifier. The engine wires a real runner later; tests
 * and the TUI use fakes. A port that throws is handled, never fatal to Pi.
 */
export interface VerifierPort {
  /** True while an item is `proposed` and awaiting the evaluator. */
  hasProposal(): boolean;
  run(): Promise<VerifierRunResult>;
}

/**
 * Matches the `settle` event of @oms/core's `TraceWriter`. Trace failures are
 * swallowed: a broken trace must never change a settle decision.
 */
export interface SettleTraceSink {
  append(event: { type: 'settle' } & Record<string, unknown>): unknown;
}

export interface SettleExtensionOptions {
  verifier: VerifierPort;
  /** `/goal` budget meter; only read (snapshot), never charged here. */
  budget: Pick<BudgetMeter, 'snapshot'>;
  /** Hard retry cap; shares the budget with the caps inside the meter. */
  maxAttempts: number;
  trace?: SettleTraceSink;
  /** Trusted composition supplies its known-secret redactor for all feedback. */
  redact?: (text: string) => string;
  /** Milliseconds since epoch; injected so state and traces are deterministic. */
  now?: () => number;
}

export interface SettleDecisionRecord {
  action: SettleAction;
  reason: SettleReason;
  summary: string;
  askUser: boolean;
  at: string;
}

export interface SettleRunRecord {
  status: VerifierRunStatus;
  summary: string;
  failureDigest?: string;
  at: string;
}

/** What the TUI reads. */
export interface SettleGateState {
  /** Proposal state at the last settle event. */
  pendingProposal: boolean;
  attempts: number;
  maxAttempts: number;
  lastFailureDigest?: string;
  previousFailureDigest?: string;
  lastRun?: SettleRunRecord;
  lastDecision?: SettleDecisionRecord;
}

export type SettleExtension = ExtensionFactory & { getState(): SettleGateState };

const CUSTOM_TYPE = 'oms-settle';

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isRunResult(value: unknown): value is VerifierRunResult {
  if (typeof value !== 'object' || value === null) return false;
  const run = value as Record<string, unknown>;
  if (run['status'] !== 'pass' && run['status'] !== 'fail' && run['status'] !== 'unavailable') {
    return false;
  }
  if (run['failureDigest'] !== undefined && typeof run['failureDigest'] !== 'string') return false;
  return typeof run['summary'] === 'string';
}

export function createSettleExtension(options: SettleExtensionOptions): SettleExtension {
  const maxAttempts = options.maxAttempts;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0) {
    throw new TypeError(`maxAttempts must be a non-negative integer, got ${String(maxAttempts)}`);
  }
  const clock = options.now ?? Date.now;
  const timestamp = (): string => new Date(clock()).toISOString();
  const redact = (text: string): string => {
    try {
      const result = options.redact === undefined ? text : options.redact(text);
      if (typeof result !== 'string') throw new Error('invalid redactor result');
      return result;
    } catch {
      throw new Error('redaction failed; feedback withheld');
    }
  };

  // Retry-loop bookkeeping. `seenProposal` is the rising edge that marks a new
  // proposal (and resets the loop); terminal decisions (allow/stop) reset too,
  // so attempts only ever accumulate across consecutive `continue` decisions.
  let seenProposal = false;
  let pendingProposal = false;
  let attempts = 0;
  let lastFailureDigest: string | undefined;
  let previousFailureDigest: string | undefined;
  let lastRun: SettleRunRecord | undefined;
  let lastDecision: SettleDecisionRecord | undefined;

  const resetLoop = (): void => {
    attempts = 0;
    lastFailureDigest = undefined;
    previousFailureDigest = undefined;
  };

  const message = (content: string, display: boolean): {
    type: 'custom_message';
    customType: typeof CUSTOM_TYPE;
    content: string;
    display: boolean;
  } => {
    let safe: string;
    try {
      safe = redact(content);
    } catch {
      safe = 'settle gate blocked: redaction failed; feedback withheld; the user is needed';
    }
    return { type: 'custom_message', customType: CUSTOM_TYPE, content: safe, display };
  };

  const recordTrace = (fields: Record<string, unknown>): void => {
    // Deliberately non-fatal: @oms/core's writer already never throws; this
    // guards foreign sinks without turning a trace failure into a settle stop.
    try {
      options.trace?.append({ type: 'settle', ...fields });
    } catch {
      // ignored
    }
  };

  const extension = ((pi) => {
    pi.on('agent_before_settle', async () => {
      let pending: boolean;
      try {
        pending = options.verifier.hasProposal();
      } catch (error) {
        return {
          entries: [
            message(
              `settle gate blocked: could not read the proposal state (${describeError(error)}); ` +
                'settle is not allowed, the user is needed',
              true,
            ),
          ],
        };
      }
      pendingProposal = pending;

      // No pending proposal: the model is just chatting. Let it settle.
      if (!pending) {
        seenProposal = false;
        return undefined;
      }

      try {
        if (!seenProposal) {
          seenProposal = true;
          resetLoop();
        }

        let run: VerifierRunResult;
        try {
          run = await options.verifier.run();
        } catch (error) {
          run = { status: 'unavailable', summary: `verifier threw: ${describeError(error)}` };
        }
        if (!isRunResult(run)) {
          run = {
            status: 'unavailable',
            summary: 'verifier returned a malformed result; treated as unavailable',
          };
        }
        run = {
          status: run.status,
          summary: redact(run.summary),
          failureDigest: run.failureDigest === undefined ? undefined : redact(run.failureDigest),
        };

        attempts += 1;
        lastRun = {
          status: run.status,
          summary: run.summary,
          failureDigest: run.failureDigest,
          at: timestamp(),
        };

        if (run.status === 'fail') {
          previousFailureDigest = lastFailureDigest;
          lastFailureDigest = run.failureDigest;
        }

        const decision = decideSettle({
          verifierStatus: run.status,
          attempts,
          maxAttempts,
          budget: options.budget.snapshot(),
          lastFailureDigest,
          previousFailureDigest,
        });
        lastDecision = {
          action: decision.action,
          reason: decision.reason,
          summary: redact(decision.summary),
          askUser: decision.askUser,
          at: timestamp(),
        };
        recordTrace({
          action: decision.action,
          reason: decision.reason,
          attempts,
          maxAttempts,
          verifierStatus: run.status,
          failureDigest: run.failureDigest,
          askUser: decision.askUser,
        });

        if (decision.action === 'allow') {
          const usedAttempts = attempts;
          resetLoop();
          return {
            entries: [
              {
                type: 'custom',
                customType: CUSTOM_TYPE,
                data: {
                  reason: decision.reason,
                  summary: redact(decision.summary),
                  attempts: usedAttempts,
                  at: lastRun.at,
                },
              },
            ],
          };
        }

        if (decision.action === 'continue') {
          return {
            continue: true,
            entries: [
              message(`${decision.summary} Verifier: ${run.summary}`, false),
            ],
          };
        }

        // stop: settle, but visibly, and say when the user is needed.
        const ask = decision.askUser ? ' The user is needed to unblock this.' : '';
        const detail = run.summary.length > 0 ? ` Verifier: ${run.summary}` : '';
        resetLoop();
        return { entries: [message(`${decision.summary}${detail}${ask}`, true)] };
      } catch (error) {
        // Fail closed: an unexpected gate error must never allow the settle.
        resetLoop();
        return {
          entries: [
            message(
              `settle gate error (${describeError(error)}); settle is not allowed, the user is needed`,
              true,
            ),
          ],
        };
      }
    });
  }) as SettleExtension;

  extension.getState = (): SettleGateState => ({
    pendingProposal,
    attempts,
    maxAttempts,
    lastFailureDigest,
    previousFailureDigest,
    lastRun: lastRun === undefined ? undefined : { ...lastRun },
    lastDecision: lastDecision === undefined ? undefined : { ...lastDecision },
  });

  return extension;
}
