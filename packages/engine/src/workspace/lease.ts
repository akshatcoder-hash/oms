import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertPrivate, isMissing, syncDirectory, WorkspaceError } from "./storage.ts";

export interface LeaseOwner {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly uid: number;
  readonly host: string;
  readonly boot: string;
  readonly start: string;
}
export interface MutationLease { readonly file: string; readonly token: string; release(): void }

function processStart(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (!fields[19]) throw new WorkspaceError("LEASE_UNVERIFIABLE", "Cannot read process start identity");
      return fields[19];
    } catch (error) { if (isMissing(error)) return null; throw error; }
  }
  if (process.platform === "darwin") {
    try {
      const start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      return start || null;
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 1) return null;
      throw error;
    }
  }
  throw new WorkspaceError("LEASE_UNVERIFIABLE", "Process identity requires Linux or macOS");
}

function bootIdentity(): string {
  if (process.platform === "linux") return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (process.platform === "darwin") {
    return execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  throw new WorkspaceError("LEASE_UNVERIFIABLE", "Process identity requires Linux or macOS");
}

function readOwner(file: string): LeaseOwner {
  assertPrivate(dirname(file), true);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    // A freshly published lease briefly has its private staging hardlink as well.
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink > 2) {
      throw new WorkspaceError("LEASE_UNVERIFIABLE", "Lease is not an owned private file");
    }
    let value: unknown;
    try { value = JSON.parse(readFileSync(fd, "utf8")); }
    catch { throw new WorkspaceError("LEASE_UNVERIFIABLE", "Lease owner record is incomplete"); }
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
        !("token" in value) || typeof value.token !== "string" || !value.token ||
        !("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
        !("uid" in value) || typeof value.uid !== "number" || value.uid !== process.getuid?.() ||
        !("host" in value) || typeof value.host !== "string" ||
        !("boot" in value) || typeof value.boot !== "string" || !value.boot ||
        !("start" in value) || typeof value.start !== "string" || !value.start) {
      throw new WorkspaceError("LEASE_UNVERIFIABLE", "Lease owner identity is malformed");
    }
    return { version: 1, token: value.token, pid: value.pid, uid: value.uid, host: value.host, boot: value.boot, start: value.start };
  } finally { closeSync(fd); }
}

function ownerAlive(owner: LeaseOwner): boolean {
  if (owner.host !== hostname()) throw new WorkspaceError("LEASE_UNVERIFIABLE", "A different host owns this lease");
  if (owner.boot !== bootIdentity()) return false;
  return processStart(owner.pid) === owner.start;
}

/** Persist a child's host/boot/start identity before treating it as recoverable. */
export function identifyLeaseProcess(pid: number, token: string): LeaseOwner {
  const uid = process.getuid?.();
  const start = processStart(pid);
  if (uid === undefined || start === null) throw new WorkspaceError("LEASE_UNVERIFIABLE", "Cannot identify the runtime process");
  return { version: 1, token, pid, uid, host: hostname(), boot: bootIdentity(), start };
}

export function leaseProcessAlive(owner: LeaseOwner): boolean {
  if (owner.uid !== process.getuid?.()) throw new WorkspaceError("LEASE_UNVERIFIABLE", "A different user owns this process");
  return ownerAlive(owner);
}

export type LeaseInspection =
  | { status: "absent" | "unverifiable"; reason?: "foreign-host" | "recovery-in-progress" | "recovery-abandoned" | "invalid-owner" }
  | { status: "live" | "stale"; owner: LeaseOwner };

/** Host-only observation. Identity stays internal to ownership actions, never UI text. */
export function inspectMutationLease(file: string): LeaseInspection {
  try {
    assertPrivate(dirname(file), true);
    if (existsSync(`${file}.recovery`)) {
      const claim = readOwner(`${file}.recovery`);
      return { status: "unverifiable", reason: ownerAlive(claim) ? "recovery-in-progress" : "recovery-abandoned" };
    }
    let owner: LeaseOwner;
    try { owner = readOwner(file); }
    catch (error) { if (isMissing(error)) return { status: "absent" }; throw error; }
    if (owner.host !== hostname()) return { status: "unverifiable", reason: "foreign-host" };
    return { status: ownerAlive(owner) ? "live" : "stale", owner };
  } catch { return { status: "unverifiable", reason: "invalid-owner" }; }
}

function sameOwner(left: LeaseOwner, right: LeaseOwner): boolean {
  return left.version === right.version && left.token === right.token && left.pid === right.pid &&
    left.uid === right.uid && left.host === right.host && left.boot === right.boot && left.start === right.start;
}

/** Explicit operator action only. Successful resource teardown must release the lease itself. */
export async function stopMutationLeaseOwner(
  file: string, expected: LeaseOwner, timeoutMs = 5_000,
): Promise<"released" | "stale" | "timed-out"> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new RangeError("Owner shutdown wait must be between 1 and 10000 milliseconds");
  }
  const observe = (): LeaseInspection => {
    const state = inspectMutationLease(file);
    if (state.status === "unverifiable") throw new WorkspaceError("LEASE_UNVERIFIABLE", "Task ownership cannot be verified");
    if ("owner" in state && !sameOwner(state.owner, expected)) {
      throw new WorkspaceError("LEASE_OWNERSHIP_LOST", "Task ownership changed; refresh before deciding");
    }
    return state;
  };
  const before = observe();
  if (before.status === "absent") return "released";
  if (before.status === "stale") return "stale";
  if (expected.pid === process.pid) throw new WorkspaceError("LEASE_UNVERIFIABLE", "Cannot stop the requesting application");
  // Repeat host/boot/start and exact-record checks after the operator's confirmation, with no async gap.
  if (!ownerAlive(expected)) return "stale";
  if (!sameOwner(readOwner(file), expected)) {
    throw new WorkspaceError("LEASE_OWNERSHIP_LOST", "Task ownership changed; refresh before deciding");
  }
  if (existsSync(`${file}.recovery`)) throw new WorkspaceError("LEASE_UNVERIFIABLE", "Task ownership is being recovered");
  try { process.kill(expected.pid, "SIGTERM"); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error;
  }
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const state = observe();
    if (state.status === "absent") return "released";
    if (state.status === "stale") return "stale";
    const remaining = deadline - performance.now();
    if (remaining <= 0) return "timed-out";
    await delay(Math.min(100, remaining));
  }
}

/** Atomic publication of a complete owner identity, never a timestamp-based expiry. */
export function acquireMutationLease(file: string): MutationLease {
  assertPrivate(dirname(file), true);
  if (existsSync(`${file}.recovery`)) throw new WorkspaceError("LEASE_BUSY", "Lease recovery is in progress");
  const uid = process.getuid?.();
  const start = processStart(process.pid);
  if (uid === undefined || start === null) throw new WorkspaceError("LEASE_UNVERIFIABLE", "Cannot identify this process");
  const owner: LeaseOwner = { version: 1, token: randomUUID(), pid: process.pid, uid, host: hostname(), boot: bootIdentity(), start };
  const staging = join(dirname(file), `.lease-${owner.token}`);
  const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(owner)}\n`); fsyncSync(fd); }
  catch (error) { unlinkSync(staging); throw error; }
  finally { closeSync(fd); }
  try { linkSync(staging, file); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      let existing: LeaseOwner;
      try { existing = readOwner(file); }
      catch (readError) {
        if (isMissing(readError)) throw new WorkspaceError("LEASE_BUSY", "Lease changed during acquisition; retry explicitly");
        throw readError;
      }
      throw new WorkspaceError(ownerAlive(existing) ? "LEASE_BUSY" : "LEASE_STALE", `Mutation lease owned by pid ${existing.pid}; token ${existing.token}`);
    }
    throw error;
  } finally { unlinkSync(staging); }
  syncDirectory(dirname(file));
  let released = false;
  const lease: MutationLease = {
    file, token: owner.token,
    release() {
      if (released) return;
      const existing = readOwner(file);
      if (existing.token !== owner.token || existing.pid !== process.pid || existing.start !== processStart(process.pid)) {
        throw new WorkspaceError("LEASE_OWNERSHIP_LOST", "Refusing to release a different process's lease");
      }
      unlinkSync(file);
      syncDirectory(dirname(file));
      released = true;
    },
  };
  if (existsSync(`${file}.recovery`)) {
    lease.release();
    throw new WorkspaceError("LEASE_BUSY", "Lease recovery started during acquisition");
  }
  return lease;
}

/** Explicit host decision using the exact observed token; resource cleanup is a separate prerequisite. */
export function recoverStaleLease(file: string, expectedToken: string): void {
  const recovery = acquireMutationLease(`${file}.recovery`);
  try {
    const owner = readOwner(file);
    if (owner.token !== expectedToken) throw new WorkspaceError("LEASE_OWNERSHIP_LOST", "Lease changed since the recovery decision");
    if (ownerAlive(owner)) throw new WorkspaceError("LEASE_BUSY", "The lease owner is still running");
    unlinkSync(file);
    syncDirectory(dirname(file));
  } finally { recovery.release(); }
}

/** Keep the recovery claim for the entire asynchronous cleanup, not just unlink. */
export async function recoverStaleLeaseWithCleanup(
  file: string, expected: LeaseOwner, cleanup: (assertOwner: () => void) => Promise<void>,
): Promise<void> {
  const recovery = acquireMutationLease(`${file}.recovery`);
  const assertOwner = () => {
    if (!sameOwner(readOwner(file), expected)) {
      throw new WorkspaceError("LEASE_OWNERSHIP_LOST", "Task ownership changed; refresh before recovering");
    }
    if (ownerAlive(expected)) throw new WorkspaceError("LEASE_BUSY", "The previous OMS owner is still running");
    const claim = readOwner(recovery.file);
    if (claim.token !== recovery.token || !ownerAlive(claim)) {
      throw new WorkspaceError("LEASE_OWNERSHIP_LOST", "Recovery ownership changed; no further cleanup is safe");
    }
  };
  try {
    assertOwner();
    await cleanup(assertOwner);
    assertOwner();
    unlinkSync(file);
    syncDirectory(dirname(file));
  } finally { recovery.release(); }
}
