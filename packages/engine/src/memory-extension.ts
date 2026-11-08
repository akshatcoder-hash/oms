import { applicability } from '../../memory/src/applicability.ts';
import { captureAndStore } from '../../memory/src/capture-store.ts';
import type { MemoryObservation } from './memory-observer.ts';

export interface LocalMemoryCaptureOptions {
  home: string;
  /** Trusted checkout matching the verified candidate, not a model-supplied path. */
  workspace: string;
  /** Candidate worktree lockfiles; defaults to workspace for standalone callers. */
  candidateRoot?: string;
  installSalt: string;
  vocabulary: ReadonlySet<string>;
  secretForms: readonly string[];
  runtime: Parameters<typeof applicability>[1];
}

/** Template-only local capture. No model call, upload, or task-contract writer. */
export function createMemoryCapture(options: LocalMemoryCaptureOptions): (event: MemoryObservation) => Promise<void> {
  // Freeze mutable host configuration for the duration of this session.
  const config = { ...options, runtime: { ...options.runtime },
    vocabulary: new Set(options.vocabulary), secretForms: [...options.secretForms] };
  return async event => {
    await captureAndStore({ home: config.home, workspace: config.workspace }, {
      failure: event.failure, closure: event.closure,
      applicability: applicability(config.candidateRoot ?? config.workspace, config.runtime),
      diff: '', installSalt: config.installSalt, vocabulary: config.vocabulary,
      secretForms: config.secretForms
    });
  };
}
