import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isInside, realpathAllowingMissing } from './paths.ts';
import { assertDirectories, directoryIdentities, sameIdentity } from './source-files.ts';

export interface SourceAccessOptions {
  /** Trusted, uid-private, persistent control directory outside all sandbox binds. */
  sourceControlDir?: string;
}

export class SourceAccessError extends Error {
  readonly code: 'E_SOURCE_BUSY' | 'E_SOURCE_CONTROL';
  constructor(code: 'E_SOURCE_BUSY' | 'E_SOURCE_CONTROL', message: string) {
    super(message);
    this.name = 'SourceAccessError';
    this.code = code;
  }
}

export function sourceControlDirectory(options: SourceAccessOptions = {}): string {
  const requested = options.sourceControlDir ?? join(tmpdir(), `oms-source-access-${process.getuid?.() ?? 'host'}`);
  if (!isAbsolute(requested)) throw new SourceAccessError('E_SOURCE_CONTROL', 'sourceControlDir must be absolute');
  return realpathAllowingMissing(resolve(requested));
}

function privateDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new SourceAccessError('E_SOURCE_CONTROL', 'source control directories must be host-owned and private (0700)');
  }
}

/** Source authority is an admitted absolute canonical pathname, not whatever a
 * new realpath lookup happens to target. Never change the ownership key here.
 */
function sourceAuthority(requested: string): string {
  if (typeof requested !== 'string' || !isAbsolute(requested) || resolve(requested) !== requested) {
    throw new SourceAccessError('E_SOURCE_CONTROL', 'source root must be an absolute canonical admitted path');
  }
  return requested;
}

/** Exclusive across processes. Crash/uncertain ownership is deliberately never stolen.
 * The trusted host may remove ownership only after independently stopping all writers.
 * This excludes managed sandbox writers, not hostile same-uid host processes.
 */
export function acquireSourceAccess(
  codeRoot: string,
  options: SourceAccessOptions & { kind: 'capture' | 'sandbox' },
): () => void {
  const root = sourceAuthority(codeRoot);
  const directories = directoryIdentities(dirname(root));
  const source = lstatSync(root);
  if ((!source.isDirectory() && !source.isFile()) || realpathSync(root) !== root) {
    throw new SourceAccessError('E_SOURCE_CONTROL', 'source root must remain canonical and must not be a symlink');
  }
  const control = sourceControlDirectory(options);
  if (isInside(root, control) || isInside(control, root)) {
    throw new SourceAccessError('E_SOURCE_CONTROL', 'source control and source root must be disjoint');
  }
  mkdirSync(control, { recursive: true, mode: 0o700 });
  if (realpathSync(control) !== control) throw new SourceAccessError('E_SOURCE_CONTROL', 'source control path changed');
  privateDirectory(control);
  const controlInfo = lstatSync(control);
  const filename = `${createHash('sha256').update(root).digest('hex')}.json`;
  const file = join(control, filename);
  const token = randomUUID();
  const pending = join(control, `.pending-${token}`);
  // Publish complete ownership atomically without replacing any existing owner.
  // A crash before publication cannot have started a writer; only .pending-*
  // scratch records may be ignored. Published records are never guessed dead.
  writeFileSync(pending, JSON.stringify({ token, codeRoot: root, kind: options.kind, pid: process.pid }), {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    try {
      linkSync(pending, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new SourceAccessError('E_SOURCE_BUSY', 'source is in use or requires explicit host recovery');
    }
  } finally {
    unlinkSync(pending);
  }
  try {
    // Intent is visible before the overlap scan: a racing ancestor/descendant
    // either sees this owner or was already visible to this scan.
    for (const entry of readdirSync(control)) {
      if (entry === filename || entry.startsWith('.pending-')) continue;
      let heldRoot: unknown;
      try {
        const held = join(control, entry);
        const fd = openSync(held, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = fstatSync(fd);
          if (!info.isFile() || info.size > 4096) throw new Error('invalid ownership');
          heldRoot = JSON.parse(readFileSync(fd, 'utf8')).codeRoot;
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        // A holder that completed release during this scan no longer conflicts.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          try {
            lstatSync(join(control, entry));
          } catch (missing) {
            if ((missing as NodeJS.ErrnoException).code === 'ENOENT') continue;
          }
        }
        throw new SourceAccessError('E_SOURCE_BUSY', 'unreadable source ownership requires explicit host recovery');
      }
      if (
        typeof heldRoot !== 'string' ||
        !isAbsolute(heldRoot) ||
        isInside(heldRoot, root) ||
        isInside(root, heldRoot)
      ) {
        throw new SourceAccessError('E_SOURCE_BUSY', 'source is in use or requires explicit host recovery');
      }
    }
    assertDirectories(directories);
    const currentSource = lstatSync(root);
    if (!sameIdentity(currentSource, source) || realpathSync(root) !== root) {
      throw new SourceAccessError('E_SOURCE_CONTROL', 'admitted source root identity changed during acquisition');
    }
  } catch (error) {
    // No operation has started, so this acquisition may remove only its own
    // intent. Failed removal intentionally leaves recovery-required ownership.
    try {
      unlinkSync(file);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'source acquisition cleanup failed');
    }
    throw error;
  }
  const fileInfo = lstatSync(file);
  let released = false;
  return () => {
    if (released) return;
    privateDirectory(control);
    const currentControl = lstatSync(control);
    if (
      currentControl.dev !== controlInfo.dev ||
      currentControl.ino !== controlInfo.ino ||
      realpathSync(control) !== control
    ) {
      throw new SourceAccessError(
        'E_SOURCE_CONTROL',
        'source ownership directory identity changed; retained for recovery',
      );
    }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = fstatSync(fd);
      if (
        !current.isFile() ||
        current.dev !== fileInfo.dev ||
        current.ino !== fileInfo.ino ||
        current.size > 4096 ||
        JSON.parse(readFileSync(fd, 'utf8')).token !== token
      ) {
        throw new SourceAccessError('E_SOURCE_CONTROL', 'source ownership changed; retained for recovery');
      }
    } finally {
      closeSync(fd);
    }
    unlinkSync(file);
    released = true;
  };
}

const activeCaptures = new Map<string, { control: string; root: string }>();

/** Only synchronous trusted capture can nest. Sandbox owners never inherit this access. */
export function withSourceAccess<T>(
  codeRoot: string,
  operation: (canonicalRoot: string) => T,
  options: SourceAccessOptions = {},
): T {
  const root = sourceAuthority(codeRoot);
  const control = sourceControlDirectory(options);
  const key = `${control}\0${root}`;
  for (const active of activeCaptures.values()) {
    if (active.control === control && isInside(active.root, root)) {
      if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) {
        throw new SourceAccessError('E_SOURCE_CONTROL', 'admitted capture root changed');
      }
      return operation(root);
    }
  }
  const release = acquireSourceAccess(root, { ...options, kind: 'capture' });
  activeCaptures.set(key, { control, root });
  try {
    if (!lstatSync(root).isDirectory() || realpathSync(root) !== root)
      throw new SourceAccessError('E_SOURCE_CONTROL', 'admitted capture root changed');
    const result = operation(root);
    if (result !== null && typeof result === 'object' && 'then' in result) {
      throw new TypeError('source capture operation must be synchronous');
    }
    return result;
  } finally {
    activeCaptures.delete(key);
    release();
  }
}
