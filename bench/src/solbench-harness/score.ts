/**
 * solbench-harness scoring (our reimplementation of the published rule): the unique (program id, first instruction-data byte)
 * pairs across the top-level instructions of successfully executed transactions. Instructions with empty data have no first byte.
 */
import type { Instruction } from './wire.ts';

/** Never counted anywhere but the raw total: any data is a valid memo. */
export const MEMO_PROGRAMS = ['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'] as const;

/** Programs that succeed on any instruction data, so every first byte is a free pair. Reported apart from the headline. */
export const ARBITRARY_DATA_PROGRAMS: ReadonlyArray<{ id: string; reason: string }> = [
  { id: 'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV', reason: 'SPL Noop: its entrypoint returns Ok for any input; account compression uses it to log data.' },
  { id: 'mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3', reason: 'Metaplex Noop (mpl-noop): the same no-op logging entrypoint, used by Bubblegum.' },
];
// Also apart from the headline: programs deployed by the run itself, which can be written to accept any data (scoreRun's `deployed`).

/** Precompiles check signatures and treat data[0] as a count, so many first bytes succeed. Reported as a second number next to the headline. */
const PRECOMPILE_PROGRAMS = ['KeccakSecp256k11111111111111111111111111111', 'Ed25519SigVerify111111111111111111111111111', 'Secp256r1SigVerify1111111111111111111111111'] as const;

/** Headline pairs (`program:byte`) not from a precompile. */
export const withoutPrecompiles = (pairs: readonly string[]) => pairs.filter(pair => !(PRECOMPILE_PROGRAMS as readonly string[]).includes(pair.slice(0, pair.lastIndexOf(':'))));

export interface Submission { ok: boolean; instructions: Instruction[] }

export interface Score {
  /** Filtered pairs: no Memo, no arbitrary-data program, no program the run deployed. */
  headline: number;
  raw: number;
  arbitrary: number;
  memo: number;
  /** Distinct programs among the headline pairs. */
  programs: number;
  failed: number;
  submissions: number;
  /** Headline pairs as `program:byte`, sorted. */
  pairs: string[];
}

type Kind = 'headline' | 'memo' | 'arbitrary';

function pairKind(programId: string, deployed: ReadonlySet<string>): Kind {
  if ((MEMO_PROGRAMS as readonly string[]).includes(programId)) return 'memo';
  return deployed.has(programId) || ARBITRARY_DATA_PROGRAMS.some(p => p.id === programId) ? 'arbitrary' : 'headline';
}

export function scoreRun(submissions: readonly Submission[], deployed: ReadonlySet<string> = new Set()): Score {
  const pairs = new Map<string, Kind>();
  for (const s of submissions) {
    if (!s.ok) continue;
    for (const i of s.instructions) if (i.data.length) pairs.set(`${i.programId}:${i.data[0]}`, pairKind(i.programId, deployed));
  }
  const of = (kind: Kind) => [...pairs].filter(([, k]) => k === kind).map(([pair]) => pair).sort();
  const headline = of('headline');
  return { headline: headline.length, raw: pairs.size, arbitrary: of('arbitrary').length, memo: of('memo').length,
    programs: new Set(headline.map(pair => pair.slice(0, pair.lastIndexOf(':')))).size,
    failed: submissions.filter(s => !s.ok).length, submissions: submissions.length, pairs: headline };
}
