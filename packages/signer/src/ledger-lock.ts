import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { SignerError } from './errors.ts';
import { syncDirectory } from './storage.ts';

interface Owner { v: 1; token: string; pid: number; uid: number; host: string; boot: string; start: string }
interface PublishedOwner { owner: Owner; dev: number; ino: number }
export interface LedgerLock { readonly token: string; assertOwned(): void; release(): void }
const failure = (message: string) => new SignerError('E_LEDGER', message);

function processStart(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      if (!start) throw failure('cannot verify ledger owner process identity');
      return start;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  if (process.platform === 'darwin') {
    try {
      return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() || null;
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 1) return null;
      throw error;
    }
  }
  throw failure('ledger process identity requires Linux or macOS');
}

function bootIdentity(): string {
  const boot = process.platform === 'linux' ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    : process.platform === 'darwin' ? execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() : '';
  if (!boot) throw failure('cannot verify ledger boot identity');
  return boot;
}

function currentOwner(): Owner {
  const uid = process.getuid?.();
  const start = processStart(process.pid);
  if (uid === undefined || !start) throw failure('cannot identify ledger owner');
  return { v: 1, token: randomUUID(), pid: process.pid, uid, host: hostname(), boot: bootIdentity(), start };
}

function readOwner(path: string): PublishedOwner {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw failure('ledger lock is not a private owner record');
    const owner = JSON.parse(readFileSync(fd, 'utf8')) as Owner;
    if (!owner || owner.v !== 1 || typeof owner.token !== 'string' || !owner.token || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.uid !== process.getuid?.() || typeof owner.host !== 'string' || !owner.host || typeof owner.boot !== 'string' || !owner.boot || typeof owner.start !== 'string' || !owner.start) throw failure('ledger lock owner is unverifiable');
    return { owner, dev: stat.dev, ino: stat.ino };
  } finally { closeSync(fd); }
}

function assertSame(path: string, expected: PublishedOwner): void {
  const actual = readOwner(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || JSON.stringify(actual.owner) !== JSON.stringify(expected.owner)) throw failure('ledger lock ownership changed; refusing to remove another owner');
}

/** Publish a fully fsync'd record atomically; never expose an empty PID file. */
function publish(path: string, owner: Owner): PublishedOwner {
  const staging = join(dirname(path), `.ledger-owner-${owner.token}`);
  const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(owner) + '\n');
    fsyncSync(fd);
    const stat = fstatSync(fd);
    linkSync(staging, path);
    return { owner, dev: stat.dev, ino: stat.ino };
  } finally { closeSync(fd); unlinkSync(staging); }
}

function ownerAlive(owner: Owner): boolean {
  if (owner.host !== hostname()) throw failure('ledger lock belongs to an unverifiable host');
  if (owner.boot !== bootIdentity()) return false;
  return processStart(owner.pid) === owner.start;
}

/**
 * Every acquisition, stale recovery and release holds the same exclusive gate.
 * Gates are NEVER automatically recovered: death or uncertainty inside this
 * tiny critical section requires host inspection, not another unlink race.
 */
function underGate<T>(path: string, work: () => T): T {
  const gatePath = `${path}.gate`;
  let gate: PublishedOwner;
  try { gate = publish(gatePath, currentOwner()); }
  catch { throw failure('ledger acquisition/recovery gate busy or unverifiable; refusing automatic recovery'); }
  try {
    syncDirectory(dirname(path));
    return work();
  } finally {
    assertSame(gatePath, gate);
    unlinkSync(gatePath);
    syncDirectory(dirname(path));
  }
}

export function acquireLedgerLock(path: string, beforeRecovery?: (token: string) => void): LedgerLock {
  let owned: PublishedOwner | undefined;
  try {
    underGate(path, () => {
      let existing: PublishedOwner | undefined;
      try { existing = readOwner(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (existing) {
        if (ownerAlive(existing.owner)) throw failure('spend journal is already open');
        beforeRecovery?.(existing.owner.token);
        assertSame(path, existing);
        unlinkSync(path);
      }
      owned = publish(path, currentOwner());
      syncDirectory(dirname(path));
    });
  } catch (error) {
    // A published lock stays conservative if gate release/persistence failed.
    if (error instanceof SignerError) throw error;
    throw failure('ledger lock unreadable or owner unverifiable; refusing to reset accounting');
  }
  const lock = owned!;
  let released = false;
  return {
    token: lock.owner.token,
    assertOwned() { if (released) throw failure('ledger lock already released'); assertSame(path, lock); },
    release() {
      if (released) return;
      underGate(path, () => {
        assertSame(path, lock);
        unlinkSync(path);
        syncDirectory(dirname(path));
        released = true;
      });
    },
  };
}
