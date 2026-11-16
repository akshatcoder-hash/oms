import type { BudgetLedger } from '@oms/core';

export type HelperStatus = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

/** Everything a helper line needs. The conversation and its cost are looked up by `sessionFile` and `turnId`. */
export interface HelperRecord {
  readonly id: string;
  readonly agent: string;
  readonly task: string;
  readonly model: string;
  readonly status: HelperStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** Its ledger logicalTurnId. */
  readonly turnId: string;
  readonly sessionFile: string;
  /** The first line of its report. */
  readonly summary?: string;
}

export const HELPER_ENTRY = 'oms.helper';

export type HelperEntryData =
  | { phase: 'start'; record: HelperRecord }
  | { phase: 'end'; id: string; status: HelperStatus; endedAt: number; summary?: string };

/**
 * The parent conversation's `oms.helper` entries, folded into one record per helper. A start with no end is a helper that was
 * running when the process stopped, unless its id is in `running`.
 */
export function foldHelperEntries(
  entries: readonly unknown[],
  running: ReadonlySet<string> = new Set(),
): HelperRecord[] {
  const records = new Map<string, HelperRecord>();
  for (const entry of entries) {
    const { type, customType, data } = (entry ?? {}) as { type?: string; customType?: string; data?: HelperEntryData };
    if (type !== 'custom' || customType !== HELPER_ENTRY || !data) continue;
    if (data.phase === 'start') records.set(data.record.id, data.record);
    else {
      const known = records.get(data.id);
      if (known)
        records.set(data.id, {
          ...known,
          status: data.status,
          endedAt: data.endedAt,
          ...(data.summary === undefined ? {} : { summary: data.summary }),
        });
    }
  }
  return [...records.values()].map((record) =>
    record.endedAt === undefined && !running.has(record.id) ? { ...record, status: 'interrupted' as const } : record,
  );
}

/** What a helper's requests cost, from the ledger alone. An uncertain request counts at its reservation, as the ledger does. */
export function usageOf(ledger: BudgetLedger, turnId: string): { tokens: number; spendMicroUsd: number } {
  const receipts = new Map(ledger.receipts().map((receipt) => [receipt.dispatchId, receipt]));
  let tokens = 0;
  let spendMicroUsd = 0;
  for (const reservation of ledger.reservations()) {
    if (reservation.logicalTurnId !== turnId) continue;
    const receipt = receipts.get(reservation.dispatchId);
    if (!receipt) continue;
    const settled = receipt.outcome === 'uncertain';
    tokens += (settled ? reservation.tokens : receipt.tokens) ?? 0;
    spendMicroUsd += (settled ? reservation.spendMicroUsd : receipt.spendMicroUsd) ?? 0;
  }
  return { tokens, spendMicroUsd };
}
