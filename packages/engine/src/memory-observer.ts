import { createHash } from 'node:crypto';
import type { EvaluateResult, Evaluator } from '@oms/contract';
import type { MemoryHistory } from './memory-history.ts';
import type { CaptureClosure, CaptureFailure } from '../../memory/src/capture.ts';

export interface MemoryObservation {
  itemId: string;
  failure: CaptureFailure;
  closure: CaptureClosure;
}

/** Host-only evaluator decorator. Never register observe as an agent tool. */
export function observeMemory(
  evaluator: Evaluator,
  options: {
    executionIdentity: string;
    observe: (event: MemoryObservation) => Promise<void>;
    onError?: () => void;
    history?: MemoryHistory;
  },
): Evaluator {
  const failures: MemoryHistory = options.history ?? new Map<string, CaptureFailure>();
  let pending = Promise.resolve();
  const record = async (itemId: string, result: EvaluateResult): Promise<void> => {
    if (!result.closed) {
      if (result.reason === 'failed' && result.itemId === itemId) {
        failures.set(itemId, {
          reason: 'failed', output: result.detail, reopenCount: result.reopenCount,
          failureDigest: createHash('sha256').update(result.detail).digest('hex'),
        });
      }
      return;
    }
    const failure = failures.get(itemId);
    if (!failure || result.itemId !== itemId || !result.evidence.passed || result.evidence.mode !== 'offline-snapshot') return;
    await options.observe({ itemId, failure: structuredClone(failure), closure: {
      closed: true, executionIdentity: options.executionIdentity,
      evidence: structuredClone(result.evidence),
    } });
    failures.delete(itemId);
  };
  return {
    read: () => evaluator.read(),
    reopen: itemId => evaluator.reopen(itemId),
    evaluate(itemId) {
      // Preserve observation order even if trusted callers evaluate concurrently.
      const next = pending.then(async () => {
        const result = await evaluator.evaluate(itemId);
        try { await record(itemId, result); }
        catch {
          // Memory is advisory: storage/model errors never change verification.
          try { options.onError?.(); } catch { /* Error reporting is advisory too. */ }
        }
        return result;
      });
      pending = next.then(() => {}, () => {});
      return next;
    },
  };
}
