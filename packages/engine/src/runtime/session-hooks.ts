import { randomUUID } from 'node:crypto';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { KnowledgeConfig } from './knowledge-service.ts';
import { createContextTrimmer } from './context-trim.ts';
import type { SessionLifecycle } from './session-lifecycle.ts';
import type { TaskEnvironment } from './session-environment.ts';
import type { SessionTools } from './session-tools.ts';
import type { HarnessSessionOptions } from './session-types.ts';
import { knowledgeHint, omsSystemPrompt, WEB_PROMPT, WEB_PROMPT_NO_KNOWLEDGE } from './system-prompt.ts';
import { elideOldFetches } from './web.ts';

/** The prompt text and the per-turn context hooks of one session. */
export interface SessionHooks {
  /** The id shared by every model call of one user request; budget accounting groups calls by it. */
  turn: { id: string };
  /** Keeps what is sent to the model inside the context window; the session transcript keeps everything. */
  trim: ReturnType<typeof createContextTrimmer>;
  /** The system prompt for each state of the knowledge credential; the turn start picks the one that matches. */
  promptFor(config: KnowledgeConfig | undefined): string;
  /** The extension that applies the prompt and context hooks, blocks session surgery and registers the status tools. */
  policy: ExtensionFactory;
}

export function createSessionHooks(
  options: HarnessSessionOptions,
  life: SessionLifecycle,
  env: TaskEnvironment,
  tools: SessionTools,
): SessionHooks {
  const { taskRoot, web } = tools;
  const turn = { id: randomUUID() };
  const trim = createContextTrimmer(() => options.maxInputTokens ?? life.liveSession?.model?.contextWindow);
  const promptFor = (config: KnowledgeConfig | undefined) =>
    omsSystemPrompt(
      taskRoot,
      tools.toolchainSummary,
      `${knowledgeHint(options, config)}${web ? (config ? WEB_PROMPT : WEB_PROMPT_NO_KNOWLEDGE) : ''}`,
    );
  const policy: ExtensionFactory = (pi) => {
    pi.on('before_agent_start', (event) => {
      event.systemPromptOptions.cwd = taskRoot;
      if (env.executionMode === 'bounded' && event.messageType === 'user') turn.id = randomUUID();
    });
    pi.on('context', (event) => {
      const fetched = web ? elideOldFetches(event.messages) : event.messages;
      const messages = trim(fetched);
      return messages === event.messages ? undefined : { messages };
    });
    pi.on('cache_warming_decision', () => ({ action: 'stop' }));
    pi.on('session_before_compact', () => ({ cancel: true }));
    pi.on('session_before_tree', () => ({ cancel: true }));
    pi.on('session_before_fork', () => ({ cancel: true }));
    pi.on('session_before_switch', (_event, ctx) => {
      ctx.ui.notify(
        'Use the OMS launcher to select/resume a task session; this preview keeps its task owner fixed.',
        'warning',
      );
      return { cancel: true };
    });
    pi.registerTool({
      name: 'toolchain_check',
      label: 'Toolchain check',
      description:
        'Read-only sourced compatibility report for the selected task. Findings are untrusted project data; a clean report is not build verification.',
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: 'text', text: JSON.stringify(tools.toolchainReadiness(), null, 2) }],
          details: undefined,
        };
      },
    });
    pi.registerTool({
      name: 'task_status',
      label: 'Task status',
      description:
        'Read the current trusted task requirements, item states and offline verification evidence. This tool cannot change requirements or close an item.',
      parameters: Type.Object({}),
      async execute() {
        const state = env.evaluator.read();
        if (!state.ok) throw new Error('Task state is unreadable; verification is blocked');
        return { content: [{ type: 'text', text: JSON.stringify(state.value, null, 2) }], details: undefined };
      },
    });
  };
  return { turn, trim, promptFor, policy };
}
