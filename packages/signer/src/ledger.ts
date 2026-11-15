import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { SignerError } from './errors.ts';
import { privateDirectory, syncDirectory } from './storage.ts';
import { acquireLedgerLock, type LedgerLock } from './ledger-lock.ts';
import type { ReconciledOutcome, TransactionLifetime } from './profile.ts';

export interface ReservationView {
  reservationId: string;
  txDigest: string;
  lamports: number;
  messageBase64: string;
  profileId: string;
  lifetime: TransactionLifetime;
  signature: string | null;
  outcome: ReconciledOutcome;
  createdAt: number;
  updatedAt: number;
}
export interface ReservationInput { txDigest: string; lamports: number; messageBase64: string; profileId: string; lifetime: TransactionLifetime }
export interface SpendLedgerHooks {
  beforeJournalWrite?: (line: string) => void;
  /** Host-only deterministic recovery barrier; runs while the gate is held. */
  beforeLockRecovery?: () => void;
}
export interface SpendLedgerOptions { hooks?: SpendLedgerHooks }

function validInteger(n: unknown): n is number { return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0; }
function charged(r: ReservationView): boolean { return r.outcome === 'unknown' || r.outcome === 'confirmed'; }
function copy(r: ReservationView): ReservationView { return { ...r, lifetime: { ...r.lifetime } }; }
function validRecord(value: unknown): value is ReservationView {
  if (!value || typeof value !== 'object') return false;
  const r = value as ReservationView;
  return typeof r.reservationId === 'string' && !!r.reservationId && typeof r.txDigest === 'string' && /^[a-f0-9]{64}$/.test(r.txDigest) && validInteger(r.lamports)
    && typeof r.messageBase64 === 'string' && createHash('sha256').update(Buffer.from(r.messageBase64, 'base64')).digest('hex') === r.txDigest
    && typeof r.profileId === 'string' && /^[a-f0-9]{64}$/.test(r.profileId) && !!r.lifetime && typeof r.lifetime.blockhash === 'string'
    && validInteger(r.lifetime.lastValidBlockHeight) && validInteger(r.lifetime.validatedSlot)
    && (r.signature === null || (typeof r.signature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(r.signature)))
    && ['unknown', 'confirmed', 'expired-proven-absent', 'never-broadcast'].includes(r.outcome) && validInteger(r.createdAt) && validInteger(r.updatedAt)
    && (r.outcome !== 'never-broadcast' || r.signature === null) && (!['confirmed', 'expired-proven-absent'].includes(r.outcome) || r.signature !== null);
}

/** Durable per-alias ledger. No timer expiry, caller settlement, or in-memory production mode. */
export class SpendLedger {
  readonly journalPath: string;
  readonly limitLamports: number;
  #fd: number;
  #lock: LedgerLock | undefined;
  #closed = false;
  #poisoned = false;
  #records = new Map<string, ReservationView>();
  #byDigest = new Map<string, string>();
  #hooks: SpendLedgerHooks;
  constructor(limitLamports: number, journalPath: string, options: SpendLedgerOptions = {}) {
    if (!validInteger(limitLamports)) throw new SignerError('E_LEDGER', 'invalid ledger limit');
    privateDirectory(dirname(journalPath));
    this.limitLamports = limitLamports;
    this.journalPath = journalPath;
    this.#hooks = options.hooks ?? {};
    this.#fd = -1;
    try {
      this.#lock = acquireLedgerLock(`${journalPath}.lock`, this.#hooks.beforeLockRecovery);
      this.#fd = openSync(journalPath, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      const stat = fstatSync(this.#fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
      syncDirectory(dirname(journalPath));
      const contents = readFileSync(this.#fd, 'utf8');
      if (contents && !contents.endsWith('\n')) throw new Error();
      for (const line of contents.split('\n')) {
        if (!line) continue;
        const entry = JSON.parse(line) as { v: number; record: unknown };
        if (entry.v !== 2 || !validRecord(entry.record)) throw new Error();
        const r = entry.record;
        const previous = this.#records.get(r.reservationId);
        const otherId = this.#byDigest.get(r.txDigest);
        if (otherId && otherId !== r.reservationId) throw new Error();
        if (previous) {
          const lateConfirmation = previous.outcome === 'expired-proven-absent' && r.outcome === 'confirmed';
          if (previous.txDigest !== r.txDigest || previous.lamports !== r.lamports || previous.messageBase64 !== r.messageBase64 || previous.profileId !== r.profileId || JSON.stringify(previous.lifetime) !== JSON.stringify(r.lifetime) || previous.createdAt !== r.createdAt || previous.updatedAt > r.updatedAt || (previous.signature !== null && previous.signature !== r.signature) || (previous.outcome !== 'unknown' && previous.outcome !== r.outcome && !lateConfirmation)) throw new Error();
        } else if (r.signature !== null || r.outcome !== 'unknown') throw new Error();
        this.#records.set(r.reservationId, r);
        this.#byDigest.set(r.txDigest, r.reservationId);
      }
      this.spent();
    } catch (error) {
      try { if (this.#fd >= 0) closeSync(this.#fd); }
      finally { this.#lock?.release(); }
      if (error instanceof SignerError && error.code === 'E_LEDGER') throw error;
      throw new SignerError('E_LEDGER', 'spend journal unreadable, incomplete or invalid; refusing to reset accounting');
    }
  }
  private persist(record: ReservationView): void {
    if (this.#closed || this.#poisoned) throw new SignerError('E_LEDGER', 'spend journal closed or uncertain; restart required');
    const line = JSON.stringify({ v: 2, record }) + '\n';
    try {
      this.#lock!.assertOwned();
      this.#hooks.beforeJournalWrite?.(line);
      const bytes = Buffer.from(line);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(this.#fd, bytes, offset, bytes.length - offset);
      fsyncSync(this.#fd);
    } catch { this.#poisoned = true; throw new SignerError('E_LEDGER', 'spend journal write failed; no signature may be returned'); }
    this.#records.set(record.reservationId, record);
    this.#byDigest.set(record.txDigest, record.reservationId);
  }
  find(txDigest: string): ReservationView | undefined { const id = this.#byDigest.get(txDigest); return id ? this.reservation(id) : undefined; }
  reservation(id: string): ReservationView | undefined { const r = this.#records.get(id); return r ? copy(r) : undefined; }
  reservations(): ReservationView[] { return [...this.#records.values()].map(copy); }
  reserve(input: ReservationInput): ReservationView {
    const existing = this.find(input.txDigest);
    if (existing) {
      if (existing.profileId !== input.profileId || existing.messageBase64 !== input.messageBase64 || existing.lamports !== input.lamports) throw new SignerError('E_LEDGER', 'reservation identity conflict');
      return existing;
    }
    const at = Date.now();
    const r: ReservationView = { ...input, lifetime: { ...input.lifetime }, reservationId: randomUUID(), signature: null, outcome: 'unknown', createdAt: at, updatedAt: at };
    if (!validRecord(r)) throw new SignerError('E_LEDGER', 'invalid reservation metadata');
    if (r.lamports > this.limitLamports - this.spent()) throw new SignerError('E_SPEND_CUMULATIVE', 'transaction exceeds cumulative spend cap');
    this.persist(r);
    return copy(r);
  }
  recordSignature(id: string, signature: string): ReservationView {
    const r = this.require(id);
    if (r.outcome !== 'unknown' || (r.signature !== null && r.signature !== signature)) throw new SignerError('E_LEDGER', 'reservation cannot accept signature');
    const next = { ...r, signature, updatedAt: Date.now() };
    if (!validRecord(next)) throw new SignerError('E_LEDGER', 'invalid signature metadata');
    this.persist(next);
    return copy(next);
  }
  /** Internal trusted reconciler only; never dispatched from a claimed outcome. */
  recordReconciliation(id: string, outcome: ReconciledOutcome): ReservationView {
    const r = this.require(id);
    const lateConfirmation = r.outcome === 'expired-proven-absent' && outcome === 'confirmed';
    if ((!lateConfirmation && r.outcome !== 'unknown') || outcome === 'unknown') return copy(r);
    const next = { ...r, outcome, updatedAt: Date.now() };
    if (!validRecord(next)) throw new SignerError('E_LEDGER', 'invalid reconciliation transition');
    this.persist(next);
    return copy(next);
  }
  private require(id: string): ReservationView { const r = this.#records.get(id); if (!r) throw new SignerError('E_UNKNOWN_RESERVATION', 'unknown reservation'); return r; }
  spent(): number {
    let total = 0;
    for (const r of this.#records.values()) if (charged(r)) { total += r.lamports; if (!Number.isSafeInteger(total)) throw new SignerError('E_LEDGER', 'ledger sum exceeds safe integer range'); }
    return total;
  }
  toJSON(): Record<string, unknown> { return { usedLamports: this.spent(), limitLamports: this.limitLamports, unknown: this.reservations().filter(r => r.outcome === 'unknown').length }; }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { closeSync(this.#fd); } finally { this.#lock?.release(); }
  }
}
