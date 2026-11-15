import type { AgentSession, AgentSessionRuntime, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { EvaluateResult, Evaluator, TaskContract } from '@oms/contract';
import type { BudgetCaps, BudgetLedger, ExecutionMode } from '@oms/core';
import type { SandboxResult } from '@oms/sandbox';
import type { Task, Workspace } from '../workspace/index.ts';
import type { ChainControls } from './chain.ts';
import type { NativeChatControls } from './claude-code.ts';
import type { EdgeCheckSummary } from './edge-check.ts';
import type { HostApproval, HostApprovalPolicy } from './host-approval.ts';
import type { KnowledgeConfig } from './knowledge-service.ts';
import type { OmsAccountControls } from './oms-account.ts';
import type { ProviderControls } from './provider-controls.ts';
import type { HarnessSettingsControls } from './settings-controls.ts';
import type { TaskFileAccess } from './task-files.ts';
import type { TaskTerminal } from './task-terminal.ts';
import type { WebConfig, WebUsage } from './web.ts';

export interface HarnessEnvironment {
  backend?: 'host' | 'docker';
  binary: string;
  image: string;
  forwarderImage: string;
  buildProfile?: boolean;
  /** Trusted lockfile checkout; never discovered from contender workspaces. */
  dependencies?: string;
}
export interface HarnessTaskDefinition {
  contract: TaskContract;
  verifierPaths: string[];
  codePaths: string[];
  snapshotPath?: string;
  testTimeoutMs?: number;
}
export interface HarnessSessionOptions {
  workspace: Workspace;
  task: Task;
  environment: HarnessEnvironment;
  hostApprovalPolicy?: HostApprovalPolicy;
  caps: BudgetCaps;
  maxOutputTokens: number;
  /** Trusted text-only local transport bound; omitted in normal sessions. */
  maxInputTokens?: number;
  /** Benchmark runner only: bounded ChatGPT-subscription calls are not held to the API-dollar cap (they cost no API credit). */
  subscriptionSpendExempt?: boolean;
  executionMode?: ExecutionMode;
  /** Opt-in model/user command previews and session-scoped read_log; never verifier output. */
  outputMode?: 'head-tail';
  /** Trusted clock injection for deterministic execution-window tests. */
  clock?: () => number;
  sessionId?: string;
  /** Trusted host/test injection, never repository-discovered executable code. */
  modelRuntime?: ModelRuntime;
  model?: Model<Api>;
  modelSelection?: { provider: string; id: string };
  /** Trusted host configuration for the Solana knowledge service, for the benchmark harness. Absent: the session uses
   * OMS_KNOWLEDGE_URL plus OMS_KNOWLEDGE_TOKEN when both are set, else the signed-in OMS account, else the tools are hidden. */
  knowledge?: KnowledgeConfig;
  /** The look-it-up nudge in the system prompt. Defaults on whenever a knowledge credential exists; false turns it off. */
  knowledgeHint?: boolean;
  /** The search_docs rule and the top task-matched doc snippets in the first user turn (headless). Defaults on whenever a knowledge credential exists. */
  knowledgeInject?: boolean;
  /** Web access (web_search, web_fetch, Solana MCP), host-side. Absent means the tools do not exist: the bench never sets it. */
  web?: WebConfig;
  /** Stop the run at a successful propose_done: the verifier answers next, with no closing model reply (headless). */
  endRunOnProposal?: boolean;
  /** Hold the first propose_done on a program change for a bounded edge-case pass (A3). Off by default. */
  edgeCheck?: boolean;
}
export interface HarnessVerification {
  itemId: string;
  result: EvaluateResult;
}
export interface HarnessSession extends ProviderControls {
  nativeChat?: NativeChatControls;
  workspace: Workspace;
  task: Task;
  runtime: AgentSessionRuntime;
  session: AgentSession;
  evaluator: Evaluator;
  budget: BudgetLedger;
  settings: HarnessSettingsControls;
  account: OmsAccountControls;
  verify(itemId?: string): Promise<HarnessVerification>;
  runCommand(command: string, signal?: AbortSignal): Promise<SandboxResult>;
  files: TaskFileAccess;
  startTerminal(columns: number, rows: number): Promise<TaskTerminal>;
  setHostApproval?(approve: HostApproval | undefined): void;
  /** Present only when the session was opened with `web`; `set` is the `/web on|off` switch. */
  web?: { enabled(): boolean; set(on: boolean): void; usage(): WebUsage };
  /** The task's local Surfpool, for chain commands (never another network). */
  chain?: ChainControls;
  /** decode_error text for a program error code; throws when no knowledge credential exists. */
  knowledge: {
    decodeError(code: string, program?: string, signal?: AbortSignal): Promise<string>;
    /** The credential the knowledge tools use right now, read on each call. */
    config(): KnowledgeConfig | undefined;
  };
  /** Present only when the session was opened with `edgeCheck`. */
  edgeCheck?: { summary(): EdgeCheckSummary };
  close(): Promise<void>;
}
