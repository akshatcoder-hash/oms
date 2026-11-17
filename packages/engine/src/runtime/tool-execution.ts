import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { AGENT_TOOL } from './helpers/agents.ts';
import { KNOWLEDGE_TOOL_NAMES } from './knowledge-service.ts';
import { PROGRAM_REFERENCE_TOOL } from './program-reference.ts';

/** Tools that only read, or that keep their own work apart (helpers), so a turn's calls to them may overlap. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'task_status',
  'toolchain_check',
  AGENT_TOOL,
  PROGRAM_REFERENCE_TOOL,
  ...KNOWLEDGE_TOOL_NAMES,
]);

/**
 * pi runs a turn's tool calls together unless any tool in the batch is sequential. Every tool an extension
 * registers is sequential except the read-only ones, so a tool added later is safe until it is listed above.
 */
export function withToolExecutionModes(factory: ExtensionFactory): ExtensionFactory {
  return (pi) =>
    factory(
      Object.create(pi, {
        registerTool: {
          value: (tool: Parameters<typeof pi.registerTool>[0]) =>
            pi.registerTool({ ...tool, executionMode: READ_ONLY_TOOLS.has(tool.name) ? 'parallel' : 'sequential' }),
        },
      }),
    );
}
