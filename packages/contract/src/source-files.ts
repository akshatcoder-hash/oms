import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import { PathError } from './paths.ts';

export interface DirectoryIdentity { path: string; stat: Stats }

export function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
}

export function directoryIdentities(path: string): DirectoryIdentity[] {
  const chain: DirectoryIdentity[] = [];
  for (let current = path;; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || realpathSync(current) !== current) throw new PathError('E_BAD_ROOT', 'input directory identity is invalid', current);
    chain.push({ path: current, stat });
    if (dirname(current) === current) return chain;
  }
}

export function assertDirectories(chain: readonly DirectoryIdentity[]): void {
  for (const entry of chain) {
    const current = lstatSync(entry.path);
    if (!current.isDirectory() || !sameIdentity(current, entry.stat) || realpathSync(entry.path) !== entry.path) {
      throw new PathError('E_BAD_ROOT', 'input directory identity changed', entry.path);
    }
  }
}

/** The caller holds source exclusion. No pathname read can follow a substituted
 * symlink or block opening a FIFO; opened identity/type is checked before bytes.
 * Ancestor validation is defense in depth, not an openat/descriptor-walk claim.
 */
export function readCheckedFile(path: string, expected: Stats, maxBytes: number, directories = directoryIdentities(dirname(path))): Buffer {
  if (!expected.isFile()) throw new PathError('E_NOT_A_FILE', 'input is not a regular file', path);
  if (!Number.isSafeInteger(expected.size) || expected.size < 0 || expected.size > maxBytes) throw new RangeError('input exceeds the proof byte limit');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(opened, expected) || opened.size !== expected.size ||
        opened.mtimeMs !== expected.mtimeMs || opened.ctimeMs !== expected.ctimeMs) {
      throw new PathError('E_NOT_A_FILE', 'opened input identity changed before reading', path);
    }
    assertDirectories(directories);
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (read === 0) throw new PathError('E_NOT_A_FILE', 'input shortened while reading', path);
      offset += read;
    }
    if (readSync(fd, Buffer.allocUnsafe(1), 0, 1, offset) !== 0) throw new PathError('E_NOT_A_FILE', 'input grew while reading', path);
    const after = fstatSync(fd);
    if (!sameIdentity(after, opened) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new PathError('E_NOT_A_FILE', 'input changed while reading', path);
    }
    assertDirectories(directories);
    return bytes;
  } finally { closeSync(fd); }
}
