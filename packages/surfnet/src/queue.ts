/**
 * One-writer queue for state-changing surfnet calls (eng-review finding 3:
 * a single writer per surfnet). Writes run strictly FIFO; reads never queue
 * and may interleave with writes.
 */
export interface StateQueue {
  /**
   * Serialize a state-changing operation. Jobs run in submission order and
   * one failure does not wedge the queue: the next job still runs.
   */
  enqueueWrite<T>(job: () => Promise<T>): Promise<T>;
  /** Number of jobs waiting (running job not counted). */
  pending(): number;
  /** Resolves when no job is running or waiting. */
  idle(): Promise<void>;
}

export function createStateQueue(): StateQueue {
  let tail: Promise<void> = Promise.resolve();
  let waiting = 0;

  return {
    enqueueWrite<T>(job: () => Promise<T>): Promise<T> {
      waiting++;
      const result = tail.then(job, job);
      // Keep the chain alive regardless of this job's outcome, but surface
      // the failure to the caller.
      tail = result.then(
        () => {
          waiting--;
        },
        () => {
          waiting--;
        },
      );
      return result;
    },
    pending() {
      return waiting;
    },
    async idle() {
      while (waiting > 0) {
        await tail;
      }
    },
  };
}

/**
 * Methods that only read surfnet state. Anything not listed here — including
 * every `surfnet_*` cheatcode not in this list — is treated as a write and
 * routed through the queue. Checked by `isReadMethod` in the manager.
 */
const READ_METHODS = new Set([
  // standard reads
  'getHealth',
  'getAccountInfo',
  'getAccountInfoAndContext',
  'getMultipleAccounts',
  'getBalance',
  'getBalanceAndContext',
  'getBlockHeight',
  'getBlockTime',
  'getLatestBlockhash',
  'getMinimumBalanceForRentExemption',
  'getProgramAccounts',
  'getSignatureStatuses',
  'getSlot',
  'getTransaction',
  'getVersion',
  'getGenesisHash',
  'getTokenAccountBalance',
  'getTokenAccountsByOwner',
  'getTokenLargestAccounts',
  'getTokenSupply',
  'getSupply',
  'getEpochInfo',
  'getFeeForMessage',
  'simulateTransaction',
  // cheatcode reads (surfnet_ prefix stripped in this list)
  'surfnet_getStreamedAccounts',
  'surfnet_getTransactionProfile',
  'surfnet_getProfileResultsByTag',
  'surfnet_getActiveIdl',
  'surfnet_getLocalSignatures',
  'surfnet_getSurfnetInfo',
  'surfnet_getConfidentialBalance',
]);

/**
 * Classify an RPC method for queue routing. Unknown `surfnet_*` methods are
 * treated as writes (fail safe: an unexpected read merely serializes).
 */
export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method);
}
