import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createEvaluator, createProposer, createVerifierCache, parseEvaluatorConfig, verifyPin,
  type Evaluator, type EvaluatorConfig, type Proposer,
} from "@oms/contract";
import { createTraceWriter, type BudgetLedger, type ExecutionMode } from "@oms/core";
import { createDispatchAllocator } from "@oms/core/dispatch";
import { buildMounts, hostSandbox, type MountPlan } from "@oms/sandbox";
import { createSurfnet } from "@oms/surfnet";
import { createVerifierRunner } from "../verifier.ts";
import { inspectMutationLease } from "../workspace/index.ts";
import { privateDirectory, writePrivateJson } from "../workspace/storage.ts";
import { trackRuntimeProcesses } from "./recovery.ts";
import type { SessionLifecycle } from "./session-lifecycle.ts";
import type { HarnessSessionOptions } from "./session-types.ts";
import { verifierBackendOptions } from "./task-definition.ts";
import { taskContext, type TaskContext } from "./task-context.ts";
import { openBudgetJournal } from "./usage.ts";
import { createVerifierBackend, trustedSurfpoolMounts } from "./verifier-backend.ts";

/** What the rest of startup needs from the task: its trusted state, budget, verifier, local chain and sandbox mounts. */
export interface TaskEnvironment {
  context: TaskContext;
  config: EvaluatorConfig;
  /** Paths of the pinned verifier files, relative to the task root. */
  verifierFiles: string[];
  taskSessions: string;
  manager: SessionManager;
  sessionId: string;
  executionMode: ExecutionMode;
  budget: BudgetLedger;
  /** Runs one execution window: a plain pass-through when bounded, a budgeted and timed operation when interactive. */
  withExecution<T>(operationId: string, action: (signal: AbortSignal) => Promise<T>): Promise<T>;
  allocate: ReturnType<typeof createDispatchAllocator>;
  evaluator: Evaluator;
  /** The evaluator without the sandbox gate, for callers that already hold the verification slot. */
  baseEvaluator: Evaluator;
  proposer: Proposer;
  surfnetPort: number;
  /** source_fetch's folder, outside the task root so neither the proof digest nor the verifier's staged copy sees it. */
  sourcesDir: string;
  mounts: MountPlan;
}

const MAX_TIMER_MS = 2_147_483_647;

const HOST_WARNING = {
  seatbelt: "OMS host mode runs commands under macOS Seatbelt: writes stay in the worktree and temp, ~/.ssh, ~/.config/solana, keypairs and other repos are unreadable, and network is limited to the Surfnet port. Seatbelt is not a VM; use --sandbox docker for untrusted repositories.\n",
  none: "OMS host mode has NO sandbox here (Linux in v0.1, or macOS without sandbox-exec). Commands can access your host files and unrestricted network. Environment scrubbing, approvals and file-tool protections reduce accidents; they do not isolate code. Use --sandbox docker for untrusted repositories.\n",
};

/** Tells the user once per workspace what host mode does and does not isolate. */
function warnAboutHostMode(options: HarnessSessionOptions): void {
  const { workspace, environment } = options;
  if (environment.backend !== "host") return;
  const warningFile = join(workspace.stateDir, `host-warning-${hostSandbox()}.json`);
  if (existsSync(warningFile)) return;
  process.stderr.write(hostSandbox() === "seatbelt" ? HOST_WARNING.seatbelt : HOST_WARNING.none);
  writePrivateJson(warningFile, { acknowledgedAt: new Date().toISOString() });
}

/** Opens or resumes the pi conversation file for this task. */
function openSessionManager(options: HarnessSessionOptions, taskSessions: string): SessionManager {
  const { task } = options;
  if (options.sessionId === undefined) return SessionManager.create(task.codeRoot, taskSessions);
  if (!/^[a-f0-9-]{36}$/.test(options.sessionId)) throw new Error("Session ID is invalid");
  const file = SessionManager.findById(task.codeRoot, options.sessionId, taskSessions);
  if (!file) throw new Error("Session does not belong to this task");
  const manager = SessionManager.open(file, taskSessions);
  if (manager.getCwd() !== task.codeRoot) throw new Error("Saved session targets a different task");
  return manager;
}

/**
 * Environment and task setup, in startup order: ownership checks, the pinned requirements, the verifier backend, the saved
 * conversation and its budget journal, the trace, the evaluator, the task's own Surfpool and the sandbox mounts. Every
 * resource is registered on `life` the moment it exists.
 */
export async function startTaskEnvironment(options: HarnessSessionOptions, life: SessionLifecycle): Promise<TaskEnvironment> {
  const { workspace, task, environment } = options;
  const { controller, lease } = life;
  const clock = options.clock ?? Date.now;
  const executionMode = options.executionMode ?? "bounded";
  warnAboutHostMode(options);
  const context = taskContext(workspace, task);
  const ownership = inspectMutationLease(task.leaseFile);
  if (ownership.status !== "live" || ownership.owner.token !== lease.token) throw new Error("Task ownership changed before runtime startup");
  const host = environment.backend === "host";
  const processes = life.processes = trackRuntimeProcesses(task.leaseFile, ownership.owner, context.workDir,
    [...(host ? [task.codeRoot] : []), join(workspace.stateDir, "sessions", task.id)], host);
  writePrivateJson(join(context.stateDir, "runtime-backend.json"), { backend: environment.backend ?? "docker" });
  const pinned = verifyPin(task.pinFile, context.roots);
  if (!pinned.ok) throw new Error("Task requirements or verifier inputs do not match their pin");
  const parsedConfig = parseEvaluatorConfig(pinned.pin.evaluatorConfig);
  if (!parsedConfig.ok) throw new Error("Pinned evaluator configuration is invalid");
  const config = parsedConfig.value;
  const backend = life.backend = await createVerifierBackend({ ...verifierBackendOptions(environment, task, context),
    signal: controller.signal, operationSignal: () => life.executionController?.signal, onSpawn: processes.onSpawn });
  if (backend.executionIdentity !== config.executionIdentity) {
    throw new Error("The approved runtime identity differs from this task's pinned runtime");
  }
  const sessionsRoot = join(workspace.stateDir, "sessions");
  privateDirectory(sessionsRoot);
  const taskSessions = join(sessionsRoot, task.id);
  privateDirectory(taskSessions);
  const manager = openSessionManager(options, taskSessions);
  const sessionId = manager.getSessionId();
  const budgetJournal = life.budgetJournal = openBudgetJournal({ path: join(taskSessions, `${sessionId}.budget.jsonl`), caps: options.caps, clock, executionMode });
  const budget = budgetJournal.ledger;
  const restoredBudget = budget.snapshot();
  if (restoredBudget.accounting !== "known") throw new Error("Saved usage is pending or unknown; reconcile it before resuming this conversation");
  if (restoredBudget.activeOperationId) {
    const ended = budget.endOperation(restoredBudget.activeOperationId);
    if (!ended.ok) throw new Error(ended.message);
  }
  const modeChange = budget.setExecutionMode(executionMode);
  if (!modeChange.ok) throw new Error(modeChange.message);
  const withExecution = async <T>(operationId: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (executionMode === "bounded") return action(controller.signal);
    if (life.executionController) throw new Error("Wait for the current execution to finish");
    const started = budget.beginOperation(operationId);
    if (!started.ok) throw new Error(started.message);
    const operation = new AbortController();
    life.executionController = operation;
    const signal = AbortSignal.any([controller.signal, operation.signal]);
    let timer: NodeJS.Timeout | undefined;
    const expire = () => {
      const remaining = budget.snapshot().remaining.wallClockMs;
      if (remaining > 0) {
        timer = setTimeout(expire, Math.min(remaining, MAX_TIMER_MS));
        return;
      }
      operation.abort(new Error("Execution wall-clock limit exhausted"));
      void life.liveSession?.abort().catch(() => {});
    };
    expire();
    try {
      signal.throwIfAborted();
      return await action(signal);
    } finally {
      clearTimeout(timer);
      life.executionController = undefined;
      const ended = budget.endOperation(operationId);
      if (!ended.ok) throw new Error(ended.message);
    }
  };
  const allocate = createDispatchAllocator(budget.reservations());
  const trace = life.trace = createTraceWriter({ path: join(taskSessions, `${sessionId}.trace.jsonl`), clock: Date.now, fsync: true });
  const probe = trace.append({ type: "budget", accounting: budget.snapshot().accounting, sessionId });
  if (!probe.ok) throw new Error("Session trace cannot be opened safely; operator recovery required");
  const runner = createVerifierRunner(backend);
  const baseEvaluator = createEvaluator({ ...context.roots, pinFile: task.pinFile, runner,
    cache: createVerifierCache({ path: join(context.stateDir, "verifier-cache.json"), projectRoot: workspace.root }) });
  const evaluator: Evaluator = { ...baseEvaluator,
    evaluate: itemId => {
      if (!life.taskTools) return Promise.reject(new Error("Task sandbox is not ready"));
      return life.taskTools.withVerification(async () => { await backend.assertIntegrity(); return baseEvaluator.evaluate(itemId); });
    },
  };
  const baseProposer = createProposer({ ...context.roots, pinFile: task.pinFile });
  const proposer = { ...baseProposer,
    propose(itemId: string) {
      if (!life.taskTools) throw new Error("Task sandbox is not ready");
      life.taskTools.assertVerificationAllowed();
      return baseProposer.propose(itemId);
    },
  };
  const surf = life.surf = createSurfnet({ binary: environment.binary,
    ...(config.snapshotPath === undefined ? {} : { snapshot: join(task.codeRoot, config.snapshotPath) }),
    workDir: join(context.workDir, "exploration"), signal: controller.signal, onSpawn: processes.onSpawn });
  await surf.start();
  const surfnetPort = surf.ports()?.rpc;
  if (surfnetPort === undefined) throw new Error("Task Surfpool did not acquire its RPC port");
  const sourcesDir = join(tmpdir(), "oms-sources", context.taskName);
  mkdirSync(sourcesDir, { recursive: true, mode: 0o700 });
  const verifierFiles = pinned.pin.verifier.files.map(file => file.path);
  const mounts = buildMounts({ projectRoot: task.codeRoot, taskName: context.taskName,
    // The task's own tests start Surfpool, so the agent sees the same trusted binary the verifier does.
    // source_fetch's folder: outside the task root, so the proof's code digest and the verifier's staged copy never see it.
    // Host commands read it through the temp directory; a container needs it mounted at the same path.
    ...(!host ? { extra: [...(environment.dependencies ? trustedSurfpoolMounts(environment.binary) : []), { hostPath: sourcesDir, containerPath: sourcesDir, mode: "ro" as const }] } : {}),
    forbidden: { signerDir: join(workspace.omsDir, ".keys"), stateDir: workspace.stateDir,
      extra: [join(workspace.omsDir, ".env.agent")] },
    readOnlyPaths: [...verifierFiles.map(file => join(task.codeRoot, file)), join(task.codeRoot, ".git")],
    // The verifier sees the locked dependencies; the agent's own test runs must see the same ones.
    // Build-profile sessions install the project's own JS deps (deps_fetch), so no read-only overlay there.
    ...(environment.dependencies && !environment.buildProfile ? { readOnlyOverlays: [{ hostPath: join(environment.dependencies, "node_modules"), containerPath: "/work/node_modules" }] } : {}),
    heavyDirs: environment.buildProfile ? ["target", ".oms-cargo"] : [] });
  return { context, config, verifierFiles, taskSessions, manager, sessionId, executionMode, budget, withExecution, allocate,
    evaluator, baseEvaluator, proposer, surfnetPort, sourcesDir, mounts };
}
