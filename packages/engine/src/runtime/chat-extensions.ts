import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { createDeepRedactor, type TraceWriter } from '@oms/core';
import { createGuardsExtension, type GuardsConfig } from '../guards.ts';
import { defaultDeniedRoots } from '../oms-extension.ts';
import { createTraceExtension } from '../trace-extension.ts';

/** The pi extensions of a folder chat: the guards and the trace, without a proposal tool or a settle gate. */
export function createChatExtensions(options: {
  guards: Pick<GuardsConfig, 'approveHostCommands'>;
  cwd: string;
  trace: TraceWriter;
  protectedPaths: readonly string[];
  extra: readonly ExtensionFactory[];
}): ExtensionFactory[] {
  return [
    createGuardsExtension({
      protectedPaths: options.protectedPaths,
      deniedRoots: defaultDeniedRoots(),
      cwd: options.cwd,
      ...options.guards,
    }),
    createTraceExtension({ writer: options.trace, redact: createDeepRedactor([]), redactModelView: true }),
    ...options.extra,
  ];
}
