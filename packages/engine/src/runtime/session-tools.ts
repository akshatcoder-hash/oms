import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createOmsExtensions } from "../oms-extension.ts";
import { checkToolchain } from "../toolchain/check.ts";
import { readProject } from "../toolchain/project.ts";
import { createEdgeCheck, gitChangedPaths } from "./edge-check.ts";
import { accountKnowledgeSource, createKnowledgeExtension, createKnowledgeVisibility, type KnowledgeConfig } from "./knowledge-service.ts";
import type { OmsAccountControls } from "./oms-account.ts";
import { installedProgramClients, programReferenceExtension } from "./program-reference.ts";
import { backendFor, type ExecutionBackend } from "./execution-backend.ts";
import { createSandboxTools } from "./sandbox-tools.ts";
import type { SessionHooks } from "./session-hooks.ts";
import type { SessionLifecycle } from "./session-lifecycle.ts";
import type { TaskEnvironment } from "./session-environment.ts";
import type { HarnessSessionOptions } from "./session-types.ts";
import { createDiagnosisExtension } from "./solana-diagnosis.ts";
import { createWeb } from "./web.ts";

/** The task's tools: sandbox commands, toolchain report, optional web, the knowledge source and the optional edge check. */
export interface SessionTools {
  /** The task root as the agent and the guards see it: the real checkout on host, /work in a container. */
  taskRoot: string;
  backend: ExecutionBackend;
  sandboxTools: ReturnType<typeof createSandboxTools>;
  toolchainReadiness(): ReturnType<typeof checkToolchain> | { status: string; error: string };
  toolchainSummary: string;
  web: ReturnType<typeof createWeb> | undefined;
  /** Read on every call, never cached: a /login or /logout takes effect on the next call. */
  knowledgeSource: () => KnowledgeConfig | undefined;
  edgeCheck: ReturnType<typeof createEdgeCheck> | undefined;
}

export function createSessionTools(
  options: HarnessSessionOptions, life: SessionLifecycle, env: TaskEnvironment, account: OmsAccountControls,
): SessionTools {
  const { task, environment } = options;
  const backend = backendFor(environment);
  const taskRoot = backend.taskRoot(task.codeRoot);
  const sandboxTools = createSandboxTools({ onSpawn: life.processes!.onSpawn, backend, approvalPolicy: options.hostApprovalPolicy,
    protectedPaths: [...env.verifierFiles.map(file => join(taskRoot, file)), join(taskRoot, ".git")], taskName: env.context.taskName, mounts: env.mounts,
    leaseDir: env.context.leaseDir, sourceControlDir: env.context.sourceControlDir,
    surfnetPort: env.surfnetPort, signal: life.controller.signal,
    surfpool: backend.surfpoolPath(environment),
    outputMode: options.outputMode,
    buildProfile: environment.buildProfile,
    remainingWallClockMs: () => env.budget.snapshot().remaining.wallClockMs });
  life.taskTools = sandboxTools;
  const toolchainReadiness: SessionTools["toolchainReadiness"] = () => {
    try { return checkToolchain(readProject(task.codeRoot)); }
    catch { return { status: "proposed, not verified", error: "Toolchain scan unavailable: invalid/oversized manifests or Python >=3.11 missing" }; }
  };
  const initialToolchain = toolchainReadiness();
  const installedClients = installedProgramClients([task.codeRoot, ...(environment.dependencies ? [environment.dependencies] : [])]);
  const toolchainSummary = ("findings" in initialToolchain
    ? `Compatibility rule findings: ${[...new Set(initialToolchain.findings.map(finding => finding.rule))].join(", ") || "none"}; use toolchain_check for details. Build not verified.`
    : "Toolchain scan unavailable; use toolchain_check for details. Build not verified.")
    + (installedClients.length ? ` Installed official program clients: ${installedClients.join(", ")}.` : "");
  // Web tools ask for the credential only during a turn.
  const web = options.web ? createWeb({ account: () => account.searchCredential(), sourcesDir: env.sourcesDir, ...options.web }) : undefined;
  // Precedence: host option, env pair, account.
  const knowledgeSource = accountKnowledgeSource({ pinned: options.knowledge, account: () => account.searchCredential() });
  const edgeCheck = options.edgeCheck ? createEdgeCheck({ changedPaths: () => gitChangedPaths(task.codeRoot, task.baseOid) }) : undefined;
  return { taskRoot, backend, sandboxTools, toolchainReadiness, toolchainSummary, web, knowledgeSource, edgeCheck };
}

/** Composes the pi extensions: proposal and verification, guards, trace, budget, the sandbox tools, prompt hooks and knowledge. */
export function createSessionExtensions(
  options: HarnessSessionOptions, life: SessionLifecycle, env: TaskEnvironment, tools: SessionTools, hooks: SessionHooks,
  initiallyKnown: boolean,
): ReturnType<typeof createOmsExtensions> {
  const { task, environment } = options;
  const { taskRoot, knowledgeSource } = tools;
  const extra: ExtensionFactory[] = [
    tools.sandboxTools.extension, hooks.policy, programReferenceExtension,
    createDiagnosisExtension({ codeRoot: task.codeRoot, rpcUrl: `http://127.0.0.1:${env.surfnetPort}`, knowledge: knowledgeSource }),
    ...[createKnowledgeExtension(knowledgeSource), createKnowledgeVisibility(knowledgeSource, hooks.promptFor, () => initiallyKnown),
      tools.web?.extension, tools.edgeCheck?.extension].filter(extension => extension !== undefined),
  ];
  return createOmsExtensions({ proposer: env.proposer, evaluator: env.evaluator, endRunOnProposal: options.endRunOnProposal,
    guards: { approveHostCommands: tools.backend.approvesCommands }, cwd: taskRoot, trace: life.trace!, budget: env.budget,
    protectedPaths: [...env.verifierFiles.map(file => `${taskRoot}/${file}`), join(taskRoot, ".git")],
    extra });
}
