import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  type AgentSession,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';
import { createChatExtensions } from '../chat-extensions.ts';
import { defaultDeniedRoots } from '../../oms-extension.ts';
import { KNOWLEDGE_TOOL_NAMES } from '../knowledge-service.ts';
import type { SessionApiParts } from '../session-api.ts';
import { createSessionHooks } from '../session-hooks.ts';
import { readingExtensions } from '../session-tools.ts';
import { sessionToolNames } from '../session-model.ts';
import { harnessPolicySettings } from '../settings-controls.ts';
import { KEY_SAFETY, omsChatPrompt } from '../system-prompt.ts';
import { withToolExecutionModes } from '../tool-execution.ts';
import { createMeteredStream, modelReadiness } from '../usage.ts';
import type { AgentDefinition } from './agents.ts';
import type { Claim, ClaimTable } from './claims.ts';
import { usageOf } from './records.ts';

export const HELPER_LIMITS = { turns: 40, tokens: 300_000, ms: 10 * 60_000, report: 4000, input: 200_000 } as const;

/**
 * A request is admitted against the budget at its largest possible size, so a few at once can claim more than the turn's
 * allowance even though each is small. A request that does not fit waits for one in flight to end instead of failing.
 */
export class RequestGate {
  private inflight = 0;
  private waiting: Array<() => void> = [];

  async admit(
    ready: () => boolean,
    start: () => ReturnType<StreamFn>,
    signal: AbortSignal | undefined,
  ): Promise<AssistantMessageEventStream> {
    while (!signal?.aborted && this.inflight > 0 && !ready())
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal?.removeEventListener('abort', wake);
          resolve();
        };
        signal?.addEventListener('abort', wake, { once: true });
        this.waiting.push(wake);
      });
    const pending = start();
    this.inflight++;
    const ended = () => {
      this.inflight--;
      for (const wake of this.waiting.splice(0)) wake();
    };
    try {
      const stream = await pending;
      void stream.result().then(ended, ended);
      return stream;
    } catch (error) {
      ended();
      throw error;
    }
  }
}

/** A helper's context stays small, so its requests reserve far less than the model's whole window. */
export const helperInputCap = (configured: number | undefined, model: Model<Api>): number =>
  Math.min(configured ?? HELPER_LIMITS.input, HELPER_LIMITS.input, model.contextWindow);

/** Folders whose files change for reasons that are nobody's edit. */
const SKIPPED = new Set(['.git', 'node_modules', 'target', '.oms-cargo']);
const WALK_LIMIT = 20_000;

/** Files under `root` changed since `since`, as folder-relative paths. */
export function changedSince(root: string, since: number): string[] {
  const changed: string[] = [];
  let seen = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > WALK_LIMIT) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) walk(path);
      } else if (entry.isFile()) {
        try {
          if (statSync(path).mtimeMs >= since) changed.push(relative(root, path));
        } catch {
          // Gone again before it could be read.
        }
      }
    }
  };
  walk(root);
  return changed.sort();
}

export interface HelperRun {
  id: string;
  label: string;
  turnId: string;
  def: AgentDefinition;
  task: string;
  model: Model<Api>;
  claim?: Claim;
  claims: ClaimTable;
  gate: RequestGate;
  signal: AbortSignal;
  /** Called with the child session as soon as it exists, so a caller can show its conversation live. */
  attach(session: AgentSession): void;
}

export interface HelperOutcome {
  status: 'done' | 'failed' | 'cancelled';
  report: string;
  reason?: string;
  tokens: number;
  spendMicroUsd: number;
  outside: string[];
}

function claimGuard(folder: string, claim: Claim, claims: ClaimTable): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', (event) => {
      if (event.toolName !== 'edit' && event.toolName !== 'write') return undefined;
      const path = (event.input as { path?: unknown }).path;
      const relativePath = typeof path === 'string' ? relative(folder, resolve(folder, path)) : '..';
      if (!relativePath.startsWith('..') && claims.covers(claim, relativePath)) return undefined;
      return {
        block: true,
        reason: `blocked: ${typeof path === 'string' ? path : 'that path'} is outside the files you may change (${claim.patterns.join(', ')}). Say in your report that it needs a change.`,
      };
    });
  };
}

function helperPrompt(parts: SessionApiParts, def: AgentDefinition): string {
  const folder = parts.tools.taskRoot;
  const framing = `You are a helper of another agent. Do only the task you are given, in ${folder}, and answer with your report.`;
  if (def.tools === 'edit') {
    return omsChatPrompt(folder, parts.tools.toolchainSummary, `\n\n${framing}\n${def.instructions}`);
  }
  return [framing, def.instructions, KEY_SAFETY].join('\n\n');
}

/** Builds the helper's own pi session over the same sandbox, ledger and guards as the chat, runs the task, and tears it down. */
export async function runHelper(parts: SessionApiParts, run: HelperRun): Promise<HelperOutcome> {
  const { options, life, env, tools, model: chat } = parts;
  const { def } = run;
  const readOnly = def.tools === 'read';
  const folder = tools.taskRoot;
  const lane = tools.sandboxTools.helperTools({ label: run.label, readOnly });
  const hooks = createSessionHooks(options, life, env, tools);
  hooks.turn.id = run.turnId;
  const extensions: ExtensionFactory[] = createChatExtensions({
    guards: { approveHostCommands: tools.backend.approvesCommands },
    cwd: folder,
    trace: life.trace!,
    protectedPaths: env.protectedFiles.map((file) => join(folder, file)),
    extra: [
      lane.extension,
      hooks.policy,
      ...readingExtensions(env, tools),
      ...(run.claim ? [claimGuard(folder, run.claim, run.claims)] : []),
    ],
  });
  const known = tools.knowledgeSource() !== undefined;
  const toolNames = [
    ...sessionToolNames(false, options.outputMode, 'chat').filter(
      (name) => !(readOnly && (name === 'edit' || name === 'write')),
    ),
    ...(known ? KNOWLEDGE_TOOL_NAMES : []),
  ];
  const settingsManager = SettingsManager.inMemory(harnessPolicySettings());
  const resourceLoader = new DefaultResourceLoader({
    cwd: env.root.codeRoot,
    agentDir: env.root.agentRoot,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: [],
    extensionFactories: extensions.map(withToolExecutionModes),
    systemPrompt: helperPrompt(parts, def),
  });
  await resourceLoader.reload();
  const helperDir = join(env.root.stateDir, 'helpers', env.sessionId);
  const sessionManager = SessionManager.create(env.root.codeRoot, helperDir);
  const { session } = await createAgentSession({
    cwd: env.root.codeRoot,
    agentDir: env.root.agentRoot,
    modelRuntime: chat.modelRuntime,
    model: run.model,
    thinkingLevel: chat.session.thinkingLevel,
    settingsManager,
    sessionManager,
    resourceLoader,
    noTools: 'builtin',
    tools: toolNames,
  });
  run.attach(session);
  session.agent.toolExecution = 'parallel';
  const original: StreamFn = session.agent.streamFunction;
  const metered = createMeteredStream({
    streamFunction: original,
    ledger: env.budget,
    allocate: env.allocate,
    executionMode: env.executionMode,
    maxOutputTokens: options.maxOutputTokens,
    maxInputTokens: helperInputCap(options.maxInputTokens, run.model),
    subscriptionExempt: options.subscriptionSpendExempt,
    subscribed: (provider) => chat.modelRuntime.isUsingSubscription(provider),
    logicalTurnId: () => run.turnId,
    concurrent: true,
    onBareBadRequest: () => hooks.trim.forgetReasoning(),
  });
  session.agent.streamFunction = (model, context, streamOptions) => {
    const signal = life.executionController
      ? AbortSignal.any([life.executionController.signal, ...(streamOptions?.signal ? [streamOptions.signal] : [])])
      : streamOptions?.signal;
    const ready = () =>
      modelReadiness(
        model,
        env.budget,
        options.maxOutputTokens,
        env.executionMode,
        helperInputCap(options.maxInputTokens, run.model),
        options.subscriptionSpendExempt,
        chat.modelRuntime.isUsingSubscription(model.provider),
        true,
      ).ready;
    return run.gate.admit(ready, () => metered(model, context, { ...streamOptions, signal }), signal);
  };
  await session.bindExtensions({});

  const startedAt = Date.now();
  const stop = new AbortController();
  let limit: string | undefined;
  const halt = (why: string) => {
    if (limit) return;
    limit = why;
    stop.abort();
    void session.abort().catch(() => {});
  };
  const onAbort = () => {
    stop.abort();
    void session.abort().catch(() => {});
  };
  run.signal.addEventListener('abort', onAbort, { once: true });
  if (run.signal.aborted) onAbort();
  const timer = setTimeout(() => halt(`stopped after ${HELPER_LIMITS.ms / 60_000} minutes`), HELPER_LIMITS.ms);
  let turns = 0;
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== 'turn_end') return;
    turns++;
    if (turns >= HELPER_LIMITS.turns) halt(`stopped after ${HELPER_LIMITS.turns} turns`);
    else if (usageOf(env.budget, run.turnId).tokens >= HELPER_LIMITS.tokens)
      halt(`stopped after ${HELPER_LIMITS.tokens / 1000}k tokens`);
  });
  try {
    const note = run.claim ? `\n\nFiles you may change: ${run.claim.patterns.join(', ')}` : '';
    if (!stop.signal.aborted) await session.prompt(`${run.task}${note}`);
    const usage = usageOf(env.budget, run.turnId);
    const last = [...session.messages].reverse().find((message) => message.role === 'assistant') as
      { stopReason?: string; errorMessage?: string } | undefined;
    const report = (session.getLastAssistantText() ?? '').trim().slice(0, HELPER_LIMITS.report);
    const outside = outsideClaim(folder, startedAt, run);
    if (limit) return { status: 'failed', report, reason: limit, ...usage, outside };
    if (run.signal.aborted || last?.stopReason === 'aborted') return { status: 'cancelled', report, ...usage, outside };
    if (last?.stopReason === 'error')
      return { status: 'failed', report, reason: last.errorMessage ?? 'the model request failed', ...usage, outside };
    return { status: 'done', report: report || '(no report)', ...usage, outside };
  } finally {
    clearTimeout(timer);
    unsubscribe();
    run.signal.removeEventListener('abort', onAbort);
    lane.close();
    session.dispose();
  }
}

/** Files that changed during the run and belong to nobody who was running: bash wrote them, or a read-only agent wrote at all. */
function outsideClaim(folder: string, since: number, run: HelperRun): string[] {
  return changedSince(folder, since - 10).filter(
    (path) => !(run.claim && run.claims.covers(run.claim, path)) && !run.claims.coveredByOthers(run.claim, path, since),
  );
}
