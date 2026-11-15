import type { DispatchIdentity } from '../models/dispatch.ts';
import { InvalidBudgetCapsError, snapshotFor, type BudgetCaps, type BudgetSnapshot } from './meter.ts';

export type ExecutionMode = 'interactive' | 'bounded';

export type DispatchProvenance = Pick<
  DispatchIdentity,
  'role' | 'provider' | 'modelId' | 'endpointId' | 'policyVersion'
>;

/** Caller-supplied bounds, not estimated prices. Null means no trustworthy bound. */
export interface DispatchReservation {
  readonly dispatchId: string;
  readonly logicalTurnId: string;
  /** Each separately billable retry gets a new dispatchId and attempt. */
  readonly attempt: number;
  readonly tokens: number | null;
  readonly spendMicroUsd: number | null;
  /** Absent only for historical worker reservations. */
  readonly provenance?: DispatchProvenance;
}

export interface WorkerUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** Only a trusted provider adapter/reconciler may issue these receipts. */
export interface UsageReceipt {
  readonly dispatchId: string;
  readonly receiptId: string;
  readonly outcome: 'known' | 'uncertain' | 'not_dispatched';
  readonly tokens: number | null;
  readonly spendMicroUsd: number | null;
  readonly usage?: WorkerUsage;
}

export type BudgetLedgerEvent =
  | {
      readonly type: 'budget_open';
      readonly seq: number;
      readonly version: 1;
      readonly caps: BudgetCaps;
      readonly startedAt: number;
      readonly executionMode?: ExecutionMode;
    }
  | { readonly type: 'budget_mode'; readonly seq: number; readonly at: number; readonly executionMode: ExecutionMode }
  | {
      readonly type: 'budget_operation';
      readonly seq: number;
      readonly at: number;
      readonly operationId: string;
      readonly action: 'begin' | 'end';
    }
  | {
      readonly type: 'budget_reserve';
      readonly seq: number;
      readonly at: number;
      readonly reservation: DispatchReservation;
    }
  | { readonly type: 'budget_settle'; readonly seq: number; readonly at: number; readonly receipt: UsageReceipt };

export interface BudgetLedgerSnapshot extends BudgetSnapshot {
  /** used includes reservations; it is not necessarily final provider usage. */
  readonly accounting: 'known' | 'pending' | 'unknown';
  readonly pendingDispatchIds: readonly string[];
  readonly admissionBlocked: boolean;
  readonly executionMode: ExecutionMode;
  readonly activeOperationId: string | null;
  /** Token/wall usage for admission; used retains cumulative historical totals. */
  readonly executionUsed: BudgetSnapshot['used'];
}

export type BudgetLedgerResult =
  | { readonly ok: true; readonly duplicate: boolean; readonly snapshot: BudgetLedgerSnapshot }
  | {
      readonly ok: false;
      readonly code: 'E_INVALID' | 'E_CONFLICT' | 'E_UNKNOWN' | 'E_BUDGET' | 'E_PERSIST';
      readonly message: string;
    };

type LedgerError = Extract<BudgetLedgerResult, { ok: false }>;

export interface BudgetLedgerOptions {
  readonly caps: BudgetCaps;
  readonly clock: () => number;
  readonly startedAt?: number;
  /** Initial policy only. Replayed journals retain their explicit policy. */
  readonly executionMode?: ExecutionMode;
  /** Complete, validated journal; malformed/truncated journals must be refused by the caller. */
  readonly events?: readonly BudgetLedgerEvent[];
  /** Synchronously durably append (including fsync), or throw. Called before any admission. */
  readonly persist: (event: BudgetLedgerEvent) => void;
}

export interface BudgetLedger {
  setExecutionMode(mode: ExecutionMode): BudgetLedgerResult;
  beginOperation(operationId: string): BudgetLedgerResult;
  endOperation(operationId: string): BudgetLedgerResult;
  /** A duplicate is NOT permission to dispatch again. It identifies an existing admission. */
  reserve(input: DispatchReservation): BudgetLedgerResult;
  settle(input: UsageReceipt): BudgetLedgerResult;
  reservations(): readonly DispatchReservation[];
  receipts(): readonly UsageReceipt[];
  snapshot(): BudgetLedgerSnapshot;
}

type Entry = {
  reservation: DispatchReservation;
  tokens: number;
  spendMicroUsd: number;
  outcome: 'reserved' | UsageReceipt['outcome'];
  observedTokens: number;
  observedSpend: number;
  operationId: string | null;
};

function failure(code: LedgerError['code'], message: string): LedgerError {
  return { ok: false, code, message };
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validProvenance(value: unknown): value is DispatchProvenance {
  return (
    typeof value === 'object' &&
    value !== null &&
    'role' in value &&
    value.role === 'worker' &&
    'provider' in value &&
    identity(value.provider) &&
    'modelId' in value &&
    identity(value.modelId) &&
    'endpointId' in value &&
    identity(value.endpointId) &&
    'policyVersion' in value &&
    identity(value.policyVersion)
  );
}

function copyReservation(input: DispatchReservation): DispatchReservation {
  const value = input?.provenance;
  return Object.freeze({
    ...input,
    ...(validProvenance(value)
      ? {
          provenance: Object.freeze({
            role: value.role,
            provider: value.provider,
            modelId: value.modelId,
            endpointId: value.endpointId,
            policyVersion: value.policyVersion,
          }),
        }
      : {}),
  });
}

function sameReservation(a: DispatchReservation, b: DispatchReservation): boolean {
  const x = a.provenance;
  const y = b.provenance;
  return (
    a.dispatchId === b.dispatchId &&
    a.logicalTurnId === b.logicalTurnId &&
    a.attempt === b.attempt &&
    a.tokens === b.tokens &&
    a.spendMicroUsd === b.spendMicroUsd &&
    (x === undefined
      ? y === undefined
      : y !== undefined &&
        x.role === y.role &&
        x.provider === y.provider &&
        x.modelId === y.modelId &&
        x.endpointId === y.endpointId &&
        x.policyVersion === y.policyVersion)
  );
}

const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
function copyReceipt(input: UsageReceipt): UsageReceipt {
  return Object.freeze({
    ...input,
    ...(input?.usage === undefined ? {} : { usage: Object.freeze({ ...input.usage }) }),
  });
}

function sameReceipt(a: UsageReceipt, b: UsageReceipt): boolean {
  return (
    a.dispatchId === b.dispatchId &&
    a.receiptId === b.receiptId &&
    a.outcome === b.outcome &&
    a.tokens === b.tokens &&
    a.spendMicroUsd === b.spendMicroUsd &&
    (a.usage === undefined
      ? b.usage === undefined
      : b.usage !== undefined && usageFields.every((field) => a.usage![field] === b.usage![field]))
  );
}

/** Single-owner journal. This primitive does not cancel providers or enforce admission outside its caller. */
export function createBudgetLedger(options: BudgetLedgerOptions): BudgetLedger {
  const caps = Object.freeze({ ...options.caps });
  const problems = (['tokens', 'spendMicroUsd', 'wallClockMs'] as const)
    .filter((field) => !count(caps[field]))
    .map((field) => `${field} must be a non-negative safe integer`);
  if (problems.length > 0) throw new InvalidBudgetCapsError(problems);
  const events = options.events ?? [];
  const first = events[0];
  const startedAt = options.startedAt ?? (first?.type === 'budget_open' ? first.startedAt : options.clock());
  if (!Number.isSafeInteger(startedAt)) throw new Error('invalid budget start time');
  const entries = new Map<string, Entry>();
  const attempts = new Map<string, Set<number>>();
  const receipts = new Map<string, UsageReceipt>();
  let tokens = 0;
  let spend = 0;
  let sequence = 0;
  let uncertain = 0;
  let persistenceFailed = false;
  let lastTime = startedAt;
  let executionMode: ExecutionMode =
    first?.type === 'budget_open' ? (first.executionMode ?? 'bounded') : (options.executionMode ?? 'bounded');
  if (executionMode !== 'bounded' && executionMode !== 'interactive') throw new Error('invalid execution mode');
  let activeOperation: { id: string; startedAt: number; tokens: number } | undefined;
  const completedOperations = new Set<string>();
  const pending = (): boolean =>
    [...entries.values()].some((entry) => entry.outcome === 'reserved' || entry.outcome === 'uncertain');
  const executionUsage = (at: number): BudgetSnapshot['used'] => ({
    tokens: executionMode === 'interactive' ? (activeOperation?.tokens ?? 0) : tokens,
    spendMicroUsd: spend,
    wallClockMs:
      executionMode === 'interactive'
        ? activeOperation
          ? Math.max(0, at - activeOperation.startedAt)
          : 0
        : elapsed(at),
  });

  const elapsed = (at: number): number => {
    if (!Number.isSafeInteger(at)) return Number.MAX_SAFE_INTEGER;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, at - startedAt));
  };
  const now = (): number => {
    const at = options.clock();
    if (!Number.isSafeInteger(at)) return Number.MAX_SAFE_INTEGER;
    lastTime = Math.max(lastTime, at);
    return lastTime;
  };
  const snapshot = (): BudgetLedgerSnapshot => {
    const at = now();
    const executionUsed = executionUsage(at);
    const base = snapshotFor(caps, executionUsed);
    // Interactive money admission is model-specific: a subscription dispatch can cost zero.
    const reasons =
      executionMode === 'interactive' ? base.reasons.filter((reason) => reason !== 'spend') : base.reasons;
    const exhausted = reasons.length > 0;
    const pendingDispatchIds = [...entries]
      .filter(([, entry]) => entry.outcome === 'reserved' || entry.outcome === 'uncertain')
      .map(([id]) => id);
    const unknown = persistenceFailed || uncertain > 0;
    return {
      ...base,
      used: { tokens, spendMicroUsd: spend, wallClockMs: elapsed(at) },
      executionMode,
      activeOperationId: activeOperation?.id ?? null,
      executionUsed,
      reasons,
      exhausted,
      accounting: unknown ? 'unknown' : pendingDispatchIds.length > 0 ? 'pending' : 'known',
      pendingDispatchIds,
      admissionBlocked: exhausted || unknown,
    };
  };

  // Validation prepares a mutation; persistence must succeed before it is applied.
  type Prepared = { duplicate: boolean; apply: () => void };
  const prepareReservation = (input: DispatchReservation, at: number): Prepared | LedgerError => {
    if (
      !input ||
      !identity(input.dispatchId) ||
      !identity(input.logicalTurnId) ||
      !count(input.attempt) ||
      input.attempt === 0
    ) {
      return failure('E_INVALID', 'reservation requires stable dispatch/turn IDs and a positive attempt');
    }
    if (input.tokens === null || input.spendMicroUsd === null)
      return failure('E_UNKNOWN', 'reservation requires known token and spend bounds');
    if (!count(input.tokens) || !count(input.spendMicroUsd))
      return failure('E_INVALID', 'reservation amounts must be non-negative safe integers');
    if (input.provenance !== undefined && !validProvenance(input.provenance)) {
      return failure('E_INVALID', 'invalid reservation provenance');
    }
    const existing = entries.get(input.dispatchId);
    if (existing !== undefined) {
      return sameReservation(existing.reservation, input)
        ? { duplicate: true, apply: () => {} }
        : failure('E_CONFLICT', 'dispatch ID already has a different reservation');
    }
    if (attempts.get(input.logicalTurnId)?.has(input.attempt))
      return failure('E_CONFLICT', 'logical turn attempt already has a dispatch');
    if (uncertain > 0) return failure('E_UNKNOWN', 'unreconciled usage prevents new admission');
    if (executionMode === 'interactive' && !activeOperation)
      return failure('E_CONFLICT', 'begin an execution operation before dispatch');
    const used = executionUsage(at);
    if (
      used.wallClockMs >= caps.wallClockMs ||
      used.tokens >= caps.tokens ||
      (executionMode === 'bounded' && spend >= caps.spendMicroUsd) ||
      input.tokens > caps.tokens - used.tokens ||
      input.spendMicroUsd > Math.max(0, caps.spendMicroUsd - spend)
    ) {
      return failure('E_BUDGET', 'reservation exceeds remaining budget');
    }
    if (!count(tokens + input.tokens) || !count(spend + input.spendMicroUsd)) {
      return failure('E_INVALID', 'usage total overflows a safe integer');
    }
    const reservedTokens = input.tokens;
    const reservedSpend = input.spendMicroUsd;
    return {
      duplicate: false,
      apply: () => {
        entries.set(input.dispatchId, {
          reservation: input,
          tokens: reservedTokens,
          spendMicroUsd: reservedSpend,
          outcome: 'reserved',
          observedTokens: 0,
          observedSpend: 0,
          operationId: activeOperation?.id ?? null,
        });
        let usedAttempts = attempts.get(input.logicalTurnId);
        if (usedAttempts === undefined) {
          usedAttempts = new Set();
          attempts.set(input.logicalTurnId, usedAttempts);
        }
        usedAttempts.add(input.attempt);
        tokens += reservedTokens;
        if (activeOperation) activeOperation.tokens += reservedTokens;
        spend += reservedSpend;
      },
    };
  };

  const prepareReceipt = (input: UsageReceipt): Prepared | LedgerError => {
    if (
      !input ||
      !identity(input.dispatchId) ||
      !identity(input.receiptId) ||
      !['known', 'uncertain', 'not_dispatched'].includes(input.outcome) ||
      (input.tokens !== null && !count(input.tokens)) ||
      (input.spendMicroUsd !== null && !count(input.spendMicroUsd))
    ) {
      return failure('E_INVALID', 'invalid usage receipt');
    }
    if (
      input.usage !== undefined &&
      (input.outcome !== 'known' ||
        !input.usage ||
        !usageFields.every((field) => count(input.usage![field])) ||
        usageFields.reduce((sum, field) => sum + input.usage![field], 0) !== input.tokens)
    ) {
      return failure('E_INVALID', 'worker receipt usage must partition its known tokens');
    }
    if (input.outcome !== 'uncertain' && (input.tokens === null || input.spendMicroUsd === null)) {
      return failure('E_UNKNOWN', 'final usage requires known token and spend amounts');
    }
    if (input.outcome === 'not_dispatched' && (input.tokens !== 0 || input.spendMicroUsd !== 0)) {
      return failure('E_INVALID', 'not-dispatched proof must have zero usage');
    }
    const previous = receipts.get(input.receiptId);
    if (previous !== undefined) {
      return sameReceipt(previous, input)
        ? { duplicate: true, apply: () => {} }
        : failure('E_CONFLICT', 'receipt ID already has different usage');
    }
    const entry = entries.get(input.dispatchId);
    if (entry === undefined) return failure('E_CONFLICT', 'receipt has no admitted dispatch');
    if (entry.outcome === 'known' || entry.outcome === 'not_dispatched')
      return failure('E_CONFLICT', 'dispatch already has final usage');
    if (input.outcome === 'not_dispatched' && entry.outcome === 'uncertain')
      return failure('E_CONFLICT', 'uncertain dispatch requires usage reconciliation');
    if (
      (input.tokens !== null && input.tokens < entry.observedTokens) ||
      (input.spendMicroUsd !== null && input.spendMicroUsd < entry.observedSpend)
    ) {
      return failure('E_CONFLICT', 'receipt contradicts previously observed usage');
    }
    const nextTokens =
      input.outcome === 'uncertain' ? Math.max(entry.tokens, input.tokens ?? 0) : (input.tokens as number);
    const nextSpend =
      input.outcome === 'uncertain'
        ? Math.max(entry.spendMicroUsd, input.spendMicroUsd ?? 0)
        : (input.spendMicroUsd as number);
    const totalTokens = tokens - entry.tokens + nextTokens;
    const totalSpend = spend - entry.spendMicroUsd + nextSpend;
    if (!count(totalTokens) || !count(totalSpend)) return failure('E_INVALID', 'usage total overflows a safe integer');
    return {
      duplicate: false,
      apply: () => {
        if (entry.outcome === 'uncertain') uncertain -= 1;
        if (input.outcome === 'uncertain') uncertain += 1;
        if (activeOperation && entry.operationId === activeOperation.id)
          activeOperation.tokens += nextTokens - entry.tokens;
        entry.outcome = input.outcome;
        entry.tokens = nextTokens;
        entry.spendMicroUsd = nextSpend;
        entry.observedTokens = Math.max(entry.observedTokens, input.tokens ?? 0);
        entry.observedSpend = Math.max(entry.observedSpend, input.spendMicroUsd ?? 0);
        tokens = totalTokens;
        spend = totalSpend;
        receipts.set(input.receiptId, input);
      },
    };
  };

  const prepareMode = (mode: ExecutionMode): Prepared | LedgerError => {
    if (mode !== 'interactive' && mode !== 'bounded') return failure('E_INVALID', 'invalid execution mode');
    if (mode === executionMode) return { duplicate: true, apply() {} };
    if (pending()) return failure('E_UNKNOWN', 'unreconciled usage prevents execution mode changes');
    if (activeOperation) return failure('E_CONFLICT', 'finish the active operation before changing execution mode');
    return {
      duplicate: false,
      apply() {
        executionMode = mode;
      },
    };
  };
  const prepareOperation = (id: string, action: 'begin' | 'end'): Prepared | LedgerError => {
    if (!identity(id) || (action !== 'begin' && action !== 'end'))
      return failure('E_INVALID', 'invalid execution operation');
    if (action === 'end') {
      if (!activeOperation)
        return completedOperations.has(id)
          ? { duplicate: true, apply() {} }
          : failure('E_CONFLICT', 'operation is not active');
      if (activeOperation.id !== id) return failure('E_CONFLICT', 'another operation is active');
      return {
        duplicate: false,
        apply() {
          activeOperation = undefined;
          completedOperations.add(id);
        },
      };
    }
    if (pending()) return failure('E_UNKNOWN', 'unreconciled usage prevents a new execution operation');
    if (activeOperation?.id === id) return { duplicate: true, apply() {} };
    if (activeOperation || completedOperations.has(id))
      return failure('E_CONFLICT', 'operation cannot be restarted or overlap');
    return {
      duplicate: false,
      apply() {
        activeOperation = { id, startedAt: lastTime, tokens: 0 };
      },
    };
  };

  const persist = (event: BudgetLedgerEvent): LedgerError | null => {
    try {
      options.persist(event);
    } catch {
      // The append may have reached disk; never retry writes from this instance.
      persistenceFailed = true;
      return failure('E_PERSIST', 'budget journal outcome uncertain; reopen and reconcile before further dispatch');
    }
    sequence = event.seq;
    return null;
  };
  const opened: BudgetLedgerEvent = Object.freeze({
    type: 'budget_open',
    seq: 1,
    version: 1,
    caps,
    startedAt,
    executionMode,
  });
  if (events.length === 0) {
    const error = persist(opened);
    if (error !== null) throw new Error(error.message);
  } else {
    for (const event of events) {
      if (!event || event.seq !== sequence + 1) throw new Error('invalid budget event sequence');
      if (event.seq === 1) {
        if (
          event.type !== 'budget_open' ||
          event.version !== 1 ||
          event.startedAt !== startedAt ||
          event.caps?.tokens !== caps.tokens ||
          event.caps?.spendMicroUsd !== caps.spendMicroUsd ||
          event.caps?.wallClockMs !== caps.wallClockMs
        )
          throw new Error('budget journal configuration mismatch');
      } else {
        if (
          (event.type !== 'budget_reserve' &&
            event.type !== 'budget_settle' &&
            event.type !== 'budget_mode' &&
            event.type !== 'budget_operation') ||
          !Number.isSafeInteger(event.at) ||
          event.at < lastTime
        )
          throw new Error('invalid budget event');
        lastTime = event.at;
        const prepared =
          event.type === 'budget_reserve'
            ? prepareReservation(copyReservation(event.reservation), event.at)
            : event.type === 'budget_settle'
              ? prepareReceipt(copyReceipt(event.receipt))
              : event.type === 'budget_mode'
                ? prepareMode(event.executionMode)
                : prepareOperation(event.operationId, event.action);
        if ('ok' in prepared) throw new Error(`invalid budget event: ${prepared.message}`);
        prepared.apply();
      }
      sequence = event.seq;
    }
  }

  const commit = (event: BudgetLedgerEvent, prepared: Prepared | LedgerError): BudgetLedgerResult => {
    if ('ok' in prepared) return prepared;
    if (prepared.duplicate) return { ok: true, duplicate: true, snapshot: snapshot() };
    const error = persist(event);
    if (error !== null) return error;
    prepared.apply();
    return { ok: true, duplicate: false, snapshot: snapshot() };
  };
  return {
    snapshot,
    setExecutionMode(mode) {
      if (persistenceFailed) return failure('E_PERSIST', 'budget journal requires recovery');
      const at = now();
      return commit({ type: 'budget_mode', seq: sequence + 1, at, executionMode: mode }, prepareMode(mode));
    },
    beginOperation(operationId) {
      if (persistenceFailed) return failure('E_PERSIST', 'budget journal requires recovery');
      const at = now();
      return commit(
        { type: 'budget_operation', seq: sequence + 1, at, operationId, action: 'begin' },
        prepareOperation(operationId, 'begin'),
      );
    },
    endOperation(operationId) {
      if (persistenceFailed) return failure('E_PERSIST', 'budget journal requires recovery');
      const at = now();
      return commit(
        { type: 'budget_operation', seq: sequence + 1, at, operationId, action: 'end' },
        prepareOperation(operationId, 'end'),
      );
    },
    reservations: () => Object.freeze([...entries.values()].map((entry) => entry.reservation)),
    receipts: () => Object.freeze([...receipts.values()]),
    reserve(input) {
      if (persistenceFailed) return failure('E_PERSIST', 'budget journal requires recovery');
      const at = now();
      // Detach nested provenance before either persistence or admission can retain it.
      const reservation = copyReservation(input);
      return commit(
        Object.freeze({ type: 'budget_reserve', seq: sequence + 1, at, reservation }),
        prepareReservation(reservation, at),
      );
    },
    settle(input) {
      if (persistenceFailed) return failure('E_PERSIST', 'budget journal requires recovery');
      const at = now();
      const receipt = copyReceipt(input);
      return commit(Object.freeze({ type: 'budget_settle', seq: sequence + 1, at, receipt }), prepareReceipt(receipt));
    },
  };
}
