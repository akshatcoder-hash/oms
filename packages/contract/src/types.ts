/**
 * The task contract shape and the evaluator config that is pinned with it.
 *
 * `version: 0` is strict: unknown fields are rejected, so a contract cannot
 * smuggle in a field that a newer reader would honour.
 */

import type { Evidence } from './evidence.ts';

export type Condition =
  | { kind: 'tests'; command: string[]; expect: 'pass' }
  | {
      kind: 'account';
      address: string;
      field: 'lamports' | 'owner' | 'dataLen' | 'tokenAmount';
      equals: string;
    }
  | { kind: 'tx'; description: string };

/**
 * `active` is the one item being worked on, `proposed` means the generator
 * claims it is done and is waiting on the evaluator, `blocked` means the
 * reopen cap was hit and a human has to look at it.
 */
export type ItemStatus = 'open' | 'active' | 'proposed' | 'closed' | 'blocked';

export interface ContractItem {
  id: string;
  title: string;
  done: Condition[];
  status: ItemStatus;
  reopenCount: number;
  /** Present only on `closed` items; written by the evaluator, never the generator. */
  evidence?: Evidence;
}

export interface TaskContract {
  version: 0;
  template?: string;
  items: ContractItem[];
}

/**
 * Evaluator configuration, digest-pinned alongside the contract and verifier.
 * codePaths are required entry points, not an allowlist: the complete codeRoot
 * membership (except Git control data) is part of the proof identity.
 */
export interface EvaluatorConfig {
  schema: 'oms.evaluator/0';
  snapshotDigest: string;
  codePaths: string[];
  snapshotPath?: string;
  verifierLabel?: string;
  /** Command timeout; omitted means 120000 ms. Included in requirement identity. */
  testTimeoutMs?: number;
  /** Trusted adapter/image/binary identity, included in every requirement digest. */
  executionIdentity: string;
}
