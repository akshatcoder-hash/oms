import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_SNAPSHOT_DIGEST, parseTaskContract, pinContract, snapshotDigest, toPosixRelative, writeContractFileAtomic,
  type EvaluatorConfig,
} from "@oms/contract";
import { acquireTaskLease, type Task, type Workspace } from "../workspace/index.ts";
import { taskContext, type TaskContext } from "./task-context.ts";
import { createVerifierBackend, type VerifierBackend, type VerifierBackendOptions } from "./verifier-backend.ts";
import type { HarnessEnvironment, HarnessTaskDefinition } from "./session-types.ts";

/** Requirements are user-authored data; executable project resources are not loaded. */
export function parseHarnessTaskDefinition(input: unknown): HarnessTaskDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Task definition must be an object");
  const value = input as Record<string, unknown>;
  const allowed: Record<string, true> = { contract: true, verifierPaths: true, codePaths: true, snapshotPath: true, testTimeoutMs: true };
  if (Object.keys(value).some(key => !allowed[key])) throw new Error("Task definition contains an unsupported field");
  const parsed = parseTaskContract(value.contract);
  if (!parsed.ok) throw new Error("Task definition has invalid completion requirements");
  const paths: Record<"verifierPaths" | "codePaths", string[]> = { verifierPaths: [], codePaths: [] };
  for (const key of ["verifierPaths", "codePaths"] as const) {
    const items = value[key];
    if (!Array.isArray(items) || !items.length || !items.every(item => typeof item === "string")) {
      throw new Error(`${key} requires a nonempty array of relative paths`);
    }
    paths[key] = items.map(toPosixRelative);
    if (new Set(paths[key]).size !== paths[key].length) throw new Error(`${key} contains duplicate paths`);
  }
  const definition: HarnessTaskDefinition = { contract: parsed.value, ...paths };
  if (value.snapshotPath !== undefined) {
    if (typeof value.snapshotPath !== "string") throw new Error("snapshotPath must be relative");
    definition.snapshotPath = toPosixRelative(value.snapshotPath);
  }
  if (value.testTimeoutMs !== undefined) {
    if (typeof value.testTimeoutMs !== "number" || !Number.isSafeInteger(value.testTimeoutMs) ||
        value.testTimeoutMs <= 0 || value.testTimeoutMs > 2_147_483_647) {
      throw new Error("testTimeoutMs must be a bounded positive integer");
    }
    definition.testTimeoutMs = value.testTimeoutMs;
  }
  return definition;
}


/** The verifier backend options a task and its environment imply; a live session adds its signal and spawn hooks on top. */
export function verifierBackendOptions(environment: HarnessEnvironment, task: Task, context: TaskContext): VerifierBackendOptions {
  return { ...environment, ...(environment.backend === "host" ? { gitControlPath: join(task.codeRoot, ".git") } : {}),
    taskName: context.taskName, workDir: context.workDir, leaseDir: context.leaseDir, sourceControlDir: context.sourceControlDir };
}

/** Explicit host action: initialize requirements once, without running them or a model. */
export async function prepareHarnessTask(
  workspace: Workspace, task: Task, environment: HarnessEnvironment, definition: HarnessTaskDefinition,
): Promise<void> {
  const lease = acquireTaskLease(workspace, task.id);
  let backend: VerifierBackend | undefined;
  try {
    const context = taskContext(workspace, task);
    if (existsSync(task.taskFile) || existsSync(task.pinFile)) throw new Error("Task requirements already exist; refusing to replace their authority");
    const parsed = parseTaskContract(definition.contract);
    if (!parsed.ok) throw new Error("Task requirements are invalid");
    if (parsed.value.items.filter(item => item.status === "active").length !== 1 ||
        parsed.value.items.some(item => !["active", "open"].includes(item.status))) {
      throw new Error("A new task requires one active item and otherwise open items");
    }
    backend = await createVerifierBackend(verifierBackendOptions(environment, task, context));
    if (environment.dependencies) {
      // The complete input tree is digested, so the Docker mountpoint must predate every saved proof.
      const mountpoint = join(task.codeRoot, "node_modules");
      if (existsSync(mountpoint)) {
        const current = lstatSync(mountpoint);
        if (!current.isDirectory() || current.isSymbolicLink()) throw new Error("Task node_modules mountpoint must be a real directory");
      } else mkdirSync(mountpoint, { mode: 0o700 });
    }
    const config: EvaluatorConfig = {
      schema: "oms.evaluator/0", snapshotDigest: EMPTY_SNAPSHOT_DIGEST,
      codePaths: definition.codePaths, executionIdentity: backend.executionIdentity,
      ...(definition.snapshotPath === undefined ? {} : { snapshotPath: definition.snapshotPath }),
      ...(definition.testTimeoutMs === undefined ? {} : { testTimeoutMs: definition.testTimeoutMs }),
    };
    config.snapshotDigest = snapshotDigest(task.codeRoot, config, { sourceControlDir: context.sourceControlDir });
    writeContractFileAtomic(task.taskFile, parsed.value);
    const pinned = pinContract({ ...context.roots, contractPath: "task.json", verifierPaths: definition.verifierPaths,
      evaluatorConfig: config, pinFile: task.pinFile });
    if (!pinned.ok) throw new Error(`Requirements could not be pinned (${pinned.code}); task retained for inspection`);
  } finally {
    try { await backend?.dispose(); }
    finally { lease.release(); }
  }
}

