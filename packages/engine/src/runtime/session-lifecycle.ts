import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { TraceWriter } from '@oms/core';
import type { Surfnet } from '@oms/surfnet';
import type { MutationLease } from '../workspace/index.ts';
import type { ClaudeCodeSession } from './claude-code.ts';
import type { RuntimeProcessTracker } from './recovery.ts';
import type { SandboxTools } from './sandbox-tools.ts';
import type { BudgetJournal } from './usage.ts';
import type { VerifierBackend } from './verifier-backend.ts';

/**
 * What one live task session owns and must release, in one place. Each startup stage registers its resources here as it
 * creates them, so a failure at any point releases exactly what exists so far, and `releaseResources` is the only code
 * that knows the order they are torn down in.
 */
export interface SessionLifecycle {
  readonly lease: MutationLease;
  /** Aborted when the session closes or its task wall-clock budget runs out. */
  readonly controller: AbortController;
  processes?: RuntimeProcessTracker;
  backend?: VerifierBackend;
  surf?: Surfnet;
  budgetJournal?: BudgetJournal;
  trace?: TraceWriter;
  /** Runs after the journal and trace are closed; a chat uses it to drop the files of a window that never sent anything. */
  discardUnused?: () => void;
  taskTools?: SandboxTools;
  nativeSession?: ClaudeCodeSession;
  /** A chat's helpers: they stop before the chat's own session does. */
  helpers?: { abortAll(): Promise<void> };
  liveSession?: AgentSession;
  /** The current execution window of an interactive session; undefined between operations. */
  executionController?: AbortController;
  /** The task wall-clock timer of a bounded session. */
  deadline?: NodeJS.Timeout;
  /** Runs one user-initiated action at a time, and never while the model is streaming. */
  withUserOperation<T>(action: () => Promise<T>): Promise<T>;
  releaseResources(): Promise<void>;
}

export function createSessionLifecycle(lease: MutationLease, controller: AbortController): SessionLifecycle {
  let cleanup: Promise<void> | undefined;
  let userOperation: Promise<unknown> | undefined;
  const life: SessionLifecycle = {
    lease,
    controller,
    async withUserOperation<T>(action: () => Promise<T>): Promise<T> {
      controller.signal.throwIfAborted();
      if (userOperation || life.liveSession?.isStreaming) throw new Error('Wait for the current task action to finish');
      const pending = action();
      userOperation = pending;
      try {
        return await pending;
      } finally {
        userOperation = undefined;
      }
    },
    releaseResources(): Promise<void> {
      if (cleanup) return cleanup;
      cleanup = (async () => {
        clearTimeout(life.deadline);
        controller.abort();
        life.executionController?.abort();
        const outcomes = await Promise.allSettled([
          life.helpers?.abortAll(),
          life.liveSession?.abort(),
          life.nativeSession?.close(),
          life.taskTools?.dispose(),
          life.backend?.dispose(),
          life.surf?.stop(),
        ]);
        // User failures still reach their callers; finish their state writes before releasing ownership.
        if (userOperation) await Promise.allSettled([userOperation]);
        const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
        const closedTrace = life.trace?.close();
        if (closedTrace && !closedTrace.ok)
          failures.push({ status: 'rejected', reason: new Error(closedTrace.message) });
        try {
          life.budgetJournal?.close();
        } catch (reason) {
          failures.push({ status: 'rejected', reason });
        }
        if (!failures.length) {
          try {
            life.discardUnused?.();
          } catch (reason) {
            failures.push({ status: 'rejected', reason });
          }
        }
        if (!failures.length) {
          try {
            life.processes?.clear();
          } catch (reason) {
            failures.push({ status: 'rejected', reason });
          }
        }
        if (!failures.length) lease.release();
        if (failures.length)
          throw new AggregateError(
            failures.map((failure) => failure.reason),
            'Harness cleanup is uncertain; task ownership retained for recovery',
          );
      })();
      return cleanup;
    },
  };
  return life;
}
