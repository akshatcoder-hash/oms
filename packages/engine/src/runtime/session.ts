import { dirname, join } from 'node:path';
import { acquireTaskLease } from '../workspace/index.ts';
import { privateDirectory } from '../workspace/storage.ts';
import { createOmsAccountControls } from './oms-account.ts';
import { createSessionApi } from './session-api.ts';
import { startTaskEnvironment } from './session-environment.ts';
import { createSessionHooks } from './session-hooks.ts';
import { createSessionLifecycle } from './session-lifecycle.ts';
import { createSessionModel } from './session-model.ts';
import { createSessionExtensions, createSessionTools } from './session-tools.ts';
import type { HarnessSession, HarnessSessionOptions } from './session-types.ts';

export { sessionToolNames } from './session-model.ts';
export type {
  HarnessEnvironment,
  HarnessSession,
  HarnessSessionOptions,
  HarnessTaskDefinition,
  HarnessVerification,
} from './session-types.ts';
export { parseHarnessTaskDefinition, prepareHarnessTask } from './task-definition.ts';
export { knowledgeHint, omsSystemPrompt } from './system-prompt.ts';

/**
 * One live task owner. UI views consume it; replacing a view never replaces this runtime.
 *
 * Startup is a fixed sequence of stages, each in its own module, and each registers what it creates on the lifecycle so a
 * failure at any point releases exactly what exists: the task environment (ownership, pin, verifier, budget, local chain),
 * the agent account, the tools, the prompt and context hooks, the extensions, the model and stream wiring, and the API.
 */
export async function createHarnessSession(options: HarnessSessionOptions): Promise<HarnessSession> {
  const { workspace, task } = options;
  const lease = acquireTaskLease(workspace, task.id);
  const life = createSessionLifecycle(lease, new AbortController());
  try {
    const env = await startTaskEnvironment(options, life);
    const agentRoot = join(dirname(dirname(workspace.stateDir)), 'agent');
    privateDirectory(agentRoot);
    const account = createOmsAccountControls({
      agentRoot,
      signal: life.controller.signal,
      withUserOperation: life.withUserOperation,
    });
    const tools = createSessionTools(options, life, env, account);
    const hooks = createSessionHooks(options, life, env, tools);
    // Whether a knowledge credential exists at start: it decides the prompt and which tools are declared to the model.
    const initiallyKnown = tools.knowledgeSource() !== undefined;
    const extensions = createSessionExtensions(options, life, env, tools, hooks, initiallyKnown);
    const model = await createSessionModel(options, life, env, tools, hooks, extensions, agentRoot, initiallyKnown);
    return createSessionApi({ options, life, env, tools, model, account, agentRoot });
  } catch (error) {
    life.liveSession?.dispose();
    try {
      await life.releaseResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Harness startup and cleanup failed');
    }
    throw error;
  }
}
