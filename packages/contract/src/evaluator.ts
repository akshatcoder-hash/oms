/**
 * The evaluator.
 *
 * The generator only *proposes* that an item is done. Closing an item exists on
 * exactly one object in this package, `createEvaluator`, and requires:
 *
 *   1. the pin verifies (contract, verifier files, evaluator config unchanged);
 *   2. the item is `proposed` (never `open`, `active`, `closed` or `blocked`);
 *   3. evidence bound to the immutable requirement/config, complete code inputs,
 *      pinned verifier and actual snapshot bytes, unchanged after execution;
 *   4. a passing run in `offline-snapshot` mode. A `forked` run is labeled and
 *      never closes an item.
 *
 * A failing run moves the item back to `active` and counts a reopen; at the cap
 * the item becomes `blocked` so the UI can ask the user. Model narration,
 * stdout and self-reported success never enter this path.
 */

import { applyClose, applyFailedRun, applyPropose, applyReopen } from './contract-io.ts';
import { digestJson } from './digest.ts';
import { digestCodeInputs, saveCodeInputs, snapshotDigest, specificationDigest, type SavedInputs } from './inputs.ts';
import {
  evidenceCacheKey,
  parseEvidence,
  type Evidence,
  type VerifierCache,
} from './evidence.ts';
import { isPathError, type TaskRoots } from './paths.ts';
import { verifyPin, type Mismatch } from './pin.ts';
import type { Result, ValidationIssue } from './result.ts';
import { parseEvaluatorConfig } from './schema.ts';
import { createContractStore, type ContractStore, type StoreResult } from './store.ts';
import type { ContractItem, EvaluatorConfig, ItemStatus, TaskContract } from './types.ts';
import { withSourceAccess } from './source-access.ts';

export interface RunnerContext {
  itemId: string;
  /** Saved input tree, not the mutable task worktree; mount read-only for execution. */
  codeRoot: string;
  specificationDigest: string;
  /** The evaluator always asks for a reproducible offline run. */
  mode: 'offline-snapshot';
  codeDigest: string;
  verifierDigest: string;
  verifierPaths: string[];
  snapshotDigest: string;
  cacheKey: string;
  evaluatorConfig: EvaluatorConfig;
  now: Date;
}

export interface Runner {
  (item: ContractItem, ctx: RunnerContext): Promise<Evidence>;
  /** Real runtime adapters expose their actual identity for pre-cache checks.
   * Plain functions remain a trusted library injection surface. */
  readonly executionIdentity?: string;
}

export interface EvaluatorOptions extends TaskRoots {
  /** Pin file written by the trusted host outside all task/workspace roots. */
  pinFile: string;
  /** Injected trusted verification: real surfnet in production, controlled ports in tests. */
  runner: Runner;
  cache?: VerifierCache;
  clock?: () => Date;
  /** Failed runs allowed before the item is blocked. Defaults to 3. */
  maxReopen?: number;
}

export type EvaluateResult =
  | {
      closed: true;
      reason: 'verified';
      itemId: string;
      evidence: Evidence;
      cached: boolean;
      evaluatedAt: string;
    }
  | { closed: false; reason: 'pin-mismatch'; mismatches: Mismatch[] }
  | { closed: false; reason: 'evaluator-config-invalid'; issues: ValidationIssue[] }
  | { closed: false; reason: 'contract-invalid'; issues: ValidationIssue[] }
  | { closed: false; reason: 'unknown-item'; itemId: string }
  | { closed: false; reason: 'blocked'; itemId: string; reopenCount: number }
  | { closed: false; reason: 'not-proposed'; itemId: string; status: ItemStatus }
  | { closed: false; reason: 'code-unreadable'; detail: string }
  | { closed: false; reason: 'inputs-changed'; detail: string }
  | { closed: false; reason: 'evidence-invalid'; issues: ValidationIssue[] }
  | { closed: false; reason: 'evidence-not-bound'; detail: string }
  | { closed: false; reason: 'forked-evidence'; detail: string; evidence: Evidence }
  | {
      closed: false;
      reason: 'failed';
      itemId: string;
      detail: string;
      reopenCount: number;
      cached: boolean;
    }
  | {
      closed: false;
      reason: 'reopen-cap';
      itemId: string;
      reopenCount: number;
      detail: string;
    }
  | {
      closed: false;
      reason: 'runner-error';
      itemId: string;
      detail: string;
      reopenCount: number;
      cached: boolean;
    }
  | { closed: false; reason: 'write-refused'; code: string; message: string };

/** A stale closure is a read-time view; historical evidence is never overwritten. */
export type ContractView = Omit<TaskContract, 'items'> & {
  items: (Omit<ContractItem, 'status'> & { status: ItemStatus | 'stale' })[];
};

function readView(store: ContractStore, options: TaskRoots & { pinFile: string }, executionIdentity?: string): Result<ContractView> {
  const read = store.read();
  if (!read.ok) return read;
  if (!read.value.items.some((item) => item.status === 'closed')) return read;
  const pin = verifyPin(options.pinFile, options);
  let code: string | undefined;
  let snapshot: string | undefined;
  const config = pin.ok ? parseEvaluatorConfig(pin.pin.evaluatorConfig) : undefined;
  if (config?.ok) {
    try {
      withSourceAccess(options.codeRoot, () => {
        code = digestCodeInputs(options.codeRoot, config.value, options);
        snapshot = snapshotDigest(options.codeRoot, config.value, options);
      }, options);
    } catch { /* Unreadable or writer-owned inputs invalidate every closure. */ }
  }
  return { ok: true, value: { ...read.value, items: read.value.items.map((item) => {
    if (item.status !== 'closed') return item;
    const e = item.evidence;
    const current = pin.ok && config?.ok && e !== undefined && e.codeDigest === code &&
      e.snapshotDigest === snapshot && e.verifierDigest === pin.pinSet.verifierDigest &&
      e.specificationDigest === specificationDigest(item, config.value) &&
      (executionIdentity === undefined || executionIdentity === config.value.executionIdentity);
    return current ? item : { ...item, status: 'stale' as const };
  }) } };
}
export interface Evaluator {
  evaluate(itemId: string): Promise<EvaluateResult>;
  /** Put a closed, blocked or proposed item back to active (user action). */
  reopen(itemId: string): StoreResult<void>;
  read(): Result<ContractView>;
}

export interface ProposerOptions extends TaskRoots {
  pinFile: string;
}

/**
 * The generator-facing surface. Two methods, both read-only with respect to
 * closure: `propose` is the only transition it can cause.
 */
export interface Proposer {
  propose(itemId: string): StoreResult<void>;
  read(): Result<ContractView>;
}

function describe(error: unknown): string {
  if (isPathError(error)) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return 'unknown error';
}

export function createEvaluator(options: EvaluatorOptions): Evaluator {
  const maxReopen = options.maxReopen ?? 3;
  if (!Number.isInteger(maxReopen) || maxReopen < 1) {
    throw new RangeError('maxReopen must be a positive integer');
  }
  const clock = options.clock ?? (() => new Date());
  const cache = options.cache;
  const store = createContractStore(options);

  const recordFailure = (
    itemId: string,
    reason: 'failed' | 'runner-error',
    detail: string,
    cached = false,
  ): EvaluateResult => {
    const written = store.mutate((contract) => applyFailedRun(contract, itemId, maxReopen));
    if (!written.ok) {
      return { closed: false, reason: 'write-refused', code: String(written.code), message: written.message };
    }
    const { reopenCount, blocked } = written.value;
    if (blocked) {
      return { closed: false, reason: 'reopen-cap', itemId, reopenCount, detail };
    }
    if (reason === 'runner-error') {
      return { closed: false, reason: 'runner-error', itemId, detail, reopenCount, cached };
    }
    return { closed: false, reason: 'failed', itemId, detail, reopenCount, cached };
  };

  const evaluate = async (itemId: string): Promise<EvaluateResult> => {
    const pinCheck = verifyPin(options.pinFile, options);
    if (!pinCheck.ok) {
      return { closed: false, reason: 'pin-mismatch', mismatches: pinCheck.mismatches };
    }

    const config = parseEvaluatorConfig(pinCheck.pin.evaluatorConfig);
    if (!config.ok) {
      return { closed: false, reason: 'evaluator-config-invalid', issues: config.issues };
    }
    if (options.runner.executionIdentity !== undefined && options.runner.executionIdentity !== config.value.executionIdentity) {
      return { closed: false, reason: 'evidence-not-bound', detail: 'verifier execution identity differs from the pinned evaluator configuration' };
    }

    const contract = store.read();
    if (!contract.ok) {
      return { closed: false, reason: 'contract-invalid', issues: contract.issues };
    }
    const item = contract.value.items.find((entry) => entry.id === itemId);
    if (item === undefined) return { closed: false, reason: 'unknown-item', itemId };
    if (item.status === 'blocked') {
      return { closed: false, reason: 'blocked', itemId, reopenCount: item.reopenCount };
    }
    if (item.status !== 'proposed') {
      return { closed: false, reason: 'not-proposed', itemId, status: item.status };
    }

    const now = clock();
    let saved: SavedInputs;
    try {
      saved = saveCodeInputs(options.codeRoot, config.value, options);
    } catch (error) {
      return { closed: false, reason: 'code-unreadable', detail: describe(error) };
    }

    try {
    const codeDigest = saved.codeDigest;
    const specDigest = specificationDigest(item, config.value);
    const context: RunnerContext = {
      itemId,
      codeRoot: saved.codeRoot,
      specificationDigest: specDigest,
      mode: 'offline-snapshot',
      codeDigest,
      verifierDigest: pinCheck.pinSet.verifierDigest,
      verifierPaths: pinCheck.pin.verifier.files.map((file) => file.path),
      snapshotDigest: saved.snapshotDigest,
      cacheKey: evidenceCacheKey({
        specificationDigest: specDigest,
        codeDigest,
        verifierDigest: pinCheck.pinSet.verifierDigest,
        snapshotDigest: saved.snapshotDigest,
      }),
      evaluatorConfig: config.value,
      now,
    };

    const cachedEvidence = cache?.get(context.cacheKey);
    let rawEvidence: Evidence;
    let cached = false;
    let runnerError: unknown;
    let runnerFailed = false;
    if (cachedEvidence !== undefined) {
      rawEvidence = cachedEvidence;
      cached = true;
    } else {
      try {
        rawEvidence = await options.runner(structuredClone(item), structuredClone(context));
      } catch (error) {
        runnerError = error;
        runnerFailed = true;
      }
    }

    // The host owns these expected identities. A runner cannot mutate the
    // context to redefine what was verified, and an edit during await fails closed.
    const afterPin = verifyPin(options.pinFile, options);
    try {
      const changed = withSourceAccess(options.codeRoot, () =>
        !afterPin.ok || digestJson(afterPin.pinSet) !== digestJson(pinCheck.pinSet) ||
        digestCodeInputs(options.codeRoot, config.value, options) !== codeDigest ||
        digestCodeInputs(saved.codeRoot, config.value, options) !== codeDigest ||
        snapshotDigest(options.codeRoot, config.value, options) !== saved.snapshotDigest, options);
      if (changed) {
        return { closed: false, reason: 'inputs-changed', detail: 'verification inputs changed during execution' };
      }
    } catch (error) {
      return { closed: false, reason: 'inputs-changed', detail: describe(error) };
    }
    if (runnerFailed) return recordFailure(itemId, 'runner-error', `runner threw: ${describe(runnerError)}`);

    const parsed = parseEvidence(rawEvidence!);
    if (!parsed.ok) {
      return { closed: false, reason: 'evidence-invalid', issues: parsed.issues };
    }
    const evidence = parsed.value;

    const unbound: string[] = [];
    if (evidence.itemId !== itemId) unbound.push(`evidence is for item "${evidence.itemId}"`);
    if (evidence.specificationDigest !== specDigest) unbound.push('specificationDigest does not match the requirement and evaluator configuration');
    if (evidence.codeDigest !== context.codeDigest) unbound.push('codeDigest does not match the code under test');
    if (evidence.verifierDigest !== context.verifierDigest) unbound.push('verifierDigest does not match the pin');
    if (evidence.snapshotDigest !== context.snapshotDigest) unbound.push('snapshotDigest does not match the pinned snapshot');
    if (unbound.length > 0) {
      return { closed: false, reason: 'evidence-not-bound', detail: unbound.join('; ') };
    }

    // Only reproducible runs are cacheable; a fork is not.
    if (evidence.mode === 'offline-snapshot') cache?.set(context.cacheKey, evidence);

    if (evidence.mode === 'forked') {
      return {
        closed: false,
        reason: 'forked-evidence',
        detail: 'a mainnet-forked run cannot close an item; re-run against the pinned offline snapshot',
        evidence,
      };
    }

    if (!evidence.passed) {
      // A replayed cache hit still counts toward the reopen cap: the cap exists
      // to stop a proposal loop, and a replayed failure is the same loop.
      return recordFailure(itemId, 'failed', evidence.details, cached);
    }

    const written = store.mutate((current) => applyClose(current, itemId, evidence));
    if (!written.ok) {
      return { closed: false, reason: 'write-refused', code: String(written.code), message: written.message };
    }
    return {
      closed: true,
      reason: 'verified',
      itemId,
      evidence,
      cached,
      evaluatedAt: now.toISOString(),
    };
    } finally {
      saved.dispose();
    }
  };

  return {
    evaluate,
    reopen(itemId: string): StoreResult<void> {
      return store.mutate((contract) => applyReopen(contract, itemId));
    },
    read(): Result<ContractView> {
      return readView(store, options, options.runner.executionIdentity);
    },
  };
}

/**
 * Build the generator's contract surface. It has no `evaluate`, no `close` and
 * no way to edit the contract beyond the single `active -> proposed` proposal.
 */
export function createProposer(options: ProposerOptions): Proposer {
  const store = createContractStore(options);
  return Object.freeze({
    propose(itemId: string): StoreResult<void> {
      return store.mutate((contract) => applyPropose(contract, itemId));
    },
    read(): Result<ContractView> {
      return readView(store, options);
    },
  });
}
