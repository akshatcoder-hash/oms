import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { recoverTaskExecutionResources, SandboxError } from '@oms/sandbox';
import { identifyLeaseProcess, leaseProcessAlive, recoverStaleLeaseWithCleanup, type LeaseOwner } from '../workspace/lease.ts';
import { assertPrivate, contains, isMissing, privateDirectory, readPrivateJson, syncDirectory, WorkspaceError, writePrivateJson } from '../workspace/storage.ts';
import type { Task, Workspace } from '../workspace/index.ts';
import { taskContext, type TaskContext } from './task-context.ts';

function capturedRoot(cwd: string): boolean { return dirname(cwd) === tmpdir() && basename(cwd).startsWith('oms-proof-'); }

function sameIdentity(left: unknown, right: LeaseOwner): boolean {
  if (!left || typeof left !== 'object') return false;
  return Object.entries(right).every(([key, value]) => (left as Record<string, unknown>)[key] === value);
}

export interface RuntimeProcessTracker {
  onSpawn(pid: number, cwd: string): void;
  clear(): void;
}

/** Only the host process-spawn boundary can add entries; this directory is never mounted. */
export function trackRuntimeProcesses(leaseFile: string, owner: LeaseOwner, workDir: string, extraRoots: string[] = [], host = false): RuntimeProcessTracker {
  const directory = join(dirname(leaseFile), 'runtime-processes');
  privateDirectory(directory);
  const held: string[] = [];
  return {
    onSpawn(pid: number, cwd: string): void {
      if (!sameIdentity(readPrivateJson(leaseFile), owner) || (![workDir, ...extraRoots].some(root => contains(root, cwd)) && !(host && capturedRoot(cwd)))) {
        throw new WorkspaceError('LEASE_OWNERSHIP_LOST', 'Runtime process ownership changed before registration');
      }
      const child = identifyLeaseProcess(pid, owner.token);
      const file = join(directory, `${randomUUID()}.json`);
      writePrivateJson(file, { version: 1, owner, child, cwd });
      held.push(file);
    },
    clear(): void {
      for (const file of held) {
        const record = readPrivateJson(file) as { owner?: unknown; child?: LeaseOwner };
        if (!sameIdentity(record.owner, owner) || !record.child || leaseProcessAlive(record.child)) {
          throw new WorkspaceError('RECOVERY_PROCESS_UNVERIFIABLE', 'Runtime process exit was not verified; identity retained');
        }
        unlinkSync(file);
      }
      syncDirectory(directory);
      held.length = 0;
    },
  };
}

/** Linux start ticks since boot; the lease already pins the boot, so ticks order processes. */
function startTicks(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]);
}

/**
 * Whether a same-uid process whose cwd is hidden (non-dumpable, e.g. the login's sshd/systemd)
 * provably is not a descendant of the dead owner: it started before the owner, or its live
 * parent (older than it, so not a reused pid) belongs to another uid and is not init.
 * Reaching a foreign parent from the owner's tree takes a setuid tool, which needs approval.
 */
function cannotDescendFrom(pid: number, ownerStart: number): boolean {
  const start = startTicks(pid);
  if (start < ownerStart) return true;
  const parent = Number(/^PPid:\s+(\d+)$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]);
  return parent > 1 && lstatSync(`/proc/${parent}`).uid !== process.getuid?.() && startTicks(parent) <= start;
}

/**
 * Observe every same-user cwd, including children orphaned before identity publication.
 * Hidden cwds fail closed unless cannotDescendFrom proves the process is unrelated.
 */
function processDirectories(owner: LeaseOwner): Map<number, string> {
  const result = new Map<number, string>();
  if (process.platform === 'linux') {
    for (const entry of readdirSync('/proc')) {
      if (!/^[1-9][0-9]*$/.test(entry)) continue;
      try {
        if (lstatSync(`/proc/${entry}`).uid !== process.getuid?.()) continue;
        result.set(Number(entry), readlinkSync(`/proc/${entry}/cwd`));
      } catch (error) {
        if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ESRCH') continue;
        try { if ((error as NodeJS.ErrnoException).code === 'EACCES' && cannotDescendFrom(Number(entry), Number(owner.start))) continue; }
        catch { if (!existsSync(`/proc/${entry}`)) continue; }
        throw new WorkspaceError('RECOVERY_PROCESS_UNVERIFIABLE', 'Host process directories cannot be inspected; no ownership was removed');
      }
    }
  } else if (process.platform === 'darwin') {
    const listing = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-u', String(process.getuid?.()), '-d', 'cwd', '-F0pn'], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin', LC_ALL: 'C' }, encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (listing.error || listing.status !== 0 || listing.stderr.trim()) {
      throw new WorkspaceError('RECOVERY_PROCESS_UNVERIFIABLE', 'Host process directories cannot be inspected; allow local process inspection and retry recovery');
    }
    let pid: number | undefined;
    for (const field of listing.stdout.split('\0')) {
      const value = field.replace(/^\n/, '');
      if (/^p[1-9][0-9]*$/.test(value)) pid = Number(value.slice(1));
      else if (value.startsWith('n') && pid !== undefined) {
        if (!value.startsWith('n/')) throw new WorkspaceError('RECOVERY_PROCESS_UNVERIFIABLE', 'A host process directory is unresolved');
        result.set(pid, value.slice(1));
      }
    }
  } else throw new WorkspaceError('RECOVERY_PROCESS_UNVERIFIABLE', 'Workspace recovery requires Linux or macOS process inspection');
  if (!result.has(process.pid)) throw new WorkspaceError('RECOVERY_PROCESS_UNVERIFIABLE', 'Host process inventory is incomplete');
  return result;
}

interface RuntimeRecord { version: 1; owner: LeaseOwner; child: LeaseOwner; cwd: string }

function runtimeRecords(directory: string, owner: LeaseOwner, workDir: string, extraRoots: string[] = [], host = false): Array<{ file: string; record: RuntimeRecord }> {
  if (!existsSync(directory)) return [];
  assertPrivate(directory, true);
  return readdirSync(directory).map(name => {
    const file = join(directory, name);
    const value = readPrivateJson(file) as RuntimeRecord;
    if (!/^[a-f0-9-]{36}\.json$/.test(name) || value?.version !== 1 || !sameIdentity(value.owner, owner) ||
        !value.child || value.child.version !== 1 || !Number.isSafeInteger(value.child.pid) || value.child.pid <= 0 ||
        value.child.uid !== owner.uid || value.child.host !== owner.host || value.child.boot !== owner.boot ||
        value.child.token !== owner.token || typeof value.child.start !== 'string' || !value.child.start ||
        typeof value.cwd !== 'string' || (![workDir, ...extraRoots].some(root => contains(root, value.cwd)) && !(host && capturedRoot(value.cwd)))) {
      throw new WorkspaceError('RECOVERY_PROCESS_UNVERIFIABLE', 'Runtime process identity is incomplete or belongs to another owner; preserve it for host inspection');
    }
    return { file, record: value };
  });
}

/** Only owner-matching exclusion records are removable; persistent data is not a lease. */
function executionLeases(context: TaskContext, task: Task, owner: LeaseOwner): { files: Array<{ file: string; identity: string }>; gates: string[] } {
  const files: Array<{ file: string; identity: string }> = [];
  const gates: string[] = [];
  for (const name of readdirSync(context.sourceControlDir)) {
    if (name.startsWith('.pending-')) continue;
    const file = join(context.sourceControlDir, name);
    const record = readPrivateJson(file) as { token?: unknown; codeRoot?: unknown; pid?: unknown; kind?: unknown };
    if (typeof record.codeRoot !== 'string') throw new WorkspaceError('RECOVERY_SOURCE_UNVERIFIABLE', 'Source ownership is incomplete; host inspection is required');
    const owned = contains(task.codeRoot, record.codeRoot) || contains(context.stateDir, record.codeRoot) || contains(dirname(task.taskFile), record.codeRoot);
    if (!owned) {
      if (contains(record.codeRoot, task.codeRoot)) throw new WorkspaceError('RECOVERY_SOURCE_UNVERIFIABLE', 'Another source owner overlaps this task; close that task before recovery');
      continue;
    }
    if (record.pid !== owner.pid || typeof record.token !== 'string' || !record.token ||
        !['capture', 'sandbox'].includes(String(record.kind)) || name !== `${createHash('sha256').update(record.codeRoot).digest('hex')}.json`) {
      throw new WorkspaceError('RECOVERY_SOURCE_UNVERIFIABLE', 'Task source exclusion belongs to another or incomplete owner; it was preserved');
    }
    files.push({ file, identity: JSON.stringify(record) });
  }
  for (const name of readdirSync(context.leaseDir)) {
    const directory = join(context.leaseDir, name);
    assertPrivate(directory, true);
    if (!/^[a-f0-9]{64}$/.test(name)) throw new WorkspaceError('RECOVERY_VOLUME_UNVERIFIABLE', 'Volume exclusion directory is not recognized');
    for (const entry of readdirSync(directory)) {
      const file = join(directory, entry);
      if (entry === 'gate') {
        assertPrivate(file, true);
        if (readdirSync(file).length) throw new WorkspaceError('RECOVERY_VOLUME_UNVERIFIABLE', 'Volume exclusion change is incomplete; preserve it for host inspection');
        gates.push(file);
        continue;
      }
      const record = readPrivateJson(file) as { taskName?: unknown; volume?: unknown; phase?: unknown; pid?: unknown };
      if (!/^[a-f0-9-]{36}\.json$/.test(entry) || record.taskName !== context.taskName || record.pid !== owner.pid ||
          !['install', 'run'].includes(String(record.phase)) || typeof record.volume !== 'string' ||
          createHash('sha256').update(record.volume).digest('hex') !== name) {
        throw new WorkspaceError('RECOVERY_VOLUME_UNVERIFIABLE', 'Volume exclusion belongs to another or incomplete owner; data volumes were preserved');
      }
      files.push({ file, identity: JSON.stringify(record) });
    }
  }
  return { files, gates };
}

/** Explicit host action. Reclaim execution only; files, sessions, auth and data volumes survive. */
export async function recoverHarnessWorkspace(workspace: Workspace, task: Task, expected: LeaseOwner): Promise<void> {
  const context = taskContext(workspace, task);
  await recoverStaleLeaseWithCleanup(task.leaseFile, expected, async assertOwner => {
    const backendFile = join(context.stateDir, 'runtime-backend.json');
    const savedBackend = existsSync(backendFile) ? readPrivateJson(backendFile) as { backend?: unknown } : { backend: 'docker' };
    if (savedBackend.backend !== 'host' && savedBackend.backend !== 'docker') throw new WorkspaceError('RECOVERY_PROCESS_UNVERIFIABLE', 'Recorded execution backend is invalid');
    const backend = savedBackend.backend;
    const extraRoots = [...(backend === 'host' ? [task.codeRoot] : []), join(workspace.stateDir, 'sessions', task.id)];
    const withinRuntime = (cwd: string) => [context.workDir, ...extraRoots].some(root => contains(root, cwd));
    const directory = join(context.stateDir, 'runtime-processes');
    const records = runtimeRecords(directory, expected, context.workDir, extraRoots, backend === 'host');
    const exclusion = executionLeases(context, task, expected);
    const captured = records.map(entry => entry.record.cwd).filter(capturedRoot);
    const before = processDirectories(expected);
    const known = new Map(records.map(entry => [entry.record.child.pid, entry.record]));
    for (const [pid, cwd] of before) {
      if (!withinRuntime(cwd) && !captured.some(root => contains(root, cwd))) continue;
      const record = known.get(pid);
      if (!record || !leaseProcessAlive(record.child) || record.cwd !== cwd) {
        throw new WorkspaceError('RECOVERY_PROCESS_UNTRACKED', 'An older or untracked process still uses this task runtime. Stop it through its original owner, then retry Recover saved workspace; no process was signalled');
      }
    }
    for (const { record } of records) {
      if (leaseProcessAlive(record.child) && before.get(record.child.pid) !== record.cwd) {
        throw new WorkspaceError('RECOVERY_PROCESS_UNVERIFIABLE', 'A registered runtime process changed its working directory; no process was signalled');
      }
    }
    try { if (backend === 'docker') await recoverTaskExecutionResources(context.taskName, assertOwner); }
    catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(error instanceof SandboxError && error.code === 'E_RESOURCE_OWNERSHIP' ? 'RECOVERY_DOCKER_OWNERSHIP' : 'RECOVERY_DOCKER_UNAVAILABLE',
        error instanceof SandboxError && error.code === 'E_RESOURCE_OWNERSHIP'
          ? 'Docker execution ownership is foreign, incomplete or changed. Remaining resources and all data volumes were retained for host inspection'
          : 'Docker cleanup could not be verified. Start the local Docker daemon and retry Recover saved workspace; data volumes and saved work are retained');
    }
    for (const { record } of records) {
      assertOwner();
      if (!leaseProcessAlive(record.child)) continue;
      // Check exact start identity immediately before SIGTERM; never escalate to SIGKILL.
      try { process.kill(record.child.pid, 'SIGTERM'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      const deadline = performance.now() + 5_000;
      while (leaseProcessAlive(record.child)) {
        if (performance.now() >= deadline) throw new WorkspaceError('RECOVERY_PROCESS_RUNNING', 'A task runtime did not stop gracefully. No force-kill was attempted; wait for it to exit and retry recovery');
        await delay(50);
        assertOwner();
      }
    }
    if ([...processDirectories(expected).values()].some(cwd => withinRuntime(cwd) || captured.some(root => contains(root, cwd)))) {
      throw new WorkspaceError('RECOVERY_PROCESS_UNTRACKED', 'Task runtime processes remain; ownership and exclusion records were retained');
    }
    // Re-read every exclusion and child record after asynchronous cleanup, before removing any.
    const after = executionLeases(context, task, expected);
    if (JSON.stringify(after) !== JSON.stringify(exclusion) || JSON.stringify(runtimeRecords(directory, expected, context.workDir, extraRoots, backend === 'host')) !== JSON.stringify(records)) {
      throw new WorkspaceError('LEASE_OWNERSHIP_LOST', 'Runtime ownership records changed during recovery');
    }
    for (const file of [...exclusion.files.map(entry => entry.file), ...records.map(entry => entry.file)]) {
      assertOwner();
      unlinkSync(file);
      syncDirectory(dirname(file));
    }
    for (const gate of exclusion.gates) {
      assertOwner();
      rmdirSync(gate);
      syncDirectory(dirname(gate));
    }
  });
}
