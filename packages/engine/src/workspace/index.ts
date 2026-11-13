import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { addWorktree, branchExists, commitExists, commitHasPrivateState, ignoresPrivateState, repositoryPaths, resolveCommit, trackedPrivateState, validateWorktree } from "./git.ts";
import { acquireMutationLease, type MutationLease } from "./lease.ts";
import { assertPrivate, contains, fileIdentity, isMissing, privateDirectory, readPrivateJson, stateRootPath, syncDirectory, WorkspaceError, writePrivateJson } from "./storage.ts";

export { WorkspaceError } from "./storage.ts";
export {
  acquireMutationLease, recoverStaleLease, recoverStaleLeaseWithCleanup, inspectMutationLease, stopMutationLeaseOwner,
  type MutationLease, type LeaseOwner, type LeaseInspection,
} from "./lease.ts";

export interface Workspace {
  id: string;
  root: string;
  gitCommonDir: string;
  omsDir: string;
  stateDir: string;
}
export interface Task {
  workspaceId: string;
  id: string;
  codeRoot: string;
  taskFile: string;
  pinFile: string;
  leaseFile: string;
  branch: string;
  baseOid: string;
  recordFile: string;
}
export interface OpenWorkspaceOptions {
  /** Trusted host configuration, never model input. Defaults to ~/.oms. */
  stateRoot?: string;
  initialize?: { ignore: "gitignore" | "exclude" | "require-existing" };
  /** Required to replace a copied identity or relink a moved repository. */
  identityDecision?: "new" | "relink";
}
interface Identity {
  version: 1;
  id: string;
  root: string;
  gitCommonDir: string;
  rootIdentity: string;
  commonIdentity: string;
}
interface TaskRecord {
  version: 1;
  workspaceId: string;
  id: string;
  branch: string;
  baseOid: string;
  status: "creating" | "ready" | "failed";
  createdAt: string;
}
const workspaceIdPattern = /^w-[a-f0-9-]{36}$/;
const taskIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readIdentity(path: string): Identity {
  const value = readPrivateJson(path);
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("id" in value) || typeof value.id !== "string" || !workspaceIdPattern.test(value.id) ||
      !("root" in value) || typeof value.root !== "string" || !value.root ||
      !("gitCommonDir" in value) || typeof value.gitCommonDir !== "string" || !value.gitCommonDir ||
      !("rootIdentity" in value) || typeof value.rootIdentity !== "string" ||
      !("commonIdentity" in value) || typeof value.commonIdentity !== "string") {
    throw new WorkspaceError("INVALID_IDENTITY", "Workspace identity record is malformed");
  }
  return { version: 1, id: value.id, root: value.root, gitCommonDir: value.gitCommonDir, rootIdentity: value.rootIdentity, commonIdentity: value.commonIdentity };
}

function matchesIdentity(a: Identity, b: Identity): boolean {
  return a.id === b.id && a.root === b.root && a.gitCommonDir === b.gitCommonDir &&
    a.rootIdentity === b.rootIdentity && a.commonIdentity === b.commonIdentity;
}

function appendIgnore(path: string): void {
  // Ignore files are ordinary repository files, not secret files. Never follow a symlink.
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) {
      throw new WorkspaceError("UNSAFE_PATH", `Ignore file is not a safe owned regular file: ${path}`);
    }
  } catch (error) { if (!isMissing(error)) throw error; }
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o644);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) {
      throw new WorkspaceError("UNSAFE_PATH", "Ignore file changed while opening");
    }
    const previous = readFileSync(fd, "utf8");
    writeFileSync(fd, `${previous && !previous.endsWith("\n") ? "\n" : ""}/.oms/\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}

function ensureIgnore(root: string, gitCommonDir: string, disposition: OpenWorkspaceOptions["initialize"]): void {
  if (ignoresPrivateState(root)) return;
  if (!disposition || disposition.ignore === "require-existing") {
    throw new WorkspaceError("IGNORE_REQUIRED", "Ignore .oms before initializing, or explicitly choose gitignore/exclude");
  }
  if (disposition.ignore === "gitignore") appendIgnore(join(root, ".gitignore"));
  else if (disposition.ignore === "exclude") {
    const info = join(gitCommonDir, "info");
    try { mkdirSync(info, { mode: 0o755 }); } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    const stat = lstatSync(info);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
      throw new WorkspaceError("UNSAFE_PATH", "Git info directory is unsafe");
    }
    appendIgnore(join(info, "exclude"));
  } else throw new WorkspaceError("IGNORE_REQUIRED", "Unknown ignore disposition");
  if (!ignoresPrivateState(root)) throw new WorkspaceError("IGNORE_REQUIRED", "Repository ignore rules still expose .oms private state");
}

/** Without initialize/identityDecision this is read-only discovery, never metadata adoption. */
export function openWorkspace(repositoryPath: string, options: OpenWorkspaceOptions = {}): Workspace {
  const paths = repositoryPaths(repositoryPath);
  const { root, gitCommonDir } = paths;
  const omsDir = join(root, ".oms");
  const stateRoot = stateRootPath(options.stateRoot ?? join(homedir(), ".oms"));
  for (const codeRoot of paths.worktrees) {
    let canonical: string;
    try { canonical = realpathSync(codeRoot); } catch (error) { if (isMissing(error)) continue; throw error; }
    if (contains(canonical, stateRoot)) throw new WorkspaceError("STATE_INSIDE_REPOSITORY", "User state must be outside all repository worktrees");
  }
  if (contains(gitCommonDir, stateRoot) || contains(stateRoot, root) || contains(stateRoot, gitCommonDir)) {
    throw new WorkspaceError("STATE_INSIDE_REPOSITORY", "User state and repository storage must be disjoint");
  }
  if (trackedPrivateState(root)) throw new WorkspaceError("TRACKED_PRIVATE_STATE", "Tracked .oms state must be removed from the index before initialization");
  let local: Identity | undefined;
  try {
    assertPrivate(omsDir, true);
    local = readIdentity(join(omsDir, "workspace.json"));
  } catch (error) { if (!isMissing(error)) throw error; }
  if (!local && !options.initialize) throw new WorkspaceError("INITIALIZATION_REQUIRED", "Explicit workspace initialization and ignore disposition are required");
  const current = (id: string): Identity => ({ version: 1, id, root, gitCommonDir, rootIdentity: fileIdentity(root), commonIdentity: fileIdentity(gitCommonDir) });
  const workspacesDir = join(stateRoot, "workspaces");
  let registered: Identity | undefined;
  if (local) {
    try {
      assertPrivate(stateRoot, true);
      assertPrivate(workspacesDir, true);
      assertPrivate(join(workspacesDir, local.id), true);
      registered = readIdentity(join(workspacesDir, local.id, "workspace.json"));
    } catch (error) { if (!isMissing(error)) throw error; }
    if (registered && matchesIdentity(local, registered) && matchesIdentity(local, current(local.id))) {
      if (!ignoresPrivateState(root)) throw new WorkspaceError("IGNORE_REQUIRED", "Workspace private state is no longer ignored");
      for (const directory of [join(omsDir, "tasks"), join(omsDir, "worktrees"), join(workspacesDir, local.id, "tasks")]) assertPrivate(directory, true);
      return { id: local.id, root, gitCommonDir, omsDir, stateDir: join(workspacesDir, local.id) };
    }
    if (!options.identityDecision) throw new WorkspaceError("IDENTITY_DECISION_REQUIRED", "Copied, moved or unregistered workspace identity requires an explicit new/relink decision");
  }
  // All writes below require explicit initialization or identity resolution.
  privateDirectory(stateRoot);
  privateDirectory(workspacesDir);
  const registryLease = acquireMutationLease(join(stateRoot, "registry.lease"));
  try {
    // Re-read after acquiring the shared registry lease; never overwrite concurrent registration.
    let latest: Identity | undefined;
    try { latest = readIdentity(join(omsDir, "workspace.json")); } catch (error) { if (!isMissing(error)) throw error; }
    if ((!local && latest) || (local && (!latest || !matchesIdentity(local, latest)))) {
      throw new WorkspaceError("IDENTITY_DECISION_REQUIRED", "Workspace identity changed during initialization; reopen it");
    }
    let id = `w-${randomUUID()}`;
    if (local && options.identityDecision === "relink") {
      if (!registered || !matchesIdentity(local, registered)) throw new WorkspaceError("IDENTITY_DECISION_REQUIRED", "Relink requires the existing trusted registry identity");
      if ((local.root !== root && existsSync(local.root)) || (local.gitCommonDir !== gitCommonDir && existsSync(local.gitCommonDir))) {
        throw new WorkspaceError("IDENTITY_IN_USE", "The original repository still exists; use a new identity for this copy");
      }
      id = local.id;
    }
    ensureIgnore(root, gitCommonDir, options.initialize ?? { ignore: "require-existing" });
    privateDirectory(omsDir);
    privateDirectory(join(omsDir, "tasks"));
    privateDirectory(join(omsDir, "worktrees"));
    const stateDir = join(workspacesDir, id);
    if (id !== local?.id && existsSync(stateDir)) throw new WorkspaceError("IDENTITY_IN_USE", "Generated workspace identity already exists");
    privateDirectory(stateDir);
    privateDirectory(join(stateDir, "tasks"));
    const identity = current(id);
    writePrivateJson(join(stateDir, "workspace.json"), identity);
    writePrivateJson(join(omsDir, "workspace.json"), identity);
    return { id, root, gitCommonDir, omsDir, stateDir };
  } finally { registryLease.release(); }
}

function assertWorkspace(workspace: Workspace): void {
  const reopened = openWorkspace(workspace.root, { stateRoot: dirname(dirname(workspace.stateDir)) });
  for (const key of ["id", "root", "gitCommonDir", "omsDir", "stateDir"] as const) {
    if (reopened[key] !== workspace[key]) throw new WorkspaceError("IDENTITY_DECISION_REQUIRED", "Workspace record no longer matches its registered repository");
  }
}

export function acquireWorkspaceLease(workspace: Workspace): MutationLease {
  assertWorkspace(workspace);
  return acquireMutationLease(join(workspace.stateDir, "mutation.lease"));
}

function taskPaths(workspace: Workspace, id: string, baseOid: string): Task {
  if (!taskIdPattern.test(id)) throw new WorkspaceError("INVALID_TASK_ID", "Task id must be 1-64 lowercase letters, numbers or hyphens");
  const taskDir = join(workspace.omsDir, "tasks", id);
  const stateDir = join(workspace.stateDir, "tasks", id);
  return {
    workspaceId: workspace.id, id, baseOid,
    codeRoot: join(workspace.omsDir, "worktrees", id),
    taskFile: join(taskDir, "task.json"), recordFile: join(taskDir, "record.json"),
    pinFile: join(stateDir, "pin.json"), leaseFile: join(stateDir, "mutation.lease"),
    branch: `oms/${workspace.id}/${id}`,
  };
}

/** Resolves any revision git understands (default HEAD) to the full commit oid a task pins. */
export function resolveBaseOid(workspace: Workspace, revision = "HEAD"): string {
  const oid = resolveCommit(workspace.root, revision);
  if (!oid) throw new WorkspaceError("INVALID_BASE_OID", `--base ${revision} does not name a commit in this repository`);
  return oid;
}

/** Host-only Git controller. No caller-chosen worktree path, branch or symbolic base. */
export function createTask(workspace: Workspace, options: { id?: string; baseOid: string }): Task {
  const id = options.id ?? `t-${randomUUID()}`;
  const task = taskPaths(workspace, id, options.baseOid);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.baseOid)) {
    throw new WorkspaceError("INVALID_BASE_OID", "Task creation requires a full immutable commit oid");
  }
  const lease = acquireWorkspaceLease(workspace);
  try {
    if (!commitExists(workspace.root, options.baseOid)) throw new WorkspaceError("INVALID_BASE_OID", "Base oid is not a local commit");
    if (commitHasPrivateState(workspace.root, options.baseOid)) throw new WorkspaceError("TRACKED_PRIVATE_STATE", "Task base commit contains tracked .oms state");
    const taskDir = dirname(task.taskFile);
    const externalTaskDir = dirname(task.pinFile);
    for (const path of [taskDir, task.codeRoot, externalTaskDir]) {
      try { lstatSync(path); throw new WorkspaceError("TASK_EXISTS", `Task path already exists: ${path}`); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
    if (branchExists(workspace.root, task.branch)) throw new WorkspaceError("TASK_EXISTS", "Task branch already exists");
    privateDirectory(taskDir);
    privateDirectory(externalTaskDir);
    const record: TaskRecord = { version: 1, workspaceId: workspace.id, id, baseOid: options.baseOid, branch: task.branch, status: "creating", createdAt: new Date().toISOString() };
    // Intent precedes Git mutation, so a crash leaves an inspectable ownership record.
    writePrivateJson(task.recordFile, record);
    writePrivateJson(join(externalTaskDir, "record.json"), record);
    try {
      addWorktree(workspace.root, task.codeRoot, task.branch, task.baseOid);
      const stat = lstatSync(task.codeRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
        throw new WorkspaceError("UNSAFE_PATH", "Created checkout is not an owned safe directory");
      }
      validateWorktree(workspace.root, task.codeRoot, task.branch, workspace.gitCommonDir);
      record.status = "ready";
      writePrivateJson(join(externalTaskDir, "record.json"), record);
      writePrivateJson(task.recordFile, record);
    } catch (error) {
      // Never force-delete a possibly changed checkout or branch after an uncertain Git outcome.
      record.status = "failed";
      writePrivateJson(join(externalTaskDir, "record.json"), record);
      writePrivateJson(task.recordFile, record);
      throw error;
    }
    return task;
  } finally { lease.release(); }
}

export function readTask(workspace: Workspace, id: string): Task {
  assertWorkspace(workspace);
  const paths = taskPaths(workspace, id, "");
  assertPrivate(dirname(paths.taskFile), true);
  assertPrivate(dirname(paths.pinFile), true);
  const local = readPrivateJson(paths.recordFile);
  const external = readPrivateJson(join(dirname(paths.pinFile), "record.json"));
  if (!local || typeof local !== "object" || !("version" in local) || local.version !== 1 ||
      !("workspaceId" in local) || local.workspaceId !== workspace.id || !("id" in local) || local.id !== id ||
      !("branch" in local) || local.branch !== paths.branch || !("status" in local) || local.status !== "ready" ||
      !("baseOid" in local) || typeof local.baseOid !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(local.baseOid) ||
      JSON.stringify(local) !== JSON.stringify(external)) {
    throw new WorkspaceError("TASK_IDENTITY_MISMATCH", "Task is not a completed, matching locally and externally owned record");
  }
  if (realpathSync(paths.codeRoot) !== resolve(paths.codeRoot)) throw new WorkspaceError("UNSAFE_PATH", "Task checkout cannot be a symlink");
  const stat = lstatSync(paths.codeRoot);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
    throw new WorkspaceError("UNSAFE_PATH", "Task checkout ownership or permissions changed");
  }
  validateWorktree(workspace.root, paths.codeRoot, paths.branch, workspace.gitCommonDir);
  return taskPaths(workspace, id, local.baseOid);
}

export function acquireTaskLease(workspace: Workspace, taskId: string): MutationLease {
  const task = readTask(workspace, taskId);
  return acquireMutationLease(task.leaseFile);
}
