import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquireLedgerLock, type LedgerLock } from './ledger-lock.ts';
import { SignerError } from './errors.ts';
import { syncDirectory } from './storage.ts';

interface Artifact {
  name: string;
  dev: number;
  ino: number;
  kind: 'file' | 'socket';
}
interface Manifest {
  v: 1;
  token: string;
  artifacts: Artifact[];
}
function identity(path: string, name: string): Artifact {
  const stat = lstatSync(path);
  if ((!stat.isFile() && !stat.isSocket()) || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
    throw new SignerError('E_BAD_REQUEST', 'signer artifact has an invalid identity');
  return { name, dev: stat.dev, ino: stat.ino, kind: stat.isSocket() ? 'socket' : 'file' };
}
function removeOwned(dir: string, artifact: Artifact): void {
  const path = join(dir, artifact.name);
  let current: Artifact;
  try {
    current = identity(path, artifact.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SignerError) return;
    throw error;
  }
  if (current.dev === artifact.dev && current.ino === artifact.ino && current.kind === artifact.kind) unlinkSync(path);
}

/** Private directory lease plus a crash-recovery manifest of this attempt's inodes. */
export class ServerArtifacts {
  readonly token: string;
  #dir: string;
  #lock: LedgerLock;
  #manifest: Artifact | undefined;
  #artifacts: Artifact[] = [];
  // Keep regular artifacts pinned until conditional removal, preventing an
  // unlinked token's inode from being reused by a later foreign replacement.
  #pins: number[] = [];
  #manifestFd = -1;
  #closed = false;
  constructor(dir: string) {
    this.#dir = dir;
    const manifestPath = join(dir, '.signer-artifacts.json');
    this.#lock = acquireLedgerLock(join(dir, '.signer.lock'), (oldToken) => {
      let fd: number;
      try {
        fd = openSync(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      let previous: Manifest;
      let manifest: Artifact;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 16_384)
          throw new Error('invalid startup manifest');
        previous = JSON.parse(readFileSync(fd, 'utf8')) as Manifest;
        manifest = { name: '.signer-artifacts.json', dev: stat.dev, ino: stat.ino, kind: 'file' };
      } finally {
        closeSync(fd);
      }
      if (
        previous.v !== 1 ||
        previous.token !== oldToken ||
        !Array.isArray(previous.artifacts) ||
        previous.artifacts.some(
          (a) =>
            !a ||
            typeof a.name !== 'string' ||
            !/^(?:(?:engine|tui)\.(?:sock|token)|\.[et]-[a-f0-9]{8})$/.test(a.name) ||
            !Number.isSafeInteger(a.dev) ||
            !Number.isSafeInteger(a.ino) ||
            !['file', 'socket'].includes(a.kind),
        )
      )
        throw new Error('unverifiable startup manifest');
      for (const artifact of previous.artifacts) removeOwned(dir, artifact);
      removeOwned(dir, manifest);
      syncDirectory(dir);
    });
    this.token = this.#lock.token;
    try {
      // Exclusive creation also rejects an unrelated manifest left by another owner.
      const fd = openSync(manifestPath, 'wx', 0o600);
      this.#manifestFd = fd;
      const stat = fstatSync(fd);
      this.#manifest = { name: '.signer-artifacts.json', dev: stat.dev, ino: stat.ino, kind: 'file' };
      writeFileSync(fd, JSON.stringify({ v: 1, token: this.token, artifacts: [] }));
      fsyncSync(fd);
      syncDirectory(dir);
    } catch (error) {
      try {
        if (this.#manifest) removeOwned(dir, this.#manifest);
      } finally {
        try {
          if (this.#manifestFd >= 0) closeSync(this.#manifestFd);
        } finally {
          this.#lock.release();
        }
      }
      throw error;
    }
  }
  track(name: string): void {
    const artifact = identity(join(this.#dir, name), name);
    this.#artifacts.push(artifact);
    if (artifact.kind === 'file') {
      const pin = openSync(join(this.#dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      this.#pins.push(pin);
      const stat = fstatSync(pin);
      if (stat.dev !== artifact.dev || stat.ino !== artifact.ino) throw new Error('startup artifact identity changed');
    }
    const current = identity(join(this.#dir, '.signer-artifacts.json'), '.signer-artifacts.json');
    if (current.dev !== this.#manifest!.dev || current.ino !== this.#manifest!.ino)
      throw new Error('startup manifest ownership changed');
    const stagedName = `.signer-manifest-${randomUUID()}`;
    const staging = join(this.#dir, stagedName);
    const fd = openSync(staging, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ v: 1, token: this.token, artifacts: this.#artifacts }));
      fsyncSync(fd);
      renameSync(staging, join(this.#dir, '.signer-artifacts.json'));
      const stat = fstatSync(fd);
      this.#manifest = { name: '.signer-artifacts.json', dev: stat.dev, ino: stat.ino, kind: 'file' };
      closeSync(this.#manifestFd);
      this.#manifestFd = fd;
      syncDirectory(this.#dir);
    } finally {
      if (fd !== this.#manifestFd) closeSync(fd);
      try {
        unlinkSync(staging);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      let failure: unknown;
      for (const artifact of [...this.#artifacts].reverse()) {
        try {
          removeOwned(this.#dir, artifact);
        } catch (error) {
          failure ??= error;
        }
      }
      try {
        if (this.#manifest) removeOwned(this.#dir, this.#manifest);
      } catch (error) {
        failure ??= error;
      }
      syncDirectory(this.#dir);
      if (failure) throw failure;
    } finally {
      let closeFailure: unknown;
      for (const fd of [...this.#pins, this.#manifestFd]) {
        try {
          if (fd >= 0) closeSync(fd);
        } catch (error) {
          closeFailure ??= error;
        }
      }
      this.#lock.release();
      if (closeFailure) throw closeFailure;
    }
  }
}
