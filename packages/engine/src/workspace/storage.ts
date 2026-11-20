import {
  constants,
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class WorkspaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

export function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

export function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function assertPrivate(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (!directory && stat.nlink !== 1)
  ) {
    if (directory && stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()) {
      const quoted = `'${path.replaceAll("'", "'\\''")}'`;
      throw new WorkspaceError('UNSAFE_PATH', `The folder is not private. Run \`chmod 700 ${quoted}\` and try again.`);
    }
    throw new WorkspaceError('UNSAFE_PATH', `Expected an owned private ${directory ? 'directory' : 'file'}: ${path}`);
  }
}

/** The caller supplies a canonical trusted parent, never a model-controlled path. */
export function privateDirectory(path: string): void {
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  assertPrivate(path, true);
  if (created) syncDirectory(dirname(path));
}

/** Resolve the private-root ancestry without accepting a symlink at any level. */
export function stateRootPath(input: string): string {
  const path = resolve(input);
  let ancestor = path;
  while (true) {
    try {
      if (lstatSync(ancestor).isSymbolicLink())
        throw new WorkspaceError('UNSAFE_PATH', `Private root ancestry cannot contain a symlink: ${ancestor}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  try {
    return realpathSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return join(realpathSync(dirname(path)), path.slice(dirname(path).length + 1));
  }
}

export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readPrivateJson(path: string): unknown {
  assertPrivate(path, false);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) {
      throw new WorkspaceError('UNSAFE_PATH', `Private file changed: ${path}`);
    }
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

export function writePrivateJson(path: string, value: unknown): void {
  assertPrivate(dirname(path), true);
  try {
    assertPrivate(path, false);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = join(dirname(path), `.write-${randomUUID()}`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch (cleanup) {
      if (!isMissing(cleanup)) throw cleanup;
    }
    throw error;
  }
}

export function fileIdentity(path: string): string {
  const stat = statSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}
